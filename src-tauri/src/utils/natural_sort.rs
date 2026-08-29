//! Spec: docs/superpowers/specs/2026-08-28-explorer-folder-sort-order-design.md

use std::cmp::Ordering;

/// Compares filenames in the same order as Explorer's "Name" column.
#[cfg(windows)]
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::StrCmpLogicalW;

    let aw: Vec<u16> = a.encode_utf16().chain(std::iter::once(0)).collect();
    let bw: Vec<u16> = b.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: both buffers are NUL-terminated and live across the call.
    let r = unsafe { StrCmpLogicalW(PCWSTR(aw.as_ptr()), PCWSTR(bw.as_ptr())) };
    r.cmp(&0)
}

/// Compares filenames in the same order as Explorer's "Name" column.
/// Non-Windows builds use the pure-Rust approximation (§6.1).
#[cfg(not(windows))]
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    natural_cmp_fallback(a, b)
}

/// Non-Windows natural-order comparator. Exists so CI (ubuntu-latest) can
/// compile and run tests; it does NOT guarantee Explorer-identical order
/// (§6.1). Digit runs compare numerically, everything else
/// case-insensitively; equal strings fall back to a case-sensitive compare
/// so the result is deterministic.
///
/// Known divergence from StrCmpLogicalW: punctuation vs digit. Word sort
/// puts punctuation before digits ("IMG_1" < "img2" on Windows), while this
/// comparator orders by code point ('_' > '2'). Cross-platform test data
/// must not hinge on such pairs.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn natural_cmp_fallback(a: &str, b: &str) -> Ordering {
    let av: Vec<char> = a.chars().collect();
    let bv: Vec<char> = b.chars().collect();
    let (mut i, mut j) = (0usize, 0usize);
    while i < av.len() && j < bv.len() {
        if av[i].is_ascii_digit() && bv[j].is_ascii_digit() {
            let si = i;
            while i < av.len() && av[i].is_ascii_digit() {
                i += 1;
            }
            let sj = j;
            while j < bv.len() && bv[j].is_ascii_digit() {
                j += 1;
            }
            let da: String = av[si..i].iter().collect();
            let db: String = bv[sj..j].iter().collect();
            // Compare numerically without parsing (digit runs can exceed u64):
            // strip leading zeros, then longer run is larger, then lexicographic.
            let ta = da.trim_start_matches('0');
            let tb = db.trim_start_matches('0');
            let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
            if ord != Ordering::Equal {
                return ord;
            }
        } else {
            let ord = av[i].to_lowercase().cmp(bv[j].to_lowercase());
            if ord != Ordering::Equal {
                return ord;
            }
            i += 1;
            j += 1;
        }
    }
    (av.len() - i)
        .cmp(&(bv.len() - j))
        .then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shared contract: must hold for BOTH the fallback and (from Task 2)
    // the platform comparator. §7.1.
    fn assert_natural_contract(cmp: fn(&str, &str) -> Ordering) {
        // digit runs compare as numbers
        assert_eq!(cmp("img2.jpg", "img10.jpg"), Ordering::Less);
        assert_eq!(cmp("img10.jpg", "img2.jpg"), Ordering::Greater);
        // zero padding compares by numeric value
        assert_eq!(cmp("01.jpg", "2.jpg"), Ordering::Less);
        // case-insensitive: the digits decide, not the case
        assert_eq!(cmp("IMG_1.jpg", "img_2.jpg"), Ordering::Less);
        // case difference with no punctuation stays digit-decided
        // (pairs used by sort_images tests in commands/file.rs)
        assert_eq!(cmp("img2.jpg", "IMG3.jpg"), Ordering::Less);
        assert_eq!(cmp("IMG3.jpg", "img10.jpg"), Ordering::Less);
        // digits after non-ASCII text still compare numerically
        assert_eq!(cmp("写真2.jpg", "写真10.jpg"), Ordering::Less);
        assert_eq!(cmp("image.jpg", "image.jpg"), Ordering::Equal);
        // prefix orders before longer string
        assert_eq!(cmp("img.jpg", "img1.jpg"), Ordering::Less);
    }

    #[test]
    fn fallback_meets_natural_contract() {
        assert_natural_contract(natural_cmp_fallback);
    }

    #[test]
    fn fallback_is_deterministic_for_japanese_names() {
        let mut v = vec!["写真10.jpg", "スクショ.png", "写真2.jpg", "img1.jpg"];
        v.sort_by(|a, b| natural_cmp_fallback(a, b));
        let first = v.clone();
        v.sort_by(|a, b| natural_cmp_fallback(a, b));
        assert_eq!(v, first);
    }

    #[test]
    fn fallback_breaks_case_tie_deterministically() {
        // I1: stable navigation / preload window need this tie-break to be deterministic.
        let ab = natural_cmp_fallback("IMG_1.jpg", "img_1.jpg");
        let ba = natural_cmp_fallback("img_1.jpg", "IMG_1.jpg");
        assert_ne!(ab, Ordering::Equal);
        assert_eq!(ab, ba.reverse());
    }

    #[test]
    fn platform_natural_cmp_meets_natural_contract() {
        assert_natural_contract(natural_cmp);
    }
}
