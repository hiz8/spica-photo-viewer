//! Detects the sort setting of the Explorer window/tab showing a folder
//! (spec §6.3). Every COM failure collapses to `None` so callers fall back
//! to natural name order (I2). Non-Windows builds are a stub that always
//! yields `None` (I4).

/// Normalizes a filesystem path for comparing an Explorer window's current
/// folder against the target folder (§6.3 step 6): strips the `\\?\` prefix,
/// unifies separators, drops trailing separators, lowercases. Compiled on all
/// platforms so the contract stays unit-tested on CI (ubuntu); only the
/// Windows COM path calls it at runtime.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn normalize_path(p: &str) -> String {
    let p = p.strip_prefix(r"\\?\").unwrap_or(p);
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

#[cfg(windows)]
pub(crate) use imp::map_sort_column;

#[cfg(windows)]
mod imp {
    use crate::commands::file::{SortKey, SortSpec};
    use windows::Win32::UI::Shell::SORTCOLUMN;

    /// PSGUID_STORAGE: the fmtid shared by the standard column PROPERTYKEYs
    /// (spec appendix B).
    const FMTID_STORAGE: windows::core::GUID =
        windows::core::GUID::from_u128(0xB725F130_47EF_101A_A5F1_02608C9EEBAC);

    /// Appendix B mapping. Unmapped keys => None => caller falls back to
    /// natural name order ascending.
    pub(crate) fn map_sort_column(col: &SORTCOLUMN) -> Option<SortSpec> {
        if col.propkey.fmtid != FMTID_STORAGE {
            return None;
        }
        let key = match col.propkey.pid {
            10 => SortKey::Name,     // PKEY_ItemNameDisplay
            12 => SortKey::Size,     // PKEY_Size
            14 => SortKey::Modified, // PKEY_DateModified
            15 => SortKey::Created,  // PKEY_DateCreated
            4 => SortKey::Type,      // PKEY_ItemTypeText (approximated by extension, R4)
            _ => return None,
        };
        Some(SortSpec {
            key,
            descending: col.direction.0 < 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_path_ignores_case_and_trailing_separator() {
        assert_eq!(
            normalize_path(r"C:\Users\X\Pictures\"),
            normalize_path(r"c:\users\x\pictures")
        );
    }

    #[test]
    fn normalize_path_strips_extended_length_prefix() {
        assert_eq!(
            normalize_path(r"\\?\C:\photos"),
            normalize_path(r"C:\photos")
        );
    }

    #[test]
    fn normalize_path_unifies_forward_slashes() {
        assert_eq!(normalize_path("C:/photos/2024"), normalize_path(r"C:\photos\2024"));
    }

    #[test]
    fn normalize_path_keeps_non_ascii() {
        assert_eq!(normalize_path("C:\\写真\\"), "c:\\写真");
    }

    #[test]
    fn normalize_path_distinguishes_different_folders() {
        assert_ne!(normalize_path(r"C:\a\b"), normalize_path(r"C:\a\c"));
    }

    #[cfg(windows)]
    mod windows_tests {
        use super::super::map_sort_column;
        use crate::commands::file::SortKey;
        use windows::Win32::Foundation::PROPERTYKEY;
        use windows::Win32::UI::Shell::{SORTCOLUMN, SORTDIRECTION};

        const STORAGE: windows::core::GUID =
            windows::core::GUID::from_u128(0xB725F130_47EF_101A_A5F1_02608C9EEBAC);

        fn col(fmtid: windows::core::GUID, pid: u32, dir: i32) -> SORTCOLUMN {
            SORTCOLUMN {
                propkey: PROPERTYKEY { fmtid, pid },
                direction: SORTDIRECTION(dir),
            }
        }

        #[test]
        fn maps_all_supported_pids() {
            for (pid, key) in [
                (10, SortKey::Name),
                (12, SortKey::Size),
                (14, SortKey::Modified),
                (15, SortKey::Created),
                (4, SortKey::Type),
            ] {
                let spec = map_sort_column(&col(STORAGE, pid, 1)).unwrap();
                assert_eq!(spec.key, key);
                assert!(!spec.descending);
            }
        }

        #[test]
        fn negative_direction_is_descending() {
            let spec = map_sort_column(&col(STORAGE, 12, -1)).unwrap();
            assert_eq!(spec.key, SortKey::Size);
            assert!(spec.descending);
        }

        #[test]
        fn unmapped_pid_is_none() {
            // e.g. pid 21 = PKEY_Author on the storage fmtid
            assert!(map_sort_column(&col(STORAGE, 21, 1)).is_none());
        }

        #[test]
        fn foreign_fmtid_is_none() {
            // PKEY_Photo_DateTaken {14B81DA1-0135-4D31-96D9-6CBFC9671A99},36867
            let taken = windows::core::GUID::from_u128(0x14B81DA1_0135_4D31_96D9_6CBFC9671A99);
            assert!(map_sort_column(&col(taken, 36867, 1)).is_none());
        }
    }
}
