# ファイルタイプアイコン 手動検証チェックリスト

Spec: docs/superpowers/specs/2026-09-12-file-type-icon-design.md

対象: NSIS インストーラ版（`bundle.targets` は `["nsis"]` のみ、F9）。
インストールモードは `currentUser` なので管理者権限は不要。

## 事前準備

- [ ] 0a. 既存の MSI 版をアンインストールする。

  `C:\Program Files\Spica Photo Viewer\` に実体があれば旧 MSI 版（NSIS の
  `currentUser` は後述の通り別の場所に入るため、`Program Files` にあるものは
  MSI 版と判定できる）。「設定 > アプリ > インストールされているアプリ」から
  アンインストールするか、`C:\Program Files\Spica Photo Viewer\Uninstall Spica Photo Viewer.lnk`
  を実行する。これを飛ばすと NSIS 版と MSI 版が両方存在し、ショートカットが
  どちらを指しているか分からなくなる。

- [ ] 0b. インストーラをビルドする。

  ```
  npm run tauri build
  ```

  成果物は次のパスにできる（バージョンは `package.json` の値に追従するので
  変わっていたらファイル名も変わる）。

  ```
  src-tauri\target\release\bundle\nsis\Spica Photo Viewer_1.0.0_x64-setup.exe
  ```

- [ ] 0c. インストーラを実行する。

  上記 exe をダブルクリックするか、管理者昇格せずにそのまま実行する
  （`currentUser` モードなので昇格ダイアログは出ない）。インストール先は
  **`%LOCALAPPDATA%\Spica Photo Viewer\`**（`src-tauri\target\release\nsis\x64\installer.nsi`
  505 行目 `StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"` で確認済み）。
  `%LOCALAPPDATA%\Programs\Spica Photo Viewer\` **ではない** — `Programs` は
  付かない。

## 検証項目

- [ ] 1. `scripts/verify-file-type-icon.ps1` がレジストリ込みで OK を返す。

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

- [ ] 6. 「プログラムから開く > 別のアプリを選択」で本アプリを既定にしても
      アイコンが変わる。

  **注意**: この操作は実際にこの PC の画像ファイルの既定アプリを変更する。
  検証後に元の既定ビューアに戻すかどうかを決めてから実行すること。

  **合格の見え方**: 既定にした直後、対象拡張子のファイルアイコンが項目 3 の
  書類アイコンのままである（`UserChoice` は `Applications\spica-photo-viewer.exe`
  を指すようになるが、そちらにも `DefaultIcon` を書いてあるため見た目は
  変わらない）。

- [ ] 7. 画像ファイルをダブルクリックするとその画像が開く（argv 経路の
      退行確認）。

  **合格の見え方**: アプリのウインドウが開き、ダブルクリックした画像が
  表示される（`commands/file.rs` の `startup_file_in` 経路）。

- [ ] 8. アンインストール後、`Software\Classes\SpicaPhotoViewer.*` と
      `Applications\spica-photo-viewer.exe\DefaultIcon` が消え、`.png` の
      既定値が元に戻る。

  アンインストールは「設定 > アプリ」から行うか、
  `%LOCALAPPDATA%\Spica Photo Viewer\uninstall.exe` を実行する。

  確認コマンド:

  ```
  reg query "HKCU\Software\Classes\SpicaPhotoViewer.png"
  reg query "HKCU\Software\Classes\Applications\spica-photo-viewer.exe\DefaultIcon"
  reg query "HKCU\Software\Classes\.png" /ve
  ```

  **合格の見え方**: 前 2 つは `ERROR: 指定されたレジストリ キーが見つかりません`
  のように「見つからない」旨のエラーで終わる。3 つ目はこのチェックリストの
  作業を始める前に `.png` の既定値だった ProgID に戻っている（本アプリを
  インストールする前にどの ProgID が既定だったかは、可能なら 0c の前に
  同じコマンドで一度記録しておくとよい）。

## トラブルシューティング

アイコンが古いまま見える場合は Explorer のアイコンキャッシュを疑う。

```
ie4uinit.exe -show
```

それでも変わらない場合はエクスプローラーを再起動する
（タスクマネージャーで `explorer.exe` を再起動）。
