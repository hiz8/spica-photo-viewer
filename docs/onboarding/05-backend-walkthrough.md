# 05. Rust バックエンドのコード読解

## この章で学ぶこと

`src-tauri/src/` 配下の各ファイルを順番に開き、何をしているかを精読します。読み終わったとき、16 個ある `#[tauri::command]` のすべてについて「どのファイルの何行目に書かれていて、何をするか」を答えられる状態を目指します。

所要時間: 90 分

---

## ファイル構成のおさらい

```
src-tauri/src/
├── main.rs              バイナリのエントリ (lib.rs を呼ぶだけ)
├── lib.rs               Tauri アプリ組み立て、command 登録
├── test_utils.rs        テストヘルパー (#![cfg(test)])
├── commands/
│   ├── mod.rs           pub mod cache; pub mod file; pub mod window;
│   ├── file.rs          ファイル/画像系コマンド (8 個)
│   ├── cache.rs         サムネイルキャッシュ (4 個)
│   └── window.rs        ウィンドウ操作 (4 個)
└── utils/
    ├── mod.rs           pub mod image;
    └── image.rs         画像デコード・サムネイル生成
```

`main.rs` と `lib.rs` の関係、`#[tauri::command]` マクロの役割は [04-tauri-basics.md](./04-tauri-basics.md) で説明済みです。本章では主に **`commands/`** と **`utils/image.rs`** を精読します。

---

## utils/image.rs — 画像処理ユーティリティ

`commands/file.rs` から呼ばれる低レベル関数群です。先にここを押さえておくと、他のコードが格段に読みやすくなります。

### `is_supported_image` (5-13 行目)

拡張子で対応形式かを判定する純粋関数。

```rust
pub fn is_supported_image(path: &Path) -> bool {
    match path.extension().and_then(|s| s.to_str()) {
        Some(ext) => matches!(
            ext.to_lowercase().as_str(),
            "jpg" | "jpeg" | "png" | "webp" | "gif"
        ),
        None => false,
    }
}
```

ポイント:

- **`&Path` を受け取る** ので、呼び出し側は所有権を渡さなくてよい
- `to_lowercase()` で大文字・小文字を区別しない
- `matches!` マクロで複数の文字列リテラルを `|` で並べて判定
- 拡張子が無いファイル (`extension()` が `None`) は弾く

### `get_image_format` (15-26 行目)

`is_supported_image` と似ていますが、こちらは `image::ImageFormat` を返します。`load_image_as_base64` で書き出し形式を決めるのに使われます。

### `load_image_as_base64` (28-46 行目)

このプロジェクトで「画像をフロントへ送る」唯一の経路です。

```rust
pub fn load_image_as_base64(path: &Path) -> Result<String, ImageError> {
    // For GIF files, read the original file to preserve animation
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        if ext.to_lowercase() == "gif" {
            let file_data = std::fs::read(path).map_err(|e| ImageError::IoError(e))?;
            return Ok(general_purpose::STANDARD.encode(&file_data));
        }
    }

    // For other formats, use image processing
    let img = image::open(path)?;
    let mut buffer = Vec::new();
    let format = get_image_format(path).unwrap_or(ImageFormat::Jpeg);
    img.write_to(&mut std::io::Cursor::new(&mut buffer), format)?;

    Ok(general_purpose::STANDARD.encode(&buffer))
}
```

ここに **GIF だけ特別扱いする理由** が明示されています: 「アニメーションを保持するため、デコード/再エンコードを通さず元のバイト列をそのまま base64 化」しています。`image::open()` でデコードしてしまうと最初の 1 フレームだけになってしまうためです。

その他の形式は `image::open()` でデコードしたあと、元の形式で再エンコードしてから base64 化します。

### `get_image_dimensions` (48-52 行目)

`image::ImageReader` を使うと、画像全体をデコードせずヘッダだけ読んで寸法を取れます。これは `load_image` で寸法情報を返すために使われています。

### `generate_thumbnail` (54-63 行目)

`image::DynamicImage::thumbnail()` で縮小し、JPEG として base64 化します。サムネイルは常に JPEG なので、`ThumbnailBar.tsx:29` の `<img src="data:image/jpeg;base64,...">` のハードコードと整合しています。

---

## commands/file.rs — ファイル/画像系コマンド

`#[tauri::command]` が 8 個あります。順に見ていきます。

### `get_folder_images` (40-68 行目)

フォルダ内の画像を全部リストアップする、最も呼ばれるコマンドの 1 つです。

```rust
#[tauri::command]
pub async fn get_folder_images(path: String) -> Result<Vec<ImageInfo>, String> {
    let folder_path = Path::new(&path);

    if !folder_path.exists() || !folder_path.is_dir() {
        return Err("Invalid folder path".to_string());
    }

    // First, collect all valid image paths (fast, no metadata reads)
    let image_paths: Vec<_> = WalkDir::new(folder_path)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|entry| {
            let path = entry.path();
            path.is_file() && is_supported_image(path)
        })
        .map(|entry| entry.path().to_path_buf())
        .collect();

    // Process metadata in parallel using rayon
    let mut images: Vec<ImageInfo> = image_paths
        .par_iter()
        .filter_map(|path| get_image_info(path).ok())
        .collect();

    images.sort_by(|a, b| a.filename.cmp(&b.filename));
    Ok(images)
}
```

注目ポイント:

- **`WalkDir::new(...).max_depth(1)`**: サブディレクトリを再帰しない。`commands/file.rs:399-417` のテストでこの挙動が固定されています
- **2 段階処理**:
  1. 拡張子のフィルタリングで「画像かもしれない」パスを集める (1 ファイルあたり O(1)、IO なし)
  2. `rayon::par_iter()` で並列にメタデータ (サイズ・更新時刻) を取得

  `Cargo.toml:29` で依存追加されている `rayon` クレートのおかげで、CPU コア数だけスレッドが立ち、900 枚ある大きなフォルダでも体感できる速度差が出ます。
- **画像の検証は遅延**: ファイルが本当に有効な画像かは `image::open()` を通すまでわかりませんが、ここではあえて検証を **しません** (281-306 行目のコメントで明示)。900 枚のフォルダで全部開くと数秒かかってしまうため、実際の `load_image` 時に検出する設計です
- **ソート**: ファイル名の昇順

### `load_image` (71-101 行目)

1 枚の画像を読み込んで base64 + 寸法 + 形式を返します。

返り値の `ImageData` 構造体は `commands/file.rs:23-30` で定義され、TypeScript 側の `src/types/index.ts:9-15` の `ImageData` interface と対応しています。

### `handle_dropped_file` (104-116 行目)

ドラッグ&ドロップで投下されたファイルが画像かを検証して `ImageInfo` を返します。**現在 `App.tsx:21` で `useFileDrop` がコメントアウトされている** ため、実プロダクトでは呼ばれていません。残してある理由は将来 D&D を再有効化する想定です。

### `validate_image_file` (119-122 行目)

3 行のシンプルな関数。「ファイルが存在し、ファイルで、拡張子が画像形式」のすべてを満たすかを bool で返します。`async` ではなく **同期関数** です (即座に終わる処理なので)。

### `get_startup_file` (125-137 行目)

OS が画像ファイルをダブルクリックで起動した場合、画像パスはコマンドライン引数として渡ってきます。それを拾って返します。

```rust
pub fn get_startup_file() -> Result<Option<String>, String> {
    let args: Vec<String> = std::env::args().collect();

    for arg in &args[1..] {
        let path = Path::new(arg);
        if path.exists() && path.is_file() && is_supported_image(path) {
            return Ok(Some(arg.clone()));
        }
    }

    Ok(None)
}
```

`args[0]` は実行ファイル自体のパスなのでスキップしています。`Result<Option<String>, String>` の三層構造はフロント側で `string | null` として受け取られます (`App.tsx:29`)。

### `generate_image_thumbnail` (140-155 行目)

互換性のために残されている古い API。寸法を返さない、シンプルなサムネイル生成。**現在のフロントコードからは呼ばれていません** が、`lib.rs:29` で登録されているので削除はされていません。

### `generate_thumbnail_with_dimensions` (159-186 行目)

現役で使われているサムネイル生成 API。サムネイル本体に加えて元画像の寸法も返します。フロント側 (`useThumbnailGenerator.ts:67-74`) では戻り値の `original_width`/`original_height` を使って、サムネイル表示時にも正しい縦横比でレイアウトします。

### `prepare_path_for_open_with` (private, 195-249 行目)

`#[cfg(target_os = "windows")]` で Windows 限定。「プログラムから開く」ダイアログに渡すパスを 8.3 形式の短いパスに変換します。

なぜこんなことをするのか? `rundll32.exe shell32.dll,OpenAs_RunDLL "C:\path with spaces\テスト画像 (1).jpg"` のような長いパスを渡すと、シェルのエスケープルールに引っかかって失敗することがあるためです。`GetShortPathNameW` Windows API で `C:\PATHWI~1\テスト画~1.JPG` のような形に変換すれば、空白も括弧も日本語も問題になりません。

`unsafe` ブロックは Windows API を呼ぶために必要。失敗時は元のパスにフォールバックする実装になっています (242 行目)。

### `open_with_dialog` (252-279 行目)

Windows のみ動作。`rundll32.exe shell32.dll,OpenAs_RunDLL <path>` を spawn して「プログラムから開く」ダイアログを表示します。

```rust
#[cfg(not(test))]
{
    use std::process::Command;

    Command::new("rundll32.exe")
        .arg("shell32.dll,OpenAs_RunDLL")
        .arg(&_prepared_path)
        .spawn()
        .map_err(|e| format!("Failed to spawn rundll32.exe: {}", e))?;
}
```

`#[cfg(not(test))]` で囲まれているのは、**テスト時に実際のダイアログを開かないため**。テストではパスの検証 (`prepare_path_for_open_with`) だけが走り、UI は出ません。

### `get_image_info` (private, 281-315 行目)

ファイルメタデータ (サイズ、更新日時、ファイル名、拡張子) から `ImageInfo` を組み立てるヘルパー。`get_folder_images` から並列に呼ばれます。

---

## commands/cache.rs — サムネイルキャッシュ

ディスク上にサムネイルを保存して、フォルダを再度開いたときに即座に表示できるようにする仕組みです。

### キャッシュディレクトリ (private, 19-53 行目)

OS ごとに保存先を変えています。

| OS | 保存先 |
| --- | --- |
| Windows | `%APPDATA%\SpicaPhotoViewer\cache` |
| macOS | `~/Library/Caches/SpicaPhotoViewer` |
| Linux | `$XDG_CACHE_HOME/SpicaPhotoViewer` または `~/.cache/SpicaPhotoViewer` |

`cfg!(target_os = "...")` マクロを if 式の中で使う書き方に注目してください ([03 章 8 節](./03-rust-essentials.md#8-条件付きコンパイル-cfg) で解説済み)。

### キャッシュキー (private, 55-63 行目)

ファイルパスとサムネイルサイズをハッシュ化して、ファイル名にしています。`std::collections::hash_map::DefaultHasher` を使ったシンプルな実装。

### `CacheEntry` 構造体 (7-15 行目)

```rust
#[derive(Debug, Serialize, Deserialize)]
pub struct CacheEntry {
    pub thumbnail: String,
    pub created: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}
```

JSON ファイルとしてディスクに書かれます。`width`/`height` が後から追加されたフィールドなので、古いキャッシュ (寸法なし) との互換性を保つために `Option` + `skip_serializing_if` で省略可能になっています。

### `get_cached_thumbnail` (65-98 行目)

キャッシュを読みに行き、24 時間以上経っていれば削除して `None` を返します。

```rust
const CACHE_DURATION: u64 = 24 * 60 * 60; // 24 hours in seconds
```

タプルの返り値 `Option<(String, Option<u32>, Option<u32>)>` が JS 側ではどう見えるかは `src/hooks/useThumbnailGenerator.ts:47-52` で確認できます (配列 `[base64, width, height] | null`)。

### `set_cached_thumbnail` (101-132 行目)

`CacheEntry` を JSON にして書き出す。`println!` でログを出している箇所はないので静かに動作します。

### `clear_old_cache` (135-181 行目)

起動時に呼ばれる (`useCacheManager.ts:15`) クリーンアップ処理。`CACHE_DURATION` を超えた JSON ファイルを削除します。腐ったキャッシュ (JSON パース失敗) も削除対象。最後に削除件数を `println!` で出します。

### `get_cache_stats` (184-227 行目)

統計情報 (`total_files` / `valid_files`) を `HashMap<String, u32>` で返します。これは JS 側では普通のオブジェクト (`{ total_files: number, valid_files: number }`) として扱われます。

---

## commands/window.rs — ウィンドウ操作

すべてのコマンドが `app_handle: AppHandle` を最初の引数に受け取ります。これは Tauri が自動で注入する引数で、フロント側の `invoke()` の引数オブジェクトには含めません ([04 章](./04-tauri-basics.md#apphandle-と-webviewwindow) 参照)。

### `get_window_position` (3-17 行目)

ウィンドウの外枠の位置 (画面上の x, y 座標) を返します。`outer_position()` はタイトルバーや枠線も含む座標。

### `get_window_state` (19-37 行目)

最大化中・フルスクリーン中かを `WindowState` 構造体で返します。フロントは `useWindowState.ts:15` で起動時にこれを呼び、初期状態を取得します。

### `resize_window_to_image` (39-147 行目)

このプロジェクトで一番複雑なコマンドです。「最大化されたウィンドウを、表示中の画像にぴったり合うサイズに縮める」処理を行います。

ロジックの大筋:

1. 最大化されていなければ早期 return (`58-60 行目`)
2. ズーム率を考慮した「表示画像サイズ」を計算 (`63-65 行目`)
3. UI 余白 (40px 横、80px 縦 — サムネイルバー分) を加算 (`67-72 行目`)
4. ウィンドウを `unmaximize()` してから `set_size()`
5. 画像が画面内のどの位置にいたかを基に新しいウィンドウ位置を計算
6. プライマリモニターのサイズ取得 → 画面外にはみ出さないようにクランプ
7. `set_position()`

`disable_animation: Option<bool>` で OS のリサイズアニメーションを抑制するかを切り替えますが、フロント側 (`store/index.ts:755`) は `true` 固定で呼んでいます。

### `maximize_window` (161-172 行目)

シンプルにウィンドウを最大化。`store/index.ts:572` で「画像を開いたときに自動最大化」のために呼ばれます。

---

## エラーハンドリング規約

このプロジェクトでは **全 Tauri command が `Result<T, String>` を返す** という規約で統一されています。

| ファイル | 例 |
| --- | --- |
| `commands/file.rs:40` | `Result<Vec<ImageInfo>, String>` |
| `commands/cache.rs:184` | `Result<HashMap<String, u32>, String>` |
| `commands/window.rs:40` | `Result<(), String>` |

エラーメッセージは英語の自然文で書かれます。フロント側では `try/catch` の `error` として受け取り、`store/index.ts:651` のように `new Error(...)` でラップして UI に表示されます。

将来的にエラーの型を細分化したくなる可能性はありますが、現状は十分機能しています。

---

## ハンズオン演習

`commands/cache.rs:17` の `CACHE_DURATION` 定数 (24 時間) に注目してください。

### 演習: TTL を一時的に短くしてみる

1. `CACHE_DURATION` の値を `60` (= 60 秒) に変更
2. `npm run tauri dev` でアプリを起動
3. 画像フォルダを開いてサムネイルを表示
4. アプリを終了
5. 60 秒以上待つ (PC を別作業に使う等)
6. 再度起動
7. ターミナルに `Cleaned N old cache entries` (`commands/cache.rs:179`) と表示されることを確認
8. **元の値 (`24 * 60 * 60`) に戻す**

これで `clear_old_cache` がいつ呼ばれて何をしているか、を体感できます。

> 元に戻すのを忘れないでください。コミットする予定がない場合でも、git の作業ツリーをクリーンに保つために `git diff` で確認してから `git restore src-tauri/src/commands/cache.rs` で戻すと安全です。

### 補足演習: 自分でキャッシュディレクトリを覗く

Windows なら `%APPDATA%\SpicaPhotoViewer\cache` をエクスプローラで開いてみると、`{16進数}.json` という名前のファイルが並んでいるはずです。中身を VS Code で開くと、`CacheEntry` の JSON 表現が見えます。

```json
{"thumbnail":"...base64...","created":1735698123,"width":1920,"height":1080}
```

`commands/cache.rs:7-15` の `CacheEntry` 構造体と完全に対応していることが確認できます。

---

## 次のステップ

Rust バックエンドの全体像が見えたら → [06-frontend-walkthrough.md](./06-frontend-walkthrough.md) でフロントエンドのコードを読み進めます。
