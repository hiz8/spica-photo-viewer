# 02. 全体アーキテクチャ

## この章で学ぶこと

- Tauri アプリのざっくりとしたメンタルモデル (Rust ⇄ WebView)
- Spica Photo Viewer のフロント / バックの責務分担
- ディレクトリツリーの読み方
- 1 枚の画像が表示されるまでのデータフロー

所要時間: 30 分

---

## メンタルモデル: Tauri は Rust と WebView をつなぐ橋

Tauri の動作イメージは以下のとおりです。

```
┌─────────────────────────────────────────────────────────────┐
│                  Tauri アプリ (1 つの実行ファイル)               │
│                                                             │
│  ┌──────────────────────────┐    IPC     ┌────────────────┐ │
│  │       WebView (Edge)     │  ◄──────►  │  Rust ネイティブ │ │
│  │   React / TypeScript     │  invoke /  │   (src-tauri)  │ │
│  │   Zustand / Vite         │  event     │   commands     │ │
│  │                          │            │   plugins      │ │
│  │   src/                   │            │   image / fs   │ │
│  └──────────────────────────┘            └────────────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

ポイント:

- **画面 (UI)** は WebView 上で動く React アプリです。HTML / CSS / JS の世界。
- **OS 機能 (ファイル I/O、画像デコード、ウィンドウ操作)** は Rust 側で実装されています。
- 両者は **IPC (Inter-Process Communication)** で通信します。フロント → Rust は `invoke()`、Rust → フロントは `event` (`listen()`) を使います。

「ブラウザでは絶対できないこと」を Rust 側に書き、「画面に関係すること」を React 側に書くと考えると整理しやすいです。

---

## このプロジェクトの責務分担

### バックエンド (Rust = `src-tauri/`) が受け持つこと

- ファイルシステムの走査 (`commands/file.rs:40` `get_folder_images`)
- 画像のデコード・サムネイル生成・base64 化 (`utils/image.rs`)
- サムネイルのディスクキャッシュ (`commands/cache.rs`)
- ウィンドウのリサイズ・最大化・フルスクリーン (`commands/window.rs`)
- Windows 固有処理: 「プログラムから開く」ダイアログ (`commands/file.rs:251` `open_with_dialog`)
- 起動引数からの画像パス取得 (`commands/file.rs:125` `get_startup_file`)

### フロントエンド (React = `src/`) が受け持つこと

- 画面のレンダリング (`src/components/`)
- ズーム / パン / ドラッグなどのインタラクション (`src/components/ImageViewer.tsx`)
- グローバルな状態管理 (`src/store/index.ts`、Zustand)
- キーボードショートカット (`src/hooks/useKeyboard.ts`)
- サムネイル生成キューと優先度制御 (`src/hooks/useThumbnailGenerator.ts`)
- 本画像のプリロード (`src/hooks/useImagePreloader.ts`)
- ウィンドウ状態のイベント購読 (`src/hooks/useWindowState.ts`)

「**何を Rust 側でやって、何を React 側でやるか**」 の境界線は、本プロジェクトでは比較的ハッキリしています。
*画像のバイト列を base64 にして JSON に詰めて返すまで*が Rust の仕事で、*それを `<img>` タグの `src` に入れて見せる*のが React の仕事です。

---

## ディレクトリツリー

```
spica-photo-viewer/
├── src/                       # フロントエンド (React + TypeScript)
│   ├── main.tsx               # React アプリのエントリ
│   ├── App.tsx                # 最上位コンポーネント、起動時処理
│   ├── components/            # UI コンポーネント
│   │   ├── ImageViewer.tsx    # メイン画像ビューア (ズーム・パン)
│   │   ├── ThumbnailBar.tsx   # 下部のサムネイルバー
│   │   ├── DropZone.tsx       # ドラッグ&ドロップ領域
│   │   ├── FileOpenButton.tsx # ファイル選択ボタン
│   │   └── AboutDialog.tsx    # F1 で出る About ダイアログ
│   ├── hooks/                 # カスタムフック
│   │   ├── useKeyboard.ts        # キーボードショートカット
│   │   ├── useCacheManager.ts    # メモリキャッシュ管理
│   │   ├── useThumbnailGenerator.ts  # サムネイル生成キュー
│   │   ├── useImagePreloader.ts      # 本画像プリロード
│   │   ├── useWindowState.ts         # ウィンドウ状態購読
│   │   └── useFileDrop.ts            # ファイルドロップ (現在 App.tsx で無効化)
│   ├── store/
│   │   └── index.ts           # Zustand ストア (~870 行、全状態と全 action)
│   ├── types/
│   │   └── index.ts           # TypeScript 型定義 (Rust 側 struct と対応)
│   ├── constants/
│   │   └── timing.ts          # デバウンス時間などの定数
│   ├── utils/                 # テスト用ヘルパー (testFactories, testUtils)
│   └── __tests__/setup.ts     # vitest のグローバルセットアップ
│
├── src-tauri/                 # バックエンド (Rust)
│   ├── src/
│   │   ├── main.rs            # バイナリのエントリ (lib.rs を呼ぶだけ)
│   │   ├── lib.rs             # Tauri アプリの組み立て、コマンド登録
│   │   ├── commands/
│   │   │   ├── mod.rs         # サブモジュール宣言
│   │   │   ├── file.rs        # ファイル/画像系コマンド (8 個)
│   │   │   ├── cache.rs       # サムネイルキャッシュ (4 個)
│   │   │   └── window.rs      # ウィンドウ操作 (4 個)
│   │   ├── utils/
│   │   │   ├── mod.rs
│   │   │   └── image.rs       # 画像デコード・サムネイル生成
│   │   └── test_utils.rs      # テスト用ヘルパー (テスト時のみコンパイル)
│   ├── capabilities/
│   │   └── default.json       # 補助的な capability ファイル
│   ├── Cargo.toml             # Rust 依存
│   ├── tauri.conf.json        # Tauri 設定 (window/build/security/bundle)
│   └── build.rs               # ビルドスクリプト (tauri-build を呼ぶだけ)
│
├── scripts/
│   └── sync-version.cjs       # package.json → tauri.conf.json/Cargo.toml の同期
│
├── package.json               # Node 依存と npm scripts
├── vite.config.ts             # Vite 設定 (port 1420)
├── vitest.config.ts           # vitest 設定 (jsdom + setup.ts)
├── tsconfig.json              # TypeScript 設定
├── biome.json                 # Biome (lint + format) 設定
├── .github/workflows/ci.yml   # CI: 型/lint/format/フロントテスト/cargo test
└── .claude/                   # Claude Code 用の設定 (hook, rules, commands)
```

実際のソースを開いて確認してみてください。

---

## データフロー: 1 枚の画像が表示されるまで

ファイル関連付けで `.jpg` をダブルクリックして起動した場合、または `npm run tauri dev` で起動して "Open Image" を押した場合の流れを追ってみます。

### 起動時 (ファイル関連付け経由)

```
[OS] 画像ファイルをダブルクリック
   │  (引数として画像パスを渡してアプリを起動)
   ▼
[Rust] main.rs → lib.rs::run() → Tauri Builder が起動
   │
   ▼
[Rust] WebView ウィンドウを開き、frontendDist (../dist) または devUrl (localhost:1420) を読み込む
   │
   ▼
[React] main.tsx → App.tsx がマウント
   │
   ▼
[React] App.tsx (line 26-42) の useEffect で
        invoke<string|null>("get_startup_file") を呼ぶ
   │
   ▼
[Rust] commands/file.rs:125 get_startup_file()
        std::env::args() から画像パスを探して返す
   │
   ▼
[React] 戻ってきたパスで store の openImageFromPath() を呼ぶ
        (src/store/index.ts:546)
   │
   ├──► invoke("maximize_window")    (ウィンドウを最大化)
   │
   └──► invoke("get_folder_images", { path: folderPath })
            ↓
   [Rust] commands/file.rs:40 get_folder_images()
          WalkDir で画像を列挙し、Rayon でメタデータを並列取得
            ↓
   [React] 取得した ImageInfo[] を folder.images にセット、
           現在の画像インデックスを特定
   │
   ▼
[React] ImageViewer.tsx の useEffect が currentImage.path の変化を検知して
        invoke<ImageData>("load_image", { path }) を呼ぶ
   │
   ▼
[Rust] commands/file.rs:71 load_image()
        utils/image.rs:28 load_image_as_base64() で画像を base64 化
        utils/image.rs:48 get_image_dimensions() で幅・高さを取得
   │
   ▼
[React] ImageData (base64 + width + height) を <img src="data:..."> として描画
   │
   ▼
[並行] useThumbnailGenerator が周辺画像のサムネイルを生成
       useImagePreloader が ±5 枚の本画像をプリロード
```

### キーボードでの「次へ」操作 (←/→)

```
[ユーザー] →キーを押す
   ▼
[React] useKeyboard.ts:64 が KeyboardEvent を捕まえて navigateNext()
   ▼
[React] store/index.ts:415 navigateNext() → navigateToImage(nextIndex)
   ▼
[React] navigateToImage (store/index.ts:293)
        - 直前画像のズーム/パンを imageViewStates に保存
        - 次の画像が preloaded 済みなら即座に表示 (0ms)
        - サムネイルだけ持っているならまずサムネイルを表示
        - どちらも無ければローディング状態
   ▼
[React] ImageViewer の useEffect (line 292) が currentImage.path 変化を検知
        - サムネイル表示中なら debounce 0ms で本画像取得 (line 302-304)
        - そうでなければ IMAGE_LOAD_DEBOUNCE_MS = 50ms 待ってから取得
   ▼
[Rust] load_image (キャッシュにあればプリロード結果を使用)
   ▼
[React] 本画像で <img> を差し替え
```

このフローは [PROJECT_SPEC.md](../../PROJECT_SPEC.md) の「Display Priority (3 levels)」と「Cached Image Display (0ms)」セクションに対応しています。

---

## ハンズオン演習

このアーキテクチャを実際に体感するために、開発者ツールから IPC を直接たたいてみましょう。

1. `npm run tauri dev` でアプリを起動する
2. ウィンドウを右クリック → "Inspect Element" で WebView の DevTools を開く (Tauri は v2 で右クリックメニューから DevTools にアクセスできます)
3. Console タブで以下を実行:

   ```js
   const { invoke } = await import("@tauri-apps/api/core");
   await invoke("get_cache_stats");
   ```

4. `{ total_files: ..., valid_files: ... }` のようなオブジェクトが返ってくれば成功です。これは `commands/cache.rs:184` の `get_cache_stats` が JSON で返した HashMap がそのまま JS の object になったものです。
5. 試しに `await invoke("validate_image_file", { path: "C:\\Windows\\System32\\notepad.exe" })` を呼ぶと、`false` (画像じゃないので) が返るはずです (`commands/file.rs:119`)。
6. 存在しないコマンドを呼んでみましょう: `await invoke("does_not_exist")` → エラーになります。`lib.rs:24-41` の `invoke_handler!` に登録されたコマンドだけが呼べることを確認してください。

このように、フロントは `invoke(コマンド名, 引数オブジェクト)` で Rust 関数を呼び出します。引数オブジェクトのキーは Rust 関数の引数名と一致している必要があります (例: `path: String` なら `{ path: "..." }`)。

---

## 次のステップ

全体像がつかめたら → [03-rust-essentials.md](./03-rust-essentials.md) で、コードを読むのに必要な Rust の最低限を学びます。
