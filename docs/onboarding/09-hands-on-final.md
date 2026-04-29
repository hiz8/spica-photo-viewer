# 09. 総合演習: 新規 Tauri command を追加してフロントから呼ぶ

## この章で学ぶこと

ここまでの 8 章で学んだことを統合する、縦串のハンズオンです。仮想の機能 **「現在表示中の画像のファイルサイズを画面右下に表示する」** を実装します。

完成すると次のフローが手元で再現できます。

```
React 側: ImageViewer の状態変化
  → invoke("get_image_file_size", { path })
  → Rust 側: commands/file.rs の新規関数で fs::metadata を返す
  → React 側: 受け取った数値を "12.3 KB" 形式にフォーマット
  → 画面右下に表示
```

所要時間: 90〜120 分

---

## 全体像

実装はいくつかの小さなステップに分けます。

| ステップ | 触るファイル | 概要 |
| --- | --- | --- |
| 1 | `src-tauri/src/commands/file.rs` | `get_image_file_size` コマンドを追加 |
| 2 | `src-tauri/src/lib.rs` | `invoke_handler!` に登録 |
| 3 | `src-tauri/src/commands/file.rs` (テスト節) | `#[tokio::test]` を 3 件追加 |
| 4 | `src-tauri/` で `cargo test --lib` | バックエンドテストが通るか確認 |
| 5 | `src/components/ImageViewer.tsx` | useEffect で invoke、useState でサイズ保持、JSX に表示要素を追加 |
| 6 | `src/components/__tests__/ImageViewer.test.tsx` | サイズ表示のテストを追加 (任意) |
| 7 | `npm run tauri dev` | 実機で動作確認 |
| 8 | コミットメッセージを書く | Conventional Commits 形式 |

---

## ステップ 1: バックエンドコマンドの追加

`src-tauri/src/commands/file.rs` を開き、ファイル末尾の `mod tests` ブロックの **直前** に次のコマンドを追加します。

```rust
/// Returns the file size in bytes for the given image path.
///
/// Returns Err if the file does not exist, is not a file, or is not a supported image format.
#[tauri::command]
pub async fn get_image_file_size(path: String) -> Result<u64, String> {
    let file_path = Path::new(&path);

    if !file_path.exists() || !file_path.is_file() {
        return Err("File not found".to_string());
    }

    if !is_supported_image(file_path) {
        return Err("Unsupported file format".to_string());
    }

    let metadata = fs::metadata(file_path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;

    Ok(metadata.len())
}
```

ポイント:

- `is_supported_image` は `commands/file.rs:1-3` で `use` 済みなのでそのまま使える
- `fs` も同じく `use std::fs;` (`commands/file.rs:6`) で導入済み
- 戻り値は `u64` (バイト数)。`ImageInfo::size` (`commands/file.rs:18`) と同じ型に揃えています
- 既存コマンドと同じく `Result<T, String>` 規約に従う

> **詰まりやすいポイント**: `pub async fn` の `pub` を忘れると `lib.rs` から `use` できません。`#[tauri::command]` の付け忘れも頻出ミスです。

---

## ステップ 2: `lib.rs` への登録

`src-tauri/src/lib.rs:10-14` の `use commands::file::{ ... };` ブロックに追加します。

```rust
use commands::file::{
    generate_image_thumbnail, generate_thumbnail_with_dimensions, get_folder_images,
    get_image_file_size,  // ← 追加
    get_startup_file, handle_dropped_file, load_image,
    open_with_dialog, validate_image_file,
};
```

そして `lib.rs:24-41` の `invoke_handler!` リストにも追加します。

```rust
.invoke_handler(tauri::generate_handler![
    get_folder_images,
    load_image,
    handle_dropped_file,
    validate_image_file,
    generate_image_thumbnail,
    generate_thumbnail_with_dimensions,
    get_image_file_size,    // ← 追加
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
```

> **詰まりやすいポイント**: `use` のインポートに追加してもここに登録しないと、フロントから呼んだときに「コマンドが見つからない」エラーになります。逆もまた然り。

---

## ステップ 3: バックエンドテストの追加

`commands/file.rs` のファイル末尾の `mod tests` の中、`test_open_with_dialog_with_japanese_filename` (760 行目以降) の **直前** あたりに 3 件追加します。

```rust
    #[tokio::test]
    async fn test_get_image_file_size_with_valid_image() {
        let temp_dir = create_temp_dir();
        let image_path = create_test_jpeg(temp_dir.path(), "size_test.jpg");

        let result = get_image_file_size(image_path.to_string_lossy().to_string()).await;
        assert!(result.is_ok());

        let size = result.unwrap();
        assert!(size > 0, "1x1 JPEG should have non-zero size");
    }

    #[tokio::test]
    async fn test_get_image_file_size_with_nonexistent_file() {
        let result = get_image_file_size("/nonexistent/file.jpg".to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("File not found"));
    }

    #[tokio::test]
    async fn test_get_image_file_size_with_unsupported_format() {
        let temp_dir = create_temp_dir();
        let text_file = temp_dir.path().join("notes.txt");
        std::fs::write(&text_file, "hello").unwrap();

        let result = get_image_file_size(text_file.to_string_lossy().to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported file format"));
    }
```

`use crate::test_utils::*;` (`commands/file.rs:320`) は既に書かれているので、`create_test_jpeg` などはそのまま使えます。

---

## ステップ 4: バックエンドテストを通す

```bash
cd src-tauri
cargo test --lib
```

すべて通るはずです。失敗した場合は:

- 関数の `pub` 忘れ → `cargo test` がコンパイルエラー
- テストの `assert!` が予想と違う → エラーメッセージ文字列を確認
- ファイル拡張子のミスマッチ (大文字小文字) → `is_supported_image` は小文字に変換しているので影響なし

---

## ステップ 5: フロントエンドへの表示

`src/components/ImageViewer.tsx` を開きます。

### 5-1. import の追加

ファイル先頭の import 群はそのままでよい (`invoke` は既に import 済み、`useState`/`useEffect` も既に使われている)。

### 5-2. ファイルサイズの状態を追加

`ImageViewer` コンポーネントの最初の方、`isDragging` の useState 宣言 (`ImageViewer.tsx:35-36`) のあたりに追加します。

```tsx
const [fileSize, setFileSize] = useState<number | null>(null);
```

### 5-3. ファイルサイズを取得する useEffect を追加

`useEffect` で `currentImage.path` の変化を監視し、`invoke("get_image_file_size", ...)` を呼びます。既存の useEffect 群 (`ImageViewer.tsx:292-337` 周辺) の近くに追加します。

```tsx
useEffect(() => {
  if (!currentImage.path) {
    setFileSize(null);
    return;
  }

  let cancelled = false;
  invoke<number>("get_image_file_size", { path: currentImage.path })
    .then((bytes) => {
      if (!cancelled) {
        setFileSize(bytes);
      }
    })
    .catch((err) => {
      console.warn("Failed to get file size:", err);
      if (!cancelled) {
        setFileSize(null);
      }
    });

  return () => {
    cancelled = true;
  };
}, [currentImage.path]);
```

`cancelled` フラグはレースコンディション対策です。ナビゲーションが速い場合、古い invoke の結果で新しい画像のサイズを上書きしないようにしています ([06 章の二段階画像ロード戦略](./06-frontend-walkthrough.md#二段階画像ロード戦略の実装) と同じパターン)。

### 5-4. フォーマット用ユーティリティ

コンポーネントの **外側** (ファイルトップレベル、`interface ImageViewerProps` の前あたり) に、純粋関数として追加します。

```tsx
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
```

### 5-5. JSX に表示を追加

`ImageViewer.tsx:510` の `view.zoom !== 100 && (...)` ブロックのすぐ後ろ、`</section>` の **直前** に追加します。

```tsx
{fileSize !== null && (
  <div className="file-size-indicator">{formatFileSize(fileSize)}</div>
)}
```

### 5-6. CSS の追加 (任意)

`src/App.css` (または該当する CSS ファイル) に、画面右下に表示するスタイルを追加します。プロジェクトに既存の `.zoom-indicator` クラスがあるはずなので、それを参考に揃えます。

```css
.file-size-indicator {
  position: absolute;
  bottom: 90px; /* サムネイルバーの上 */
  right: 20px;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  pointer-events: none;
}
```

> **詰まりやすいポイント**:
> - useEffect の依存配列に `currentImage.path` を必ず入れる (forgotten deps バグ)
> - `invoke<number>` のジェネリクス型を忘れると、戻り値が `unknown` になりエラー
> - `cancelled` フラグ無しだと、画像をすばやく切り替えたときに表示がチラつく可能性あり

---

## ステップ 6: フロントエンドテストの追加 (任意)

`src/components/__tests__/ImageViewer.test.tsx` (既存ファイル) に新しい `describe` ブロックを追加するか、別ファイルに分離します。

擬似コード:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import ImageViewer from "../ImageViewer";
import { useAppStore } from "../../store";

describe("ImageViewer file size indicator", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useAppStore.setState({
      currentImage: {
        path: "/dummy/photo.jpg",
        index: 0,
        data: null,
        error: null,
      },
    });
  });

  it("get_image_file_size の戻り値を KB 形式で表示する", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "get_image_file_size") return 12345;
      return undefined;
    });

    render(<ImageViewer />);

    await waitFor(() => {
      expect(screen.getByText("12.1 KB")).toBeInTheDocument();
    });
  });
});
```

`12345` バイトは `12345 / 1024 = 12.0556...` で `(12.0556).toFixed(1) = "12.1"` になります。テストの期待値はあなたの `formatFileSize` 実装に揃えてください。

実行:

```bash
npm test
```

> **詰まりやすいポイント**: `invoke` には他にも `useThumbnailGenerator` や `useImagePreloader` 内で呼ばれるコマンドがあります。`mockImplementation` ですべてのコマンドに分岐を書くか、`mockResolvedValue(undefined)` をデフォルトにしておくと安全です。`src/__tests__/setup.ts` の `vi.mock("@tauri-apps/api/core", ...)` がベースになっているので、本テストでは `vi.mocked(invoke)` で上書きするだけで OK です。

---

## ステップ 7: 動作確認

```bash
# 既に dev サーバが動いていれば Ctrl+C で停止して再起動
npm run tauri dev
```

1. アプリが起動したら "Open Image" で任意の画像を開く
2. 画面右下にファイルサイズが `12.3 KB` のような形式で表示されるはず
3. ←/→ で別画像に移動 → 表示が即座に更新される
4. DevTools の Console に `Failed to get file size: ...` が出ていないことを確認

---

## ステップ 8: 各種チェックを通す

```bash
# フロント
npm run type-check
npm run lint
npm run format
npm test

# バック
cd src-tauri && cargo test --lib
```

すべて green になれば PR 準備完了です。

CI ([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) で同じチェックが走ります。

---

## ステップ 9: コミット

Conventional Commits 形式で書きます。

```bash
git add src-tauri/src/commands/file.rs src-tauri/src/lib.rs \
        src/components/ImageViewer.tsx src/App.css \
        src/components/__tests__/ImageViewer.test.tsx
git commit -m "feat: 表示中画像のファイルサイズを画面右下に表示"
```

> **演習なのでコミットしないでもよい**: 動作確認が終わったら `git restore` で元に戻す or `git stash` で退避できます。

---

## あなたが触ったファイル一覧

完了後、振り返りとして次のファイルが変更/追加されたはずです。

| ファイル | 変更内容 |
| --- | --- |
| `src-tauri/src/commands/file.rs` | `get_image_file_size` 関数 + テスト 3 件 |
| `src-tauri/src/lib.rs` | `use` と `invoke_handler!` への 1 行追加 ×2 |
| `src/components/ImageViewer.tsx` | 状態 + useEffect + JSX + フォーマッタ |
| `src/App.css` (またはそれに相当) | `.file-size-indicator` スタイル |
| `src/components/__tests__/ImageViewer.test.tsx` | 新規テスト (任意) |

これら 5 ファイルが、Tauri アプリに新機能を 1 つ追加するときに触る代表的な箇所です。

---

## ふりかえり

このハンズオンで体感してほしかったのは、

- **新しい Tauri コマンドを追加するときの 2 ステップ** (`commands/*.rs` に書く + `lib.rs` に登録する)
- **Rust ↔ JS の引数/戻り値の対応** (`Result<u64, String>` ↔ `Promise<number>`、snake_case ↔ camelCase)
- **テスト → 動作確認 → 型/lint/format → コミット** の流れ
- **AbortController 不要なケースでも `cancelled` フラグでレース対策する** クリーンな async パターン

の 4 点です。

「自分の頭で何を変えるべきか分かる」状態になったら、ぜひ Issues を眺めて、興味のあるものを実装してみてください。

---

## 次のステップ

- 実際の Issue から 1 つ選んで、PR を出してみる
- [`.claude/rules/`](../../.claude/rules/) の他のルールも目を通す
- 大きな機能を追加するときは、まず Issue で設計を議論する

それでは、よい開発を!
