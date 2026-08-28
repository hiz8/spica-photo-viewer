//! Manual-verification probe for spec §7.3 (scripts/explorer-sort-probe).
//!
//! Subcommands:
//!   list                     enumerate Explorer windows/tabs: top-level HWND,
//!                            folder path, raw sort columns, group-by
//!   order <folder>           Explorer's own display order (IFolderView::GetItem)
//!                            of the tab showing <folder> — ground truth
//!   app <folder> [--hwnd N]  the app's real pipeline: detect_sort_spec (spec
//!                            printed to stderr) + get_folder_images order
//!
//! Never calls SetSortColumns (R10).

#[cfg(windows)]
fn main() {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("list") => {
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap() };
            win::list_windows();
            unsafe { CoUninitialize() };
        }
        Some("order") => {
            let folder = args.get(1).expect("usage: explorer_sort_probe order <folder>");
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap() };
            win::dump_display_order(folder);
            unsafe { CoUninitialize() };
        }
        Some("app") => {
            let folder = args.get(1).expect("usage: explorer_sort_probe app <folder> [--hwnd N]");
            let hwnd = args
                .iter()
                .position(|a| a == "--hwnd")
                .and_then(|i| args.get(i + 1))
                .and_then(|v| v.parse::<isize>().ok());
            let spec =
                spica_photo_viewer_lib::probe_api::detect_sort_spec(std::path::Path::new(folder), hwnd);
            eprintln!("detect_sort_spec(hwnd={hwnd:?}) => {spec:?}");
            let images = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(spica_photo_viewer_lib::probe_api::get_folder_images(folder.clone()))
                .expect("get_folder_images failed");
            for img in &images {
                println!("{}", img.filename);
            }
        }
        _ => eprintln!("usage: explorer_sort_probe (list | order <folder> | app <folder> [--hwnd N])"),
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("windows-only probe");
}

#[cfg(windows)]
mod win {
    use spica_photo_viewer_lib::probe_api::normalize_path;
    use windows::core::Interface;
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, IDispatch, CLSCTX_ALL};
    use windows::Win32::System::Variant::{VARIANT, VARIANT_0_0, VARIANT_0_0_0, VT_I4};
    use windows::Win32::UI::Shell::{
        IFolderView2, IPersistFolder2, IShellBrowser, IShellItem, IShellView, IShellWindows,
        IUnknown_QueryService, SHGetPathFromIDListW, ShellWindows, SID_STopLevelBrowser,
        SIGDN_PARENTRELATIVEPARSING, SORTCOLUMN, SVGIO_ALLVIEW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOT};

    fn entries() -> Vec<(IFolderView2, Option<isize>, String)> {
        let mut out = Vec::new();
        let Ok(shell_windows) = (unsafe {
            CoCreateInstance::<_, IShellWindows>(
                &ShellWindows,
                None::<&windows::core::IUnknown>,
                CLSCTX_ALL,
            )
        }) else {
            return out;
        };
        let count = unsafe { shell_windows.Count() }.unwrap_or(0);
        for i in 0..count {
            let mut idx = VARIANT::default();
            idx.Anonymous.Anonymous = std::mem::ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_I4,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 { lVal: i },
            });
            let Ok(disp) = (unsafe { shell_windows.Item(&idx) }) else { continue };
            let disp: IDispatch = disp;
            let Ok(browser) =
                (unsafe { IUnknown_QueryService::<_, IShellBrowser>(&disp, &SID_STopLevelBrowser) })
            else {
                continue;
            };
            let Ok(view) = (unsafe { browser.QueryActiveShellView() }) else { continue };
            let view: IShellView = view;
            let Ok(view2) = view.cast::<IFolderView2>() else { continue };
            let top = unsafe { browser.GetWindow() }
                .ok()
                .map(|h| unsafe { GetAncestor(h, GA_ROOT) }.0 as isize);
            let Some(path) = folder_path(&view2) else { continue };
            out.push((view2, top, path));
        }
        out
    }

    fn folder_path(view: &IFolderView2) -> Option<String> {
        let persist: IPersistFolder2 = unsafe { view.GetFolder::<IPersistFolder2>() }.ok()?;
        let pidl = unsafe { persist.GetCurFolder() }.ok()?;
        if pidl.is_null() {
            return None;
        }
        let mut buf = [0u16; 260];
        let ok = unsafe { SHGetPathFromIDListW(pidl, &mut buf) }.as_bool();
        unsafe { CoTaskMemFree(Some(pidl as *const core::ffi::c_void)) };
        if !ok {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }

    pub fn list_windows() {
        for (view, top, path) in entries() {
            let count = unsafe { view.GetSortColumnCount() }.unwrap_or(-1);
            let mut cols_txt = String::new();
            if count > 0 {
                let mut cols = vec![SORTCOLUMN::default(); count as usize];
                if unsafe { view.GetSortColumns(&mut cols) }.is_ok() {
                    cols_txt = cols
                        .iter()
                        .map(|c| format!("{:?}/{} dir={}", c.propkey.fmtid, c.propkey.pid, c.direction.0))
                        .collect::<Vec<_>>()
                        .join("; ");
                }
            }
            let mut gkey = PROPERTYKEY::default();
            let mut gasc = windows::core::BOOL(0);
            let group = if unsafe { view.GetGroupBy(&mut gkey, Some(&mut gasc)) }.is_ok()
                && gkey.fmtid != windows::core::GUID::default()
            {
                format!("{:?}/{} asc={}", gkey.fmtid, gkey.pid, gasc.as_bool())
            } else {
                "none".to_string()
            };
            println!("hwnd={top:?}\tpath={path}\tsort=[{cols_txt}]\tgroup={group}");
        }
    }

    pub fn dump_display_order(folder: &str) {
        let target = normalize_path(folder);
        for (view, _top, path) in entries() {
            if normalize_path(&path) != target {
                continue;
            }
            let count = unsafe { view.ItemCount(SVGIO_ALLVIEW) }.unwrap_or(0);
            for i in 0..count {
                let Ok(item) = (unsafe { view.GetItem::<IShellItem>(i) }) else { continue };
                if let Ok(name) = unsafe { item.GetDisplayName(SIGDN_PARENTRELATIVEPARSING) } {
                    let s = unsafe { name.to_string() }.unwrap_or_default();
                    unsafe { CoTaskMemFree(Some(name.0 as *const core::ffi::c_void)) };
                    println!("{s}");
                }
            }
            return; // first matching tab only
        }
        eprintln!("no Explorer window shows {folder}");
        std::process::exit(2);
    }
}
