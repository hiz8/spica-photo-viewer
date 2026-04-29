# 03. このプロジェクトを読むために必要な Rust の最低限

## この章で学ぶこと

このプロジェクトの Rust コードは、`tauri::command` で外部に公開する短い関数の集まりです。難しい言語機能はほぼ使われていません。本章では、コードを読み進めるために最低限必要な Rust の概念だけを、実際のコードを参照しながら駆け足で押さえます。

- 構造体と `derive`
- 所有権と借用、`String` vs `&str`
- `Result<T, E>` と `?` 演算子
- `Option<T>`
- `match` と `if let`
- `async` / `await` と Tauri との関係
- モジュールシステム (`mod`、`use`、`pub`)
- 条件付きコンパイル `#[cfg(...)]`
- `serde` の derive マクロ

所要時間: 60 分

> ここで挙げない概念 (lifetime 注釈、trait の定義、ジェネリクス、unsafe など) はこのコードベースを読むうえでは実用上ほぼ不要です。必要になったら都度 [The Rust Programming Language](https://doc.rust-lang.org/book/) を参照してください。

---

## 1. 構造体と `derive`

`commands/file.rs:14-21` を見てみましょう。

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageInfo {
    pub path: String,
    pub filename: String,
    pub size: u64,
    pub modified: u64,
    pub format: String,
}
```

- `struct` は名前付きフィールドを持つレコード型 (TypeScript の `interface` / Java の class に似ています)
- フィールドや構造体名の前の `pub` は **モジュールの外から参照できる** という意味
- `#[derive(...)]` は **コンパイラに既定の実装を自動生成させる** マクロ

このプロジェクトでは以下の derive が頻出します。

| derive | 何を生成する | このプロジェクトでの用途 |
| --- | --- | --- |
| `Debug` | `{:?}` での表示 | デバッグ用 `eprintln!` で型を出すため |
| `Clone` | 値の複製 | フロント返却前に `path.clone()` する場面など |
| `Serialize` | JSON 等にシリアライズ可能にする | フロントへ返す型に必須 |
| `Deserialize` | JSON 等から値を作れるようにする | フロントから受ける引数型に必須 |

Tauri の引数や戻り値で使う構造体には、ほぼ必ず `#[derive(Serialize, Deserialize)]` が付きます。これがないと **フロントエンドと値をやりとりできません**。

---

## 2. 所有権と借用、`String` vs `&str`

Rust 最大の特徴は **所有権 (ownership)** です。値には常に「持ち主」が 1 人だけいて、持ち主のスコープが切れると値が解放される、というルールです。

実用上、次のことを覚えておけばこのコードは読めます。

- **`String`**: ヒープに確保された可変長の文字列。所有権を持つ
- **`&str`**: 既存の文字列への借用 (= ポインタ + 長さ)
- 関数の引数で:
  - `String` を受け取る = 所有権ごと譲り受ける
  - `&str` を受け取る = 借りるだけ (元の持ち主のもの)
- `String::to_string()` / `String::clone()` で複製ができる
- `&str` から `String` へは `.to_string()` か `String::from(...)`

このプロジェクトでは **Tauri command の引数は必ず `String`** です。例:

```rust
// commands/file.rs:71
pub async fn load_image(path: String) -> Result<ImageData, String> {
```

これは Tauri マクロの制約で、「フロントから渡された JSON 文字列は所有付きで受け取る必要がある」ためです。逆に **コマンド以外の内部ヘルパー関数は `&Path` や `&str` を借用で受けることが多い**:

```rust
// commands/file.rs:281
fn get_image_info(path: &Path) -> Result<ImageInfo, String> {
```

### `Path` と `PathBuf`

文字列ではなくファイルパス専用の型もあります。

- **`Path`** : `&str` のパス版 (借用)
- **`PathBuf`**: `String` のパス版 (所有)

このプロジェクトでは `Path::new(&string)` で `&Path` を作り (`commands/file.rs:41`)、文字列に戻すときは `.to_string_lossy().to_string()` を使います。`to_string_lossy()` は OS のパスに含まれる不正な UTF-8 を `?` に置き換えて文字列化する安全なメソッドです。

---

## 3. `Result<T, E>` と `?` 演算子

Rust には例外がありません。代わりに **失敗するかもしれない処理は `Result<T, E>` を返す** のが慣習です。

```rust
enum Result<T, E> {
    Ok(T),    // 成功した値
    Err(E),   // エラー値
}
```

### このプロジェクトの規約: `Result<T, String>`

`commands/file.rs:40` を見ます。

```rust
pub async fn get_folder_images(path: String) -> Result<Vec<ImageInfo>, String> {
    let folder_path = Path::new(&path);

    if !folder_path.exists() || !folder_path.is_dir() {
        return Err("Invalid folder path".to_string());
    }
    // ...
    Ok(images)
}
```

成功なら `Ok(値)`、失敗なら `Err(エラーメッセージ文字列)` を返します。本プロジェクトではエラーの型を `String` で統一しています。これは **シンプルで初心者にも読みやすい一方、エラー種別を区別したいときには弱い** 設計ですが、現在のところ用途に十分マッチしています。

### `?` 演算子: エラーの早期 return

`commands/file.rs:81-86` の例:

```rust
let base64_data =
    load_image_as_base64(image_path).map_err(|e| format!("Failed to load image: {}", e))?;

let (width, height) = get_image_dimensions(image_path)
    .map_err(|e| format!("Failed to get image dimensions: {}", e))?;
```

行末の `?` は次のように展開されます。

```rust
let base64_data = match load_image_as_base64(image_path).map_err(...) {
    Ok(value) => value,
    Err(e) => return Err(e),
};
```

`?` は **`Err` だったら即 return、`Ok` だったら中身を取り出す** という糖衣構文です。エラー処理を書くときに `if let Err(e) = ... { return Err(...) }` の連鎖を書かずに済みます。

`map_err` は `Err` の中身を別の型に変換するメソッドです。`utils/image.rs` の関数は `ImageError` を返すので、それを `String` にして上位に伝播させるためにここで挟んでいます。

---

## 4. `Option<T>`

「値がある or ない」を表す型です。`null` の代わりだと思ってください。

```rust
enum Option<T> {
    Some(T),
    None,
}
```

`commands/file.rs:125-137` の `get_startup_file` が良い例です。

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

`Result<Option<String>, String>` は「(成功 or 失敗) かつ (パスがあった or 無かった)」を一度に表しています。フロント側 (`App.tsx:29`) では `string | null` として受け取られます。`Some` が `string` に、`None` が `null` に変換されるイメージです。

`.unwrap_or(default)` は「`Some(値)` ならその値、`None` なら `default`」を返すメソッドで、デフォルト値を扱うときに頻出します:

```rust
// commands/file.rs:151
let thumbnail_size = size.unwrap_or(30);
```

---

## 5. `match` と `if let`

### `match`

`utils/image.rs:5-13` の例:

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

`match` は値の形 (バリアント) で分岐する制御構文です。**全パターンを網羅していないとコンパイルエラー** になるため、`Option` や `Result` の処理漏れを防げます。

`matches!` マクロは「値がパターンにマッチすれば `true`」を返すショートカットで、複数の文字列リテラルを `|` で並べて簡潔に書いています。

### `if let`

`Option` のうち片方だけ気にするときは `if let` が便利です。

```rust
// utils/image.rs:30-34 (抜粋)
if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
    if ext.to_lowercase() == "gif" {
        // GIF ファイル専用処理
    }
}
```

「`Some(値)` のときだけ実行する」と読めば OK です。

---

## 6. `async` / `await` と Tauri との関係

`commands/file.rs:40` の関数シグネチャに注目してください。

```rust
pub async fn get_folder_images(path: String) -> Result<Vec<ImageInfo>, String> {
```

`async` が付くと、その関数は **Future (将来完了する処理)** を返すようになります。フロントから `invoke()` で呼ばれた Tauri command は **常に Promise として扱われる** ため、Tauri 側のコマンドは多くが `async` で書かれています。

### このプロジェクトでの使い分け

- **`async`**: 内部で I/O (ファイル読み書き、画像デコード) があり、フロントで `await` する想定のコマンド
  - 例: `get_folder_images`、`load_image`、`generate_thumbnail_with_dimensions`、`get_cached_thumbnail`
- **同期 (`async` なし)**: I/O がほぼなく即座に終わる関数
  - 例: `validate_image_file` (`commands/file.rs:119`)、`get_startup_file` (`commands/file.rs:125`)

`async` でも実際には `.await` を使って明示的に待つ場面はこのコードにはほとんどありません (`fs::read_to_string()` などは同期 API を使っています)。Tauri command を `async` にしておくのは「フロント側の `Promise` に揃える」ための慣習だと考えてください。

### テストでの `#[tokio::test]`

非同期関数をテストするには通常の `#[test]` ではなく **`#[tokio::test]`** を使います。`Cargo.toml:37` で `tokio` を `dev-dependencies` に入れているのはそのためです。

```rust
// commands/file.rs:323-333
#[tokio::test]
async fn test_get_folder_images_with_valid_folder() {
    let temp_dir = create_temp_dir();
    create_test_jpeg(temp_dir.path(), "image1.jpg");
    // ...
    let result = get_folder_images(...).await;
    assert!(result.is_ok());
}
```

---

## 7. モジュールシステム

Rust のソースは **クレート (crate)** という単位でビルドされ、そのなかに **モジュール (mod)** で名前空間を切ります。

このプロジェクトの構造を例に見ます。

`src-tauri/src/lib.rs:1-17` :

```rust
mod commands;
mod utils;

#[cfg(test)]
mod test_utils;

use commands::cache::{
    clear_old_cache, get_cache_stats, get_cached_thumbnail, set_cached_thumbnail,
};
use commands::file::{
    generate_image_thumbnail, generate_thumbnail_with_dimensions, get_folder_images,
    get_startup_file, handle_dropped_file, load_image,
    open_with_dialog, validate_image_file,
};
// ...
```

- `mod commands;` は「`commands.rs` か `commands/mod.rs` を読み込んで `commands` モジュールにする」宣言
- `commands/mod.rs:1-3` で `pub mod cache;` などとさらに子モジュールを宣言
- `use foo::bar::Baz;` で長い名前を短く使えるようにする (TypeScript の `import` と似ています)
- `pub` を付けないアイテムは **モジュール外から参照できない**

このプロジェクトでは **公開する関数のうえに `pub`、内部だけで使う関数 (例: `commands/file.rs:281` `get_image_info`) には `pub` を付けない** という方針が一貫しています。

---

## 8. 条件付きコンパイル `#[cfg(...)]`

OS 別の処理を書いたり、テスト時だけ有効にしたいコードがあるとき、`#[cfg(...)]` 属性を使います。

`commands/file.rs:195` :

```rust
#[cfg(target_os = "windows")]
fn prepare_path_for_open_with(path: &str) -> Result<String, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetShortPathNameW;
    // Windows API を使う処理
}
```

Windows 以外でビルドしたときには **この関数は存在しない** ことになり、コンパイルにも含まれません。

`test_utils.rs:1`:

```rust
#![cfg(test)]
```

ファイル先頭の `#![cfg(test)]` は **このファイル全体を test ビルド時のみ含める** という指定です。`#[cfg(test)]` (`!` なし) はその直下のアイテムだけが対象、`#![cfg(test)]` (`!` あり = inner attribute) はファイル全体が対象、と覚えておきましょう。

`commands/cache.rs:20-45` では `cfg!()` マクロも使われています。これは関数の中で if 式として OS 判定する書き方です:

```rust
let cache_dir = if cfg!(target_os = "windows") {
    // Windows: %APPDATA%\SpicaPhotoViewer\cache
    // ...
} else if cfg!(target_os = "macos") {
    // ...
};
```

両者は似ていますが、`#[cfg(...)]` 属性がコンパイル時にコードを物理的に削除する一方、`cfg!()` マクロは値 (`true`/`false`) として展開され、両方の分岐がコンパイルされます。

---

## 9. `serde` の derive マクロ

すでに何度か登場していますが、このプロジェクトで Tauri と JSON を行き来する型は **必ず `Serialize` / `Deserialize` を derive** します。

```rust
// commands/file.rs:14-21
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ImageInfo {
    pub path: String,
    pub filename: String,
    pub size: u64,
    pub modified: u64,
    pub format: String,
}
```

これだけで `ImageInfo` を `serde_json::to_string()` で JSON 化したり、JSON から復元したりできます。Tauri は内部でこの仕組みを使ってフロントと通信しています。

省略可能なフィールドには `#[serde(skip_serializing_if = "Option::is_none")]` を付けると、`None` のときに JSON に出力されません:

```rust
// commands/cache.rs:11-14
#[serde(skip_serializing_if = "Option::is_none")]
pub width: Option<u32>,
#[serde(skip_serializing_if = "Option::is_none")]
pub height: Option<u32>,
```

---

## ハンズオン演習

**演習 1**: `commands/file.rs:119-122` の `validate_image_file` 関数を読み、次の入力に対する戻り値を予想して紙に書いてみてください。

```rust
pub fn validate_image_file(path: String) -> Result<bool, String> {
    let file_path = Path::new(&path);
    Ok(file_path.exists() && file_path.is_file() && is_supported_image(file_path))
}
```

| 入力 (`path`) | 予想される戻り値 |
| --- | --- |
| 存在する `photo.jpg` のパス | ? |
| 存在する `notes.txt` のパス | ? |
| 存在しないパス | ? |
| 存在するディレクトリのパス | ? |

答え合わせは、`commands/file.rs:545-580` のテストケースを読んで確認してください。

**演習 2**: `commands/cache.rs:65-98` の `get_cached_thumbnail` を読み、戻り値の型 `Result<Option<(String, Option<u32>, Option<u32>)>, String>` をフロントエンド (TypeScript) で受け取るとどんな型になるか書いてみてください。

ヒント: `Result` は `Promise` の成否、`Option` は `T | null`、タプルは配列に変換されます。実際の使用例は `src/hooks/useThumbnailGenerator.ts:47-52` にあります。

---

## 次のステップ

Rust の最低限を押さえたら → [04-tauri-basics.md](./04-tauri-basics.md) で Tauri 固有の概念を学びます。
