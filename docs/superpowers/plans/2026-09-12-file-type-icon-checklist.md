# ファイルタイプアイコン 手動検証チェックリスト

Spec: docs/superpowers/specs/2026-09-12-file-type-icon-design.md

対象: NSIS インストーラ版（`bundle.targets` は `["nsis"]` のみ、F9）。
インストールモードは `currentUser` なので管理者権限は不要。

## 事前準備

- [ ] 0a. 既存の MSI 版をアンインストールし、Windows が残した「プログラムから
      開く」の登録を消す。

  `C:\Program Files\Spica Photo Viewer\` に実体があれば旧 MSI 版（NSIS の
  `currentUser` は後述の通り別の場所に入るため、`Program Files` にあるものは
  MSI 版と判定できる）。「設定 > アプリ > インストールされているアプリ」から
  アンインストールするか、`C:\Program Files\Spica Photo Viewer\Uninstall Spica Photo Viewer.lnk`
  を実行する。

  飛ばしても両方が共存することはない。NSIS インストーラは HKLM の Uninstall
  エントリから `DisplayName` / `Publisher` が一致し `UninstallString` が
  `msiexec` の MSI 版を見つけると、先にその MSI のアンインストールを実行し、
  成功しない限りインストールへ進まない。それでも手で先に消すのは、MSI の
  アンインストールと NSIS のインストールを別々に確認できることと、次の
  `reg delete` を「MSI 版が消えた後・NSIS 版を入れる前」に実行する必要が
  あるため（NSIS 版を入れた後に消すと、フックが書いた `DefaultIcon` も消える）。

  MSI 版を消したら、次を実行する。

  ```
  reg delete "HKCU\Software\Classes\Applications\spica-photo-viewer.exe" /f
  ```

  このキーは MSI 版を「プログラムから開く」で選んだときに Windows が作ったもので、
  `shell\open\command` が MSI 版の exe
  （`"C:\Program Files\Spica Photo Viewer\spica-photo-viewer.exe" "%1"`）を
  指したまま残っている。MSI のアンインストールでは消えず、NSIS 版のインストールは
  ここに `DefaultIcon` だけを書き足すので、放置すると「アイコンは新しいのに、
  開くと消えた exe を呼ぶ」混成状態になり、項目 6〜7 の判定を誤らせる。

- [ ] 0b. インストーラをビルドする。

  ```
  npm run tauri build
  ```

  成果物は次のパスにできる（バージョンは `package.json` の値に追従するので
  変わっていたらファイル名も変わる）。

  ```
  src-tauri\target\release\bundle\nsis\Spica Photo Viewer_1.0.0_x64-setup.exe
  ```

  **注意**: `tauri build` は e2e が起動する release の exe
  （`src-tauri\target\release\spica-photo-viewer.exe`）を上書きする。この後に
  e2e（`npm run test:e2e`）や bench を走らせる場合は、先に
  `npm run bench:build` で作り直すこと。そのままだと WebDriver が起動しない。

- [ ] 0c. インストーラを実行する。

  実行する前に、項目 8・9 で比べるため、5 拡張子それぞれについて次の出力を
  控えておく（`.png` を `.jpg` / `.jpeg` / `.webp` / `.gif` に替えて実行）。

  ```
  reg query "HKCU\Software\Classes\.png"
  reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.png\UserChoice" /v ProgId
  ```

  0b の exe をダブルクリックするか、管理者昇格せずにそのまま実行する
  （`currentUser` モードなので昇格ダイアログは出ない）。インストール先は
  **`%LOCALAPPDATA%\Spica Photo Viewer\`**（生成される
  `src-tauri\target\release\nsis\x64\installer.nsi` の
  `StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"` で確認済み）。
  `%LOCALAPPDATA%\Programs\Spica Photo Viewer\` **ではない** — `Programs` は
  付かない。

## 検証項目

- [ ] 1. `scripts/verify-file-type-icon.ps1` がレジストリ込みで OK を返す。

  リポジトリのルートで実行する（スクリプトのパスが相対パスのため）。

  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\verify-file-type-icon.ps1 `
    -ExePath "$env:LOCALAPPDATA\Spica Photo Viewer\spica-photo-viewer.exe" `
    -CheckRegistry
  ```

  **合格の見え方**: 標準出力の最終行が
  `OK: 32512 (アプリ) と 32513 (ファイルタイプ) の 2 グループを確認`。
  `-InstallDir` は省略可（`-ExePath` の親ディレクトリを既定値として使う。
  今回はインストール先と一致するのでこれで足りる）。1 行でも `NG:` が出たら
  exit code が 1 になり不合格。チェック内容は exe 内のアイコングループ数
  （2 個であること）、リソース ID 32512 と 32513 の両方が読めること、および
  `SpicaPhotoViewer.jpeg` / `.png` / `.webp` / `.gif` の `DefaultIcon` と
  `Applications\spica-photo-viewer.exe\DefaultIcon` の計 5 箇所が
  `"$INSTDIR\spica-photo-viewer.exe",-32513` になっていること。

- [ ] 2. タスクバー / スタートメニュー / デスクトップのショートカットが
      **従来のアイコンのまま**であること。

  **合格の見え方**: 水色の菱形の上に白い円（レンズ）とその中に黒い円（絞り）
  が乗った、これまでと同じロゴ（`public/icon.svg` のデザイン、リソース ID
  32512）。ファイルタイプアイコンには変わらない。

- [ ] 2a. 本アプリを 5 拡張子の既定のアプリにする。

  **注意**: この操作は実際にこの PC の画像ファイルの既定アプリを変更する
  （作成時点の実機では jpg / jpeg / png / webp が Picasa Photo Viewer、gif が
  フォト（Microsoft Photos））。インストールしただけでは既定は変わらない（Windows 10/11 では
  `UserChoice` が優先される、設計 §8）ので、このままだと項目 3〜4 で Picasa
  などのアイコンが出続け、コードが正しくても不合格に見える。元に戻す手順は項目 9。

  各拡張子のファイルを 1 つずつ右クリック >「プログラムから開く > 別のアプリを
  選択」（Windows のバージョンで表記が少し違う）で、一覧の
  **Spica Photo Viewer** を選び、常にこのアプリで開くように確定する。jpg / jpeg /
  png / webp / gif の 5 つそれぞれで行う。ここでは一覧の下の「PC でアプリを探す」
  は使わない（それは項目 6 で確かめる別経路）。

  確認コマンド（5 拡張子分）:

  ```
  reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.png\UserChoice" /v ProgId
  ```

  **合格の見え方**: `ProgId    REG_SZ    SpicaPhotoViewer.png`。拡張子ごとの期待値:

  | 拡張子 | `ProgId` |
  |---|---|
  | `.jpg` | `SpicaPhotoViewer.jpeg` |
  | `.jpeg` | `SpicaPhotoViewer.jpeg` |
  | `.png` | `SpicaPhotoViewer.png` |
  | `.webp` | `SpicaPhotoViewer.webp` |
  | `.gif` | `SpicaPhotoViewer.gif` |

  `.jpg` と `.jpeg` はどちらも `SpicaPhotoViewer.jpeg`（ProgID を共有するため）。
  `Applications\spica-photo-viewer.exe` になっていたら一覧で別の項目を選んで
  いるので、0a の `reg delete` を済ませたか確認してやり直す。

- [ ] 3. png / jpg / webp / gif を**詳細**表示にすると新しいアイコンになる。

  **合格の見え方**: 白い書類（右上角が折れた紙の形、紺の太い枠線）の中に、
  水色グラデーションの空、白い太陽（円）、紺の三角形の山を描いたミニ風景
  ──`src-tauri/icons/file-type.svg` のデザイン。項目 2 の菱形ロゴとは
  はっきり別物に見えるはず。対象は 5 拡張子（jpg と jpeg は同じ
  `SpicaPhotoViewer.jpeg` ProgID を共有）。

- [ ] 4. **一覧**表示と**小アイコン**表示でも新しいアイコンになる。

  **合格の見え方**: 項目 3 と同じ絵柄が小さく表示される。詳細・一覧・小
  アイコンの 3 つは `DefaultIcon` が直接効く表示モード（設計 §1.2）。

- [ ] 5. **中アイコン以上ではサムネイルが出続ける**（退行していない）。

  表示を「中アイコン」「大アイコン」「特大アイコン」に切り替える。

  **合格の見え方**: 項目 3 の書類アイコンではなく、各画像ファイルの**実際の
  内容を縮小したサムネイル**が出る。これは `DefaultIcon` とは無関係な OS の
  サムネイルプロバイダ経由（`HKCR\SystemFileAssociations\image\ShellEx\...`）
  なので、ここでファイルタイプアイコンが出てしまったら退行。

- [ ] 6. exe を直接選んで既定にした場合（`Applications` 経路）もアイコンが
      新しいもののままである。

  png ファイルを 1 つ右クリック >「プログラムから開く > 別のアプリを選択」で、
  一覧の Spica Photo Viewer **ではなく**、一覧の下の「PC でアプリを探す」
  （Windows のバージョンにより表記が違う）を選び、ファイル選択ダイアログで
  `%LOCALAPPDATA%\Spica Photo Viewer\spica-photo-viewer.exe` を指定して既定に
  する。一覧に履歴として残っている項目は選ばない。exe を直接指定すると、Windows が
  `Applications\spica-photo-viewer.exe\shell\open\command` をこの exe のパスで
  書き直す。

  確認コマンド:

  ```
  reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.png\UserChoice" /v ProgId
  reg query "HKCU\Software\Classes\Applications\spica-photo-viewer.exe\shell\open\command" /ve
  ```

  **合格の見え方**: 1 つ目が `Applications\spica-photo-viewer.exe`、2 つ目が
  `%LOCALAPPDATA%` 配下の exe（`...\AppData\Local\Spica Photo Viewer\spica-photo-viewer.exe`）
  を指す。png のファイルアイコンは項目 3 の書類アイコンのまま（`UserChoice` は
  `Applications\spica-photo-viewer.exe` を指すが、そちらにも `DefaultIcon` を
  書いてあるため）。1 つ目が `SpicaPhotoViewer.png` のままなら Windows が既存の
  ProgID を再利用したということなので、この経路は検証できなかったと記録する
  （コードの不合格ではない）。

- [ ] 7. 画像ファイルをダブルクリックするとその画像が開く（argv 経路の
      退行確認）。

  png（項目 6 の `Applications` 経路）と jpg（項目 2a の ProgID 経路）の
  両方で確かめる。

  **合格の見え方**: アプリのウインドウが開き、ダブルクリックした画像が
  表示される（`commands/file.rs` の `startup_file_in` 経路）。

- [ ] 8. アンインストール後、`Software\Classes\SpicaPhotoViewer.*` と
      `Applications\spica-photo-viewer.exe\DefaultIcon` が消え、各拡張子キーの
      `SpicaPhotoViewer.*_backup` 値が消え、既定値がインストール前の状態に戻る。

  アンインストールは「設定 > アプリ」から行うか、
  `%LOCALAPPDATA%\Spica Photo Viewer\uninstall.exe` を実行する。

  確認コマンド（`.png` 以外の 4 拡張子も同様に見る）:

  ```
  reg query "HKCU\Software\Classes\SpicaPhotoViewer.png"
  reg query "HKCU\Software\Classes\Applications\spica-photo-viewer.exe\DefaultIcon"
  reg query "HKCU\Software\Classes\.png"
  ```

  **合格の見え方**: 前 2 つは
  `ERROR: The system was unable to find the specified registry key or value.`
  （日本語表示の環境では「見つかりません」旨のエラー）で終わる。3 つ目は
  0c で控えた出力と一致する。控えが無い場合の目安:
  このチェックリスト作成時点の実機では、5 拡張子とも HKCU 側の既定値は無く
  `OpenWithProgids` サブキーだけだった。その場合は出力が
  `HKEY_CURRENT_USER\Software\Classes\.png\OpenWithProgids` の 1 行だけになり、
  `(Default)` 行も `SpicaPhotoViewer.png_backup` 行も出ない（設計 F13）。
  `.jpg` と `.jpeg` で消えているべき値名はどちらも
  `SpicaPhotoViewer.jpeg_backup`（ProgID を共有するため）。

- [ ] 9. 既定のアプリを元に戻す（項目 2a と 6 で変えたもの）。

  jpg / jpeg / png / webp は Picasa Photo Viewer に、gif はフォト（Microsoft
  Photos）に戻す。各拡張子のファイルを右クリック >「プログラムから開く >
  別のアプリを選択」で **Picasa Photo Viewer**（gif は **フォト**）を選び、常に
  このアプリで開くように確定する（「設定 > アプリ > 既定のアプリ」でファイルの
  種類ごとに選んでもよい）。

  確認コマンド（5 拡張子分）:

  ```
  reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.png\UserChoice" /v ProgId
  ```

  **合格の見え方**: 0c で控えた値と一致する。作成時点の実機では jpg / jpeg /
  png / webp が `Google.PhotoViewer.3.0`、gif が
  `AppX43hnxtbyyps62jhe9sqpdzxn1790zetc`（Microsoft Photos）だった。

  項目 6 で Windows が作り直した `Applications\spica-photo-viewer.exe` は
  アンインストール後も `shell\open\command` ごと残り、消えた exe を指す（Windows
  が管理する領域なのでアンインストーラは触らない、設計 §8）。不要なら 0a と同じ
  コマンドで消す。

  ```
  reg delete "HKCU\Software\Classes\Applications\spica-photo-viewer.exe" /f
  ```

## トラブルシューティング

アイコンが古いまま見える場合は Explorer のアイコンキャッシュを疑う。

```
ie4uinit.exe -show
```

それでも変わらない場合はエクスプローラーを再起動する
（タスクマネージャーで `explorer.exe` を再起動）。
