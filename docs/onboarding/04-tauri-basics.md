# 04. Tauri v2 の基礎

## この章で学ぶこと

- Tauri v2 アプリの全体像 (Rust core / WebView / Plugin / Capability)
- `tauri.conf.json` の主要セクション
- `tauri::Builder` と `invoke_handler!` の組み立て方
- `#[tauri::command]` マクロの正体
- `AppHandle` と `WebviewWindow`
- Capability (権限) の仕組み
- Plugin の使い方
- フロントから Rust を呼ぶ 2 つの方法 (`invoke` と `event listen`)

所要時間: 45 分

---

## Tauri v2 の構成要素

Tauri v2 アプリは大きく 4 つの要素でできています。

| 要素 | 役割 |
| --- | --- |
| **Rust core** | アプリ本体。ファイル I/O、画像処理、ウィンドウ管理など。本プロジェクトでは `src-tauri/src/` 配下 |
| **WebView** | UI を描画するブラウザコンポーネント。Windows では Edge WebView2 |
| **Plugin** | Tauri が公式提供する追加機能 (ダイアログ、ファイル opener など)。本プロジェクトでは `tauri-plugin-dialog` と `tauri-plugin-opener` を使用 |
| **Capability** | フロントが Rust 側のどの機能を呼べるかを宣言する権限定義。`tauri.conf.json` または `capabilities/*.json` |

これら 4 つを束ねる設定ファイルが `tauri.conf.json` です。

---

## `tauri.conf.json` の主要セクション

`src-tauri/tauri.conf.json:1-52` を上から順に読み解きます。

### `productName` / `version` / `identifier` (3-5 行目)

```json
"productName": "Spica Photo Viewer",
"version": "1.0.0",
"identifier": "com.hirof.spica-photo-viewer"
```

`identifier` は逆ドメイン形式で書きます。MSI インストーラやファイル関連付け時のレジストリキーに使われる、アプリのユニーク ID です。

### `build` (6-11 行目)

```json
"build": {
  "beforeDevCommand": "npm run dev",
  "devUrl": "http://localhost:1420",
  "beforeBuildCommand": "npm run build",
  "frontendDist": "../dist"
}
```

- `beforeDevCommand`: `tauri dev` 実行時にまず走らせるフロント開発サーバ起動コマンド
- `devUrl`: `tauri dev` 中に WebView が読み込む URL
- `beforeBuildCommand`: `tauri build` (本番ビルド) 前に走らせるフロントビルドコマンド
- `frontendDist`: ビルド済みフロントの出力先ディレクトリ (`tauri.conf.json` から見た相対パス)

ここを読むと、**`tauri dev` は Vite を立ち上げてその URL を WebView で見せる、`tauri build` は dist にバンドルされた静的ファイルを WebView で見せる** という違いがわかります。

### `app.windows` (13-19 行目)

```json
"windows": [
  {
    "title": "Spica Photo Viewer",
    "width": 800,
    "height": 600
  }
]
```

起動時のウィンドウ定義です。プロパティの完全リストは [Tauri 公式の Window 設定](https://tauri.app/reference/config/#windowconfig) を参照。

### `app.security.capabilities` (20-39 行目)

後述の「Capability」節で詳しく解説します。本プロジェクトでは "main-capability" として、以下の権限を main ウィンドウに与えています。

```json
"permissions": [
  "core:default",
  "core:window:allow-set-fullscreen",
  "core:window:allow-is-fullscreen",
  "core:window:allow-close",
  "dialog:allow-open",
  "dialog:default"
]
```

### `bundle` (41-51 行目)

`tauri build` で出力するインストーラの設定。`targets: "all"` は対応する OS 全部 (Windows なら MSI、macOS なら DMG、Linux なら AppImage 等) を出すという意味です。

---

## `tauri::Builder` と `invoke_handler!`

Rust 側のエントリは `src-tauri/src/lib.rs:19-44` です。短いので全文を見ます。

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_folder_images,
            load_image,
            handle_dropped_file,
            validate_image_file,
            generate_image_thumbnail,
            generate_thumbnail_with_dimensions,
            get_startup_file,
            open_with_dialog,
            get_cached_thumbnail,
            set_cached_thumbnail,
            clear_old_cache,
            get_cache_stats,
            get_window_state,
            get_window_position,
            resize_window_to_image,
            maximize_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

ここで起こっていることを順に説明します。

### 1. `tauri::Builder::default()`

Tauri アプリを組み立てるためのビルダーパターンの入口です。

### 2. `.plugin(...)` ×2

Tauri 公式プラグインを 2 つ登録しています。

- `tauri_plugin_opener` : `Cargo.toml:22` で依存追加。フロントから外部ファイル/URL を「OS のデフォルトアプリで開く」ための補助
- `tauri_plugin_dialog` : `Cargo.toml:23` で依存追加。OS ネイティブのファイル選択ダイアログを表示するため。本プロジェクトでは `src/store/index.ts:785` の `openFileDialog` で使用

### 3. `.invoke_handler(tauri::generate_handler![...])`

ここが **Tauri の心臓部** です。`generate_handler!` マクロは渡された関数群を「フロントから `invoke()` で呼べる関数のディスパッチテーブル」にコンパイルします。

ここに登録されていない関数は、フロントから `invoke("関数名")` しても `"command not found"` エラーになります。新しいコマンドを追加するときは **必ずこのリストに加える** 必要があります (この点は [09 章の総合演習](./09-hands-on-final.md) でも実際に体験します)。

### 4. `.run(tauri::generate_context!())`

`generate_context!` は `tauri.conf.json` を読み込んでコンテキスト (アイコン、メタデータ、capability など) を生成するマクロです。`run()` で実際にイベントループを開始します。

### 5. `.expect("...")`

`run()` は `Result` を返します。エラーなら panic して `"error while running tauri application"` を表示します。

### `main.rs` との関係

`src-tauri/src/main.rs:1-6` :

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    spica_photo_viewer_lib::run()
}
```

- `main.rs` は **バイナリ用のエントリ** (実行ファイルのエントリポイント)
- `lib.rs` は **ライブラリ用のエントリ** (`Cargo.toml:14` で `name = "spica_photo_viewer_lib"` として宣言、`crate-type = ["staticlib", "cdylib", "rlib"]` で複数形態をサポート)
- `main.rs` はライブラリの `run()` を呼ぶだけ

なぜ分かれているか? Tauri 公式が **モバイル対応 (iOS/Android) のためにライブラリ形式が必要** で、デスクトップでも `main` バイナリと共有できるようにこの構成になっています (`Cargo.toml:11-14` のコメント参照)。

なお `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]` は **release ビルドのときだけ** Windows のサブシステムを `windows` (= GUI) にして、コンソールウィンドウを出さないための指定です。debug ビルドではコンソールが付くので `println!` でログが見られます。

---

## `#[tauri::command]` マクロが何をしているか

`commands/file.rs:39-44` を見てみます。

```rust
#[tauri::command]
pub async fn get_folder_images(path: String) -> Result<Vec<ImageInfo>, String> {
    let folder_path = Path::new(&path);
    // ...
}
```

`#[tauri::command]` 属性は、コンパイル時にこの関数を **フロントから呼べる Tauri command** に変換します。具体的には次のことを自動で行います。

1. **引数を JSON からデシリアライズ**: フロントから `invoke("get_folder_images", { path: "..." })` で渡された JSON を、Rust の `String` に変換
2. **戻り値を JSON にシリアライズ**: Rust が返した `Result<Vec<ImageInfo>, String>` を JSON に変換してフロントに送り返す
3. **`Result` を JS の Promise resolve/reject に対応付け**: `Ok(value)` は Promise を resolve、`Err(err)` は reject (= フロントの `try/catch` で捕まえられる)
4. **async 関数を Tauri のランタイムで実行**

つまりフロント側は次のように書くだけで、Rust の関数を await できます:

```typescript
// src/store/index.ts:577 (抜粋)
const images = await invoke<ImageInfo[]>("get_folder_images", {
  path: folderPath,
});
```

### 引数名の対応規則

**フロント側のオブジェクトのキー名は、Rust 関数の引数名 (snake_case) と一致させる必要があります**。例:

| Rust 引数 | フロント側の渡し方 |
| --- | --- |
| `path: String` | `{ path: "..." }` |
| `size: Option<u32>` | `{ size: 30 }` または `{ size: null }` |
| `image_width: u32` | `{ imageWidth: 100 }` ← **キャメルケースに自動変換される** |

`commands/window.rs:42-47` の `resize_window_to_image` がよい例です:

```rust
pub async fn resize_window_to_image(
    app_handle: AppHandle,
    image_width: u32,
    image_height: u32,
    zoom_percent: f64,
    image_screen_center_x: f64,
    image_screen_center_y: f64,
    disable_animation: Option<bool>,
) -> Result<(), String> {
```

これをフロントから呼ぶときは `src/store/index.ts:749-756`:

```typescript
await invoke("resize_window_to_image", {
  imageWidth: width,
  imageHeight: height,
  zoomPercent: currentZoom,
  imageScreenCenterX: imageScreenCenterX,
  imageScreenCenterY: imageScreenCenterY,
  disableAnimation: true,
});
```

Rust 側の snake_case が JS 側で camelCase になっているのがわかります。これは Tauri が自動で変換するためで、明示的に設定は不要です。

---

## `AppHandle` と `WebviewWindow`

ウィンドウ操作を行うコマンドでは、特殊な引数 `AppHandle` を最初に受け取ります。`commands/window.rs:3-10`:

```rust
#[tauri::command]
pub async fn get_window_position(app_handle: AppHandle) -> Result<WindowPosition, String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;

    let position = window
        .outer_position()
        .map_err(|e| format!("Failed to get window position: {}", e))?;
    // ...
}
```

ポイント:

- `AppHandle` は **Tauri が自動的に注入する** 引数。フロントから渡す必要はない (フロントは `invoke("get_window_position")` と引数なしで呼ぶだけ)
- `app_handle.get_webview_window("main")` で `tauri.conf.json` で定義した `"main"` ウィンドウを取得
- 戻り値は `Option<WebviewWindow>` なので `.ok_or(...)` で `Result` に変換し、`?` で早期 return している

`WebviewWindow` には以下のようなメソッドが生えています。

- `is_maximized()`、`is_fullscreen()` (`commands/window.rs:25-31`)
- `set_size(PhysicalSize)`、`set_position(PhysicalPosition)` (`commands/window.rs:84-108`)
- `maximize()`、`unmaximize()` (`commands/window.rs:78`、`commands/window.rs:167`)
- `primary_monitor()` (画面サイズ取得、`commands/window.rs:92`)

詳細は Tauri 公式ドキュメントを参照: https://docs.rs/tauri/latest/tauri/window/struct.WebviewWindow.html

---

## Capability (権限)

Tauri v2 では **「フロントエンドが Rust 側のどんな機能を呼べるか」を明示的に宣言する必要があります**。これが Capability です。

### このプロジェクトの capability

`tauri.conf.json:20-39` :

```json
"capabilities": [
  {
    "identifier": "main-capability",
    "description": "Main application capabilities",
    "windows": ["main"],
    "permissions": [
      "core:default",
      "core:window:allow-set-fullscreen",
      "core:window:allow-is-fullscreen",
      "core:window:allow-close",
      "dialog:allow-open",
      "dialog:default"
    ]
  }
]
```

各 permission の意味:

| permission | 何を許可するか |
| --- | --- |
| `core:default` | 標準的なアプリライフサイクル、イベント購読、自前で書いた `#[tauri::command]` の呼び出し |
| `core:window:allow-set-fullscreen` | フロントからフルスクリーンを切り替えられる (`useKeyboard.ts:29` の `window.setFullscreen(true)`) |
| `core:window:allow-is-fullscreen` | フロントからフルスクリーン状態を問い合わせられる (`useKeyboard.ts:23`) |
| `core:window:allow-close` | フロントからウィンドウを閉じられる (`useKeyboard.ts:50` の `window.close()`) |
| `dialog:allow-open` | `tauri-plugin-dialog` の `open()` を許可 |
| `dialog:default` | プラグインのデフォルト権限セット |

### 重要な原則: 必要最小限

例えばフロントから直接ファイルを読み書きしたいなら `fs:*` 系の permission を追加する必要がありますが、本プロジェクトでは **意図的にそれを許可していません**。代わりに必要な操作はすべて `#[tauri::command]` として Rust 側で実装し、フロントはそれを呼ぶだけ、という設計になっています。

これにより、攻撃者が WebView のスクリプトを書き換えたとしても、許可されていない操作 (任意ファイル読み出しなど) はできません。

### 自前 command と capability

「自分で書いた `#[tauri::command]` を呼ぶには `core:default` で十分」という点は重要です。**自作コマンドごとに permission を追加する必要はありません** (Tauri v2 のデフォルト挙動)。

### `capabilities/default.json` との関係

`capabilities/default.json:1-10` も別ファイルとして存在します:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default"
  ]
}
```

`tauri.conf.json` 内に書かれた capability と、`capabilities/` 配下の JSON ファイルの両方が読み込まれます。本プロジェクトでは両方とも `main` ウィンドウに紐づいており、`opener:default` (tauri-plugin-opener の権限) はこちらに分離されています。

---

## Plugin の使い方

Tauri にはプラグイン機構があり、よく使う機能 (ダイアログ、通知、ファイル opener など) は公式プラグインで提供されます。

### Rust 側 (登録)

`Cargo.toml:22-23` で依存に追加し、`lib.rs:22-23` で `.plugin(...)` で初期化するだけです。

```toml
tauri-plugin-opener = "2.5"
tauri-plugin-dialog = "2.7"
```

```rust
.plugin(tauri_plugin_opener::init())
.plugin(tauri_plugin_dialog::init())
```

### フロント側 (使用)

`package.json:27-28` で対応する JS パッケージを追加し、import して使います。

```json
"@tauri-apps/plugin-dialog": "^2.7.0",
"@tauri-apps/plugin-opener": "^2.5.3",
```

実例 (`src/store/index.ts:785-795`):

```typescript
const { open } = await import("@tauri-apps/plugin-dialog");

const selected = await open({
  multiple: false,
  filters: [
    {
      name: "Images",
      extensions: ["jpg", "jpeg", "png", "webp", "gif"],
    },
  ],
});
```

`open()` を呼ぶには capability で `dialog:allow-open` (または `dialog:default`) が許可されていることが前提です。

---

## フロント → Rust の 2 つの呼び出し方法

### 1. `invoke`: 1 回のリクエスト/レスポンス

`@tauri-apps/api/core` の `invoke<T>()` を使います。

```typescript
import { invoke } from "@tauri-apps/api/core";

const images = await invoke<ImageInfo[]>("get_folder_images", {
  path: folderPath,
});
```

- 第 1 引数: コマンド名 (Rust 側の関数名と一致)
- 第 2 引数 (省略可): 引数オブジェクト
- 戻り値: `Promise<T>` (T はジェネリクスで指定)

### 2. `event listen`: Rust 側からのプッシュ通知を購読

ウィンドウのリサイズや最大化など、Rust (Tauri 本体) が能動的に通知してくる事象は `@tauri-apps/api/window` の `WebviewWindow.listen()` (または `@tauri-apps/api/event` の `listen()`) で購読します。

実例 (`src/hooks/useWindowState.ts:34-54`):

```typescript
const window = getCurrentWindow();

const unlistenResize = await window.listen("tauri://resize", handleResize);
const unlistenMaximize = await window.listen("tauri://maximize", () => {
  setMaximized(true);
});
const unlistenUnmaximize = await window.listen("tauri://unmaximize", () => {
  setMaximized(false);
});
```

`listen()` が返すのは「購読解除関数」です。コンポーネントのアンマウント時に呼んでクリーンアップします。

---

## ハンズオン演習

`02-architecture.md` のハンズオンと同じく、DevTools Console から IPC を試してみます。

1. `npm run tauri dev` でアプリを起動
2. WebView の DevTools を開く
3. Console で以下を実行:

   ```js
   const { invoke } = await import("@tauri-apps/api/core");

   // Capability で許可されているコマンド
   await invoke("get_cache_stats");

   // 引数つきコマンド (Rust 側 snake_case → JS 側もそのままでよい場合)
   await invoke("validate_image_file", { path: "C:\\Windows\\notepad.exe" });

   // Rust 側 snake_case → JS 側で camelCase が要求される例
   // (resize_window_to_image は要件を満たすときだけ動くので、ここではあえてエラーを起こす)
   await invoke("resize_window_to_image", {
     imageWidth: 100,
     imageHeight: 100,
     zoomPercent: 100,
     imageScreenCenterX: 500,
     imageScreenCenterY: 500,
   });
   ```

最後の `resize_window_to_image` は、ウィンドウが最大化されていない場合 `Err("Window is not maximized")` を返すはずです (`commands/window.rs:58-60`)。Promise の reject として `try/catch` で捕まえるか、コンソールに赤いエラーが出ます。

これにより:

- 引数のキャメルケース変換が起きていること
- Rust の `Err` がフロントの `reject` に対応すること

を体感できます。

---

## 次のステップ

Tauri 固有の作法を理解したら → [05-backend-walkthrough.md](./05-backend-walkthrough.md) で Rust 側のコードを順番に精読します。
