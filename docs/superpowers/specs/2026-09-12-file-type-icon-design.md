# Windows のファイル関連付けアイコンをアプリアイコンから分離する設計

- 日付: 2026-09-12
- 状態: 設計承認済み・実装未着手
- 関連: `PROJECT_SPEC.md` の Windows Installer 節（§7 で更新する）

## 0. 苦情

本アプリを png / jpeg などの既定のアプリに設定すると、エクスプローラー上で個々の画像ファイルのアイコンにもアプリ本体のアイコン（`src-tauri/icons/icon.ico`）が使われる。Windows メニューやデスクトップのアイコンは現在の画像のままにしたうえで、ファイル側だけ「画像ファイルらしい」別のアイコンにしたい。

## 1. Windows 側の仕組み（調査結果）

参照先が 2 系統に分かれている。

| 表示場所 | 参照元 |
|---|---|
| スタートメニュー / デスクトップ / タスクバー | exe の「既定アイコン」= 埋め込みアイコングループのうち**リソース ID が最小のもの** |
| エクスプローラーのファイルアイコン | ProgID の `DefaultIcon` レジストリ値 |

Tauri の NSIS テンプレートが作るショートカットはアイコン引数を渡さない（`CreateShortcut "...lnk" "$INSTDIR\${MAINBINARYNAME}.exe"`）ため、`DefaultIcon` を変えてもメニュー・デスクトップ側は影響を受けない。分離は成立する。

`DefaultIcon` の値は次のいずれの形式も取れる。

- `"C:\path\to\file.ico"` — 独立した .ico ファイル
- `"C:\path\to\app.exe",1` — アイコングループを ID 昇順に並べた 0 始まりの序数
- `"C:\path\to\app.exe",-32513` — 負値はリソース ID の直接指定

### 1.1 実在の先例（調査時の実機で確認）

| アプリ | レジストリ | 値 |
|---|---|---|
| Picasa Photo Viewer | `HKCR\Google.PhotoViewer.3.0\DefaultIcon` | `"...\PicasaPhotoViewer.exe",-102` |
| Firefox | `HKCR\Applications\firefox.exe\DefaultIcon` | `C:\Program Files\Mozilla Firefox\firefox.exe,1` |
| VS Code | `HKCR\Applications\Code.exe\DefaultIcon` | `...\resources\win32\default.ico` |
| Windows Media Player | `HKCR\Applications\wmplayer.exe\DefaultIcon` | `C:\WINDOWS\system32\wmploc.dll,-730` |

`ExtractIconExW(path, -1, ...)` で数えると PicasaPhotoViewer.exe は 2 個、firefox.exe は 15 個のアイコングループを内蔵している。本アプリの exe は 1 個しかない。これが「ファイルアイコン＝アプリアイコン」になっている直接の原因。

### 1.2 アイコンが実際に見える範囲

`.png` の `PerceivedType` は `image` で、OS のサムネイルプロバイダは `HKCR\SystemFileAssociations\image\ShellEx\{e357fccd-a995-4576-b01f-234630154e96}` に登録されている。ProgID に依存しないため、**中アイコン以上の表示では関連付けに関わらずサムネイルが出続ける**。`DefaultIcon` が実際に効くのは詳細・一覧・小アイコン表示と、サムネイル生成不可時のフォールバック。今回の変更の効果範囲はそこに限られる。

### 1.3 「種類」列

Windows 標準 ProgID は既定値に英語の文字列を持ち（`pngfile` = "PNG Image"、`jpegfile` = "JPEG Image"、`giffile` = "GIF Image"）、多言語表示は `FriendlyTypeName` のリソース参照（`@%SystemRoot%\System32\shell32.dll,-30598`）で行っている。`.jpg` と `.jpeg` はどちらも `jpegfile` を指す。

`.webp` はこの環境に ProgID が存在せず、Windows 標準の表記がない。

Picasa は ProgID の既定値も `FriendlyTypeName` も設定していない。そのためエクスプローラーは拡張子から生成したフォールバック "PNG File" を表示する。Tauri も `description` 省略時に `"{EXT} File"` を生成する（`tauri-bundler/src/bundle/windows/nsis/mod.rs` の `association_description`）ので、偶然だが同じ文字列になる。

## 2. Tauri 側の制約と upstream の状況

- `FileAssociation` 構造体に icon フィールドは無い。`deny_unknown_fields` が付いているため独自キーの追加も不可（`tauri-utils/src/config.rs`）
- NSIS テンプレートは `APP_ASSOCIATE` に渡す ICON 引数を `"$INSTDIR\${MAINBINARYNAME}.exe,0"` とハードコードしている（`tauri-bundler/src/bundle/windows/nsis/installer.nsi`）
- MSI(WiX) テンプレートは `<ProgId Advertise="yes">` でアイコンを指定しない（`msi/main.wxs`）

upstream の要望は tauri-apps/tauri#13302 の 1 件のみで、**macOS の `CFBundleTypeIconFile` 限定**。対応 PR #13345 も macOS のみを変更し、2025-04-30 にメンテナが設計の再検討を求めてから停滞している。どちらもマイルストーン未設定。Windows 側の `DefaultIcon` に関する要望は存在しない。dev ブランチの `FileAssociation` にも今なお icon フィールドは無い。公開ロードマップも無い。

つまり `fileAssociations` に icon を書くだけで済む日は当面来ない。一方、次の 2 つは `tauri.conf.json` と `tauri-build` の**正式な公開 API** であり、テンプレート差し替えや rcedit のような手段とは性質が異なる。今回はこの範囲で実現する。

- `WindowsAttributes::append_rc_content()` — 生成される .rc に任意の内容を追記する（2.5.6 には無く 2.6.3 にはある。本リポジトリの Cargo.lock は `tauri-build 2.6.3` / `tauri-winres 0.3.6` で、どちらも API を持つ）
- `bundle.windows.nsis.installerHooks` — `NSIS_HOOK_POSTINSTALL` など 4 つのフックを `.nsh` で差し込む

`tauri-winres` の `set_icon_with_id` は doc の例で複数アイコン埋め込みをそのまま示しており（`res.set_icon("icon.ico").set_icon_with_id("icon2.icon", "2")`）、`append_rc_content` の内容は生成 .rc の末尾に出力される。`tauri-build` は本体アイコンを `set_icon_with_id(icon.ico, "32512")` で埋め込む。

## 3. 決定事項

| # | 項目 | 決定 |
|---|---|---|
| 1 | 登録経路 | ProgID と `Applications\<exe>` の両方に書く |
| 2 | インストーラ | NSIS のみを対象とし、MSI は切る |
| 3 | アイコン数 | 5 拡張子で共通 1 種 |
| 4 | 配置 | exe に 2 個目のアイコングループとして埋め込む |
| 5 | 種類列 | Windows 標準と同じ文字列に揃える |
| 6 | 非目標 | Windows 設定の「既定のアプリ」一覧への登録（`RegisteredApplications` / `Capabilities`）は含めない |

## 4. 設計

```
src-tauri/icons/file-type.svg        (手書き、1024×1024、commit)
        ↓  npm run build:file-icon   (sharp で 6 サイズ焼き → ICO 組み立て)
src-tauri/icons/file-type.ico        (生成物、commit)
        ↓  build.rs: append_rc_content("32513 ICON ...")
spica-photo-viewer.exe               (32512 = アプリ本体 / 32513 = ファイルタイプ)
        ↓  installer-hooks.nsh: DefaultIcon = "$INSTDIR\...exe",-32513
レジストリ → エクスプローラー
```

### 4.1 アイコン生成パイプライン

`scripts/build-file-icon.mjs` を追加する。`sharp`（既に devDependency、e2e のコーパス生成で使用中）で SVG を 16 / 24 / 32 / 48 / 64 / 256 に焼き、ICO コンテナを自前で組み立てる。ICO は 6 バイトの `ICONDIR` + 16 バイト × N の `ICONDIRENTRY` + 各画像本体を並べただけの形式で、全エントリを PNG 圧縮にすれば既存 `src-tauri/icons/icon.ico` と同じ構成になる（実機で確認済み: 6 エントリすべて 32bpp PNG）。**新規依存は不要**。

絵柄は `public/icon.svg` の菱形＋レンズのモチーフを踏まえつつ、紙／写真のメタファを主役にする。§1.2 の通り主戦場は 16px なので、16px での判別性を最優先する。

### 4.2 exe へのリソース埋め込み

`src-tauri/build.rs` を次の形にする。

```rust
fn main() {
    let ico = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("icons/file-type.ico");
    println!("cargo:rerun-if-changed={}", ico.display());

    tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().append_rc_content(format!(
                r#"32513 ICON "{}""#,
                ico.display().to_string().replace('\\', r"\\")
            )),
        ),
    )
    .expect("failed to run tauri-build");
}
```

- 絶対パスで渡す。生成される .rc は `OUT_DIR` に置かれるため相対パスは解決先が不定になる。`.rc` の文字列リテラルなのでバックスラッシュのエスケープも要る
- `cfg` ガードは不要。`append_rc_content` は非 Windows ターゲットでは `tauri-build` 側で使われない

### 4.3 `tauri.conf.json`

```json
"bundle": {
  "targets": ["nsis"],
  "fileAssociations": [
    { "ext": ["jpg", "jpeg"], "name": "SpicaPhotoViewer.jpeg", "description": "JPEG Image" },
    { "ext": ["png"],         "name": "SpicaPhotoViewer.png",  "description": "PNG Image"  },
    { "ext": ["webp"],        "name": "SpicaPhotoViewer.webp", "description": "WebP Image" },
    { "ext": ["gif"],         "name": "SpicaPhotoViewer.gif",  "description": "GIF Image"  }
  ],
  "windows": { "nsis": { "installerHooks": "installer-hooks.nsh" } }
}
```

拡張子リストは `PROJECT_SPEC.md` の Supported Image Formats と `src-tauri/src/utils/image.rs` の `is_supported_image` に一致させている。

### 4.4 レジストリの分担

Tauri の `APP_ASSOCIATE` マクロが書くもの（フックでは触らない）:

| キー | 値 |
|---|---|
| `Software\Classes\.png` 既定値 | `SpicaPhotoViewer.png`（旧値は `SpicaPhotoViewer.png_backup` に退避） |
| `Software\Classes\SpicaPhotoViewer.png` 既定値 | `PNG Image` |
| `...\shell\open\command` | `$INSTDIR\spica-photo-viewer.exe "%1"` |
| `...\DefaultIcon` | `$INSTDIR\spica-photo-viewer.exe,0` ← フックで上書きする |

`src-tauri/installer-hooks.nsh`（新規）:

```nsh
; (F10) ${MAINBINARYNAME} はこの !include より後で !define されるため、
; トップレベルでは解決できない。マクロ本体は !insertmacro 時に展開される。
!macro SPICA_WRITE_FILE_TYPE_ICON KEY
  WriteRegStr SHCTX "${KEY}\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",-32513'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\SpicaPhotoViewer.jpeg"
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\SpicaPhotoViewer.png"
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\SpicaPhotoViewer.webp"
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\SpicaPhotoViewer.gif"
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon"
  !insertmacro UPDATEFILEASSOC
!macroend
```

`installerHooks` に書くパスは bundler の cwd（`src-tauri/`）基準で canonicalize され、テンプレートには絶対パスとして埋め込まれる。

生成された `installer.nsi` で、関連付け作成は install セクションの途中、`NSIS_HOOK_POSTINSTALL` はその後に挿入される。uninstall セクションも `NSIS_HOOK_PREUNINSTALL` → 関連付け削除 → `NSIS_HOOK_POSTUNINSTALL` の順。いずれも上書き・後片付けとして正しい位置にある。

`Applications\<exe>\DefaultIcon` を別途書くのは、ユーザーが「プログラムから開く > 別のアプリを選択」で既定にした場合、UserChoice が指す ProgID が `Applications\spica-photo-viewer.exe` になり、上表の ProgID 群を通らないため。実機でもこのキーが（`shell\open\command` だけの状態で）存在することを確認している。

## 5. 設計上の判断

- **(F1) リソース ID は 32512 より大きい値にする。** シェルは exe の顔として「アイコングループのうちリソース ID が最小のもの」を採る。32512 未満を選ぶとタスクバーとショートカットのアイコンが入れ替わり、要件そのものを壊す。
- **(F2) `DefaultIcon` は序数ではなく負値（リソース ID）で指定する。** Firefox の `,1` は ID 昇順に並べた位置への依存で、将来リソースが増えると別のアイコンを指す。`-32513` なら ID を直接指すので順序に依存しない。
- **(F3) POSTUNINSTALL で ProgID 側を削除しない。** `APP_UNASSOCIATE` が `DeleteRegKey SHELL_CONTEXT Software\Classes\${FILECLASS}` でキーごと消すため、フックで書いた `DefaultIcon` も巻き添えで消える。重複して消すと Tauri 側の実装変更時に二重管理になる。フックが後始末するのは `Applications\<exe>` 側だけでよい。
- **(F4) `UPDATEFILEASSOC` を自前で呼ぶ。** `SHChangeNotify(SHCNE_ASSOCCHANGED)` を発行するこのマクロは `FileAssociation.nsh` に定義されているのに `installer.nsi` から一度も呼ばれていない。呼ばないとアイコンの反映がシェルの気分次第になる。`!include "FileAssociation.nsh"` は既に済んでいるので `!insertmacro` するだけでよい。
- **(F5) `fileAssociations` の `name` を必ず指定する。** NSIS テンプレートは `{{or association.name ext}}` を ext ごとに評価するため、省略すると ProgID が裸の `png` / `jpg` になりグローバル名前空間を汚す。`name` を与えると 1 つの association 内の全 ext が同じ ProgID を共有するので、`jpg` と `jpeg` を Windows 標準（どちらも `jpegfile`）と同じ扱いにできる。
- **(F6) `SHCTX` を使う。** `installMode` のデフォルトは `currentUser` なので実体は HKCU だが、将来 perMachine に変えても追随する。
- **(F7) 生成物の `.ico` も commit する。** 既存 `icons/icon.ico` と同じ扱いに揃え、sharp の無い環境でもビルドが通るようにする。
- **(F8) `cargo:rerun-if-changed` を自前で出す。** `tauri-build` はアイコンに対してこれを出していない（config とリソースにしか出していない）。書かないと .ico を差し替えてもリビルドされず、古いアイコンが入った exe が出来る。
- **(F9) `targets` を `["nsis"]` に絞る。** MSI にはこのフックが効かず、同じビルドから挙動の違う 2 つの配布物が出るのは事故のもと。GitHub Releases はまだ 1 件も公開しておらず、配布形態を選べる状態にある。
- **(F10) `.nsh` のトップレベルで `${MAINBINARYNAME}` を参照しない。** テンプレートはフックの `!include` を `!define MAINBINARYNAME` より前に置く。トップレベルの `!define` は include 時に評価されるため未定義参照になる。マクロ本体は `!insertmacro` 時に展開されるので、そこで参照すれば解決される。
- **(F11) `tauri-build` の依存要求を `"2.6"` に上げる。** `append_rc_content` は 2.5.6 に存在しない。現在の `Cargo.toml` は `"2.5"`（= `^2.5`）で、たまたま lock が 2.6.3 を指しているだけなので、API への依存を要求として明示する。

## 6. 検証計画

インストーラ経路は自動テストで担保できない。現行 e2e はビルド済み exe を直接起動する構成でインストーラを通らないため。手動チェックリストを用意する。

検証前に、現在 `C:\Program Files\Spica Photo Viewer\` に入っている実体（NSIS の currentUser モードは `%LOCALAPPDATA%\Programs\` に入れるため、MSI 版と思われる）をアンインストールして環境を揃える。

1. ビルド後の exe のアイコングループ数が 2 であること（`ExtractIconExW(path, -1, ...)` で計数）
2. タスクバー / スタートメニュー / デスクトップのショートカットが**従来のアイコンのまま**であること
3. インストール直後にレジストリ 5 箇所が期待値であること
4. png / jpg / webp / gif の**詳細・一覧・小アイコン**表示が新アイコンになること
5. **中アイコン以上でサムネイルが出続ける**こと（§1.2 の退行確認）
6. 「プログラムから開く > 別のアプリを選択」で既定にした場合もアイコンが変わること
7. ファイルのダブルクリックで画像が開くこと（`commands/file.rs` の `startup_file_in(std::env::args().skip(1))` 経路の退行確認）
8. アンインストール後、`Software\Classes\SpicaPhotoViewer.*` と `Applications\<exe>\DefaultIcon` が消え、`.png` の既定値が復元されること

アイコンが古いまま見える場合は Explorer のアイコンキャッシュを疑う（`ie4uinit.exe -show`）。

自動化する範囲:

- ICO 生成スクリプトの単体テスト（`node --test`。既存 `scripts/__tests__/verify-comment-only.test.mjs` と同じ枠組みで、ヘッダ・エントリ数・各エントリのサイズと PNG シグネチャを検証）
- 項目 1 と 3 はスクリプト化し、手動チェックリストから呼べるようにする

## 7. 実装フェーズ

1. **アイコン生成**: `file-type.svg` と `scripts/build-file-icon.mjs`、単体テスト、`package.json` のスクリプト追加、生成した `file-type.ico` の commit
2. **exe への埋め込み**: `Cargo.toml` の `tauri-build` 要求を `"2.6"` に上げ（F11）、`build.rs` を変更し、アイコングループ数の検証スクリプトを足す
3. **関連付けとフック**: `tauri.conf.json` と `installer-hooks.nsh`、レジストリ検証スクリプト
4. **ドキュメント**: `PROJECT_SPEC.md` の Windows Installer 節を NSIS 前提に更新し、手動チェックリストを PR 本文に載せる

## 8. リスク

- **既定アプリの奪取**: `fileAssociations` を入れると `APP_ASSOCIATE` が `Software\Classes\.<ext>` の既定値を書き換える。Windows 10/11 では UserChoice が優先されるため既定アプリ自体は乗っ取られないが、**既定を一度も設定していない環境ではインストールしただけで画像の既定が本アプリになる**。画像ビューアというアプリの性格上むしろ意図と整合的と判断して受け入れる。アンインストール時は `APP_UNASSOCIATE` が `_backup` 値から復元する
- **upstream 実装時の移行**: `fileAssociations` に icon フィールドが入れば、`installer-hooks.nsh` の ProgID 4 行と `build.rs` の `append_rc_content` は設定 1 行に畳める。Tauri 標準の配線に乗せてあるので移行は局所的で済む
- **`Applications\<exe>\DefaultIcon` の残骸**: アンインストール時に消すのはフックが書いた `DefaultIcon` キーのみ。Windows が作った `shell\open\command` は残るが、これは Windows 側が管理する領域なので触らない
