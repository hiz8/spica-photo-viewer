# 01. 環境構築

## この章で学ぶこと

- Spica Photo Viewer をローカルで動かすために必要なソフトウェアのインストール
- リポジトリのクローンから `npm run tauri dev` までの初回手順
- 初回起動でつまずきやすいポイントの対処法

所要時間: 60〜90 分 (Rust のビルド時間を含む)

---

## 前提

このドキュメントは **Windows 10 / 11** を前提にしています。Spica Photo Viewer の主要ターゲットは Windows で、MSI インストーラ・ファイル関連付け・「プログラムから開く」ダイアログなど Windows 固有の機能を扱うためです。

macOS / Linux でも開発自体は可能ですが、Windows 限定の機能 (`commands/file.rs:251` の `open_with_dialog` など) はそのままでは動作しません。

---

## ステップ 1: Node.js のインストール

`package.json` の `engines` フィールドを確認します。

```json
"engines": {
  "node": ">=20.19.0 <21 || >=22.12.0"
}
```

つまり **Node.js 20.19 以上 (20.x 系) または 22.12 以上** が必要です。22 系の LTS を推奨します。

- 公式インストーラ: https://nodejs.org/
- バージョン管理ツール (推奨): [Volta](https://volta.sh/) や [fnm](https://github.com/Schniz/fnm)

インストール後、以下で確認します。

```bash
node --version   # v22.x.x
npm --version    # 10.x.x など
```

---

## ステップ 2: Rust ツールチェーンのインストール

Rust 公式の `rustup` でインストールするのが一番確実です。

- Windows: https://www.rust-lang.org/tools/install から `rustup-init.exe` をダウンロードして実行
- 標準オプション (default toolchain: `stable`、profile: `default`) のままでよい

インストール後、シェルを開き直してから確認します。

```bash
rustc --version   # rustc 1.x.x
cargo --version   # cargo 1.x.x
```

`src-tauri/Cargo.toml:6` のとおり、本プロジェクトは **Rust edition 2021** で書かれています。`stable` チャネルなら問題なくビルドできます。

---

## ステップ 3: Tauri v2 の prerequisites

Tauri は OS ごとに追加の依存があります。Windows では以下の 2 つが必要です。

### 3-1. Microsoft Edge WebView2

Tauri アプリは Windows 上で WebView2 を使って画面を描画します。

- Windows 11 では **標準で同梱**
- Windows 10 では未インストールの場合があります → https://developer.microsoft.com/microsoft-edge/webview2/ から「Evergreen Bootstrapper」をインストール

### 3-2. Visual Studio Build Tools (C++ ビルド環境)

Rust が一部のクレートをコンパイルする際に MSVC リンカと Windows SDK を要求します。

- https://visualstudio.microsoft.com/ja/visual-cpp-build-tools/ から **Build Tools for Visual Studio** をインストール
- インストーラで以下を選択:
  - 「**C++ によるデスクトップ開発**」ワークロード
  - 「**Windows 10/11 SDK**」 (バージョンは最新でよい)

### 3-3. (本番ビルド時のみ) WiX Toolset v3

MSI インストーラを生成するために使用します。**普段の `npm run tauri dev` には不要** で、`npm run tauri build` を実行する場合のみ必要です。

- https://wixtoolset.org/ から WiX v3 をインストール

> Tauri 公式の最新ガイド: https://tauri.app/start/prerequisites/

---

## ステップ 4: リポジトリのクローン

```bash
git clone https://github.com/hiz8/spica-photo-viewer.git
cd spica-photo-viewer
```

> 自分のフォークから始める場合は、フォーク後に上記 URL を自分の URL に置き換えてください。

---

## ステップ 5: 依存関係のインストール

```bash
npm install
```

これで以下が自動的に行われます。

- `package.json` で宣言された Node のパッケージ (React, Tauri JS API, Vite, vitest, Biome 等) が `node_modules/` にインストールされる
- `src-tauri/Cargo.toml` で宣言された Rust 依存はこの段階ではまだ取得されません。次の `tauri dev` で初めてダウンロード・コンパイルされます

---

## ステップ 6: 初回起動

```bash
npm run tauri dev
```

`src-tauri/tauri.conf.json` の `build` セクションが示す通り、このコマンドは内部で次のことを行います。

1. `build.beforeDevCommand` (`npm run dev`) が走り、Vite が `build.devUrl` (`http://localhost:1420`) でフロントエンドの開発サーバを起動
2. Tauri CLI が `src-tauri/Cargo.toml` の依存をダウンロード・コンパイル (**初回は 5〜10 分かかります**)
3. ビルド完了後、Tauri の WebView ウィンドウが開き、Vite の開発サーバを表示

成功すると、空の Spica Photo Viewer のウィンドウが立ち上がります。

> 2 回目以降は Rust の差分コンパイルが効くため、起動は数秒〜十数秒に短縮されます。

---

## ステップ 7: 動作確認 (ハンズオン)

ウィンドウが開いたら、以下を試してみてください。

1. ウィンドウ中央の "Open Image" ボタンを押す → ファイル選択ダイアログが開く (`src/components/FileOpenButton.tsx`、`src/store/index.ts:775` の `openFileDialog`)
2. JPG / PNG / WebP / GIF いずれかを選択 → 画像が表示される
3. **←/→ キー** で前後の画像へ移動
4. **マウスホイール** で画像を拡大・縮小
5. **F11** でフルスクリーン切り替え
6. **Ctrl+O** でファイル選択ダイアログを再度開く
7. **F1** で About ダイアログを表示

ここまで動けば、開発環境は完成です。

---

## よくあるトラブル

### `error: linker 'link.exe' not found`

→ Visual Studio Build Tools の C++ ワークロードが入っていません。ステップ 3-2 を再確認してください。

### `failed to find Microsoft Edge WebView2`

→ ステップ 3-1 の WebView2 が未インストールです。

### Rust のコンパイルがとても遅い

- 初回は 5〜10 分かかります。これは `tauri`、`image`、`windows` などの大きいクレートを初めてビルドするためで、正常です
- 2 回目以降は `target/` ディレクトリにキャッシュされるため大幅に短縮されます
- アンチウイルスソフトが `target/` を毎回スキャンしていると遅くなります。可能なら除外設定を入れてください

### 開発サーバのポート 1420 が使えない

→ 別アプリが 1420 番を使っています。`vite.config.ts:16-19` の `strictPort: true` 設定により、ポート競合時はエラーで止まる仕様です。競合プロセスを終了するか、`vite.config.ts` のポートを変更し、合わせて `tauri.conf.json:8` の `devUrl` も変更してください。

### `npm run tauri dev` がリンクエラーを出す (Windows)

`target/` を削除してリビルドすると治ることがあります。

```bash
rm -rf src-tauri/target
npm run tauri dev
```

### macOS / Linux でビルドエラー

`commands/file.rs` 内の Windows 専用コードは `#[cfg(target_os = "windows")]` で隔離されているのでビルドはできますが、`open_with_dialog` を呼ぶと `Err("Open With dialog is only supported on Windows")` を返します (`commands/file.rs:275-278`)。

---

## 環境変数とエディタ設定 (任意)

### Rust Analyzer

VS Code を使う場合は `rust-analyzer` 拡張をインストールしておくと、`src-tauri/` 配下の開発体験が大きく向上します。

### Biome 拡張

フロントエンドのフォーマットは Biome を使っています (`biome.json`)。VS Code なら Biome 公式拡張を入れると、保存時の自動整形に対応できます。とはいえ本リポジトリでは保存時整形は Claude Code の hook (`.claude/hooks/format.mjs`) でも実行されるため、必須ではありません。

---

## 次のステップ

環境構築が完了し、アプリが起動できたら → [02-architecture.md](./02-architecture.md) で全体像をつかみます。
