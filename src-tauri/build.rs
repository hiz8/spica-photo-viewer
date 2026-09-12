// Spec: docs/superpowers/specs/2026-09-12-file-type-icon-design.md
fn main() {
    let ico = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("icons/file-type.ico");
    // tauri-build はウィンドウアイコンに rerun-if-changed を出さないので自前で出す (F8)
    println!("cargo:rerun-if-changed={}", ico.display());

    // 32513 は tauri-build がアプリ本体に使う 32512 より大きくする必要がある。
    // シェルは最小 ID のグループを exe の顔として採るため (F1)。
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
