// Spec: docs/superpowers/specs/2026-09-12-file-type-icon-design.md
fn main() {
    let ico = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("icons/file-type.ico");
    // (F8) tauri-build はアイコンに rerun-if-changed を出さない
    println!("cargo:rerun-if-changed={}", ico.display());

    // (F1) ID は tauri-build が exe 本体のアイコンに使う 32512 より大きくする。
    // .rc の文字列リテラルなのでバックスラッシュのエスケープが要る。
    let rc = format!(
        r#"32513 ICON "{}""#,
        ico.display().to_string().replace('\\', r"\\")
    );

    tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().append_rc_content(rc),
        ),
    )
    .expect("failed to run tauri-build");
}
