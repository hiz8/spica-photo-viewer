# 07. テスト

## この章で学ぶこと

- バックエンド (Rust) のテスト構成と書き方
- フロントエンド (vitest + React Testing Library) のテスト構成と書き方
- テストヘルパー (`test_utils.rs` と `setup.ts`) の使いどころ
- 自分の追加した機能にテストを 1 件追加するハンズオン

所要時間: 45 分

---

## なぜテストを書くのか

このプロジェクトのテストは **「Specification-based testing (仕様ベーステスト)」** という方針で書かれています ([PROJECT_SPEC.md](../../PROJECT_SPEC.md) の Testing Implementation セクション参照)。つまり「実装の詳細をなぞる」のではなく、「コマンドの仕様 (こういう入力にはこういう出力)」を固定するためにテストが書かれます。

CI (`.github/workflows/ci.yml`) では PR ごとに `cargo test --lib` と `npm test` が走り、回帰を検出します。コミット前にローカルで両方を通すのが安心です。

---

## バックエンド (Rust) のテスト

### 実行コマンド

```bash
cd src-tauri
cargo test --lib                  # 全テスト
cargo test commands::file::tests  # ファイル指定
cargo test -- --nocapture         # println! の出力も表示
```

`--lib` はバイナリ (`main.rs`) を除いてライブラリ (`lib.rs`) のテストだけを走らせるオプション。本プロジェクトのテストはすべてライブラリ側に書かれているので、これで十分です。

### テストファイルの配置

このプロジェクトでは **テストは各ソースファイルの末尾に `#[cfg(test)] mod tests { ... }` で書く** スタイルを採用しています。

| ソース | テスト範囲 |
| --- | --- |
| `commands/file.rs:317-763` | `get_folder_images`、`load_image`、`generate_image_thumbnail`、`open_with_dialog` などのテスト |
| `commands/cache.rs:229-346` | キャッシュキー生成、キャッシュ読み書き、`CacheEntry` のシリアライズ |
| `utils/image.rs:65-268` | 形式判定、寸法取得、base64 化、サムネイル生成 |

別途 `tests/` ディレクトリを切る Rust の慣習 (= 統合テスト) は採用していません。**新しいテストを追加するときも、対象関数と同じファイルの `mod tests` の中に追加** します。

### `#[cfg(test)]` の意味

```rust
#[cfg(test)]
mod tests {
    use super::*;
    // ...
}
```

これにより、本番ビルド (`cargo build`) ではテストモジュールはコンパイルされず、バイナリサイズが膨らみません。テスト時 (`cargo test`) のみ有効化されます。

### 同期テスト vs 非同期テスト

```rust
// 同期テスト (commands/file.rs:546-553)
#[test]
fn test_validate_image_file_with_valid_image() {
    let temp_dir = create_temp_dir();
    let image_path = create_test_jpeg(temp_dir.path(), "valid.jpg");
    let result = validate_image_file(image_path.to_string_lossy().to_string());
    assert!(result.is_ok());
    assert!(result.unwrap());
}

// 非同期テスト (commands/file.rs:323-342)
#[tokio::test]
async fn test_get_folder_images_with_valid_folder() {
    let temp_dir = create_temp_dir();
    create_test_jpeg(temp_dir.path(), "image1.jpg");
    create_test_png(temp_dir.path(), "image2.png");
    create_test_gif(temp_dir.path(), "image3.gif");

    let result = get_folder_images(temp_dir.path().to_string_lossy().to_string()).await;
    assert!(result.is_ok());

    let images = result.unwrap();
    assert_eq!(images.len(), 3);
    assert_eq!(images[0].filename, "image1.jpg");
    assert_eq!(images[1].filename, "image2.png");
    assert_eq!(images[2].filename, "image3.gif");
}
```

ポイント:

- `async` 関数のテストには **`#[tokio::test]`** を使う
- `Cargo.toml:37` で `tokio = { version = "1", features = ["macros", "rt"] }` を dev-dependencies に入れている
- 同期関数 (`#[test]`) と非同期関数 (`#[tokio::test]`) はマクロで使い分け

### `test_utils.rs` の活用

`src-tauri/src/test_utils.rs` (1-86 行) には便利なヘルパーが揃っています。

| 関数 | 用途 |
| --- | --- |
| `create_temp_dir()` | `tempfile::tempdir()` で一時ディレクトリ作成。スコープを抜けると自動削除 |
| `create_test_jpeg(dir, filename)` | 1×1 赤ピクセル JPEG を生成 (`image` クレートで実物を作る) |
| `create_test_png(dir, filename)` | 1×1 緑ピクセル PNG |
| `create_test_webp(dir, filename)` | JPEG をリネームして `.webp` 拡張子にしたファイル (拡張子ロジックのテスト用) |
| `create_test_gif(dir, filename)` | 1×1 黒の最小有効 GIF (バイト列直書き) |
| `create_invalid_image(dir, filename)` | 「invalid image data」という文字列をファイルに書いただけ |
| `create_fake_image(dir, filename)` | 「This is not an image」という文字列を画像拡張子のファイルに書いた、形式判定だけ通るがデコードでこける用 |

**新しいテストを書くときは、まず `test_utils` で似たヘルパーが無いか探す** のが鉄則です。

### プラットフォーム条件付きテスト

`commands/file.rs:674-695` のように Windows 限定のテストには `#[cfg(target_os = "windows")]` を付けます。

```rust
#[test]
#[cfg(target_os = "windows")]
fn test_open_with_dialog_with_nonexistent_file() {
    let result = open_with_dialog("/nonexistent/file.jpg".to_string());
    assert!(result.is_err());
    assert!(result.unwrap_err().contains("File not found"));
}
```

CI は Linux で動く (`.github/workflows/ci.yml:46-68`) ので、Windows 限定テストは CI ではスキップされ、Windows 開発機でのみ走ります。

### Tauri command のテストで気をつけること

Tauri command も **ただの関数** なので、`#[tauri::command]` 属性を無視して直接呼び出すテストが書けます。

ただし `AppHandle` を引数に取るコマンド (`commands/window.rs` の関数群) は、AppHandle のインスタンスを作るのが面倒なため、本プロジェクトではテストされていません。可能なら **コマンドの本体ロジックを別関数に切り出してそちらをテスト** するのが望ましいですが、現状は省略されています。

---

## フロントエンド (TypeScript) のテスト

### 実行コマンド

```bash
npm test                    # 全テスト
npm run test:watch          # 変更ファイルを監視して自動再実行
npm run test:coverage       # カバレッジレポート出力
```

### フレームワーク構成

- **vitest**: テストランナー (`vitest.config.ts`)
- **jsdom**: DOM のシミュレート (`vitest.config.ts:8`)
- **React Testing Library**: コンポーネントのレンダリング・操作 (`@testing-library/react`)
- **@testing-library/jest-dom**: `toBeInTheDocument()` などのカスタムマッチャ

### グローバルセットアップ: `src/__tests__/setup.ts`

vitest 起動時に毎回読み込まれるファイル (`vitest.config.ts:9` で指定)。3 つの重要な設定:

1. **Tauri API のモック** (5-19 行)

   ```typescript
   vi.mock("@tauri-apps/api/core", () => ({
     invoke: vi.fn(),
   }));

   vi.mock("@tauri-apps/api/window", () => ({
     getCurrentWindow: vi.fn(() => ({
       isFullscreen: vi.fn(),
       setFullscreen: vi.fn(),
       close: vi.fn(),
     })),
   }));

   vi.mock("@tauri-apps/plugin-dialog", () => ({
     open: vi.fn(),
   }));
   ```

   **テスト中は実際の Tauri / Rust 側を呼ばない**。すべて `vi.fn()` のモックに差し替えられます。各テストではテスト内部で `vi.mocked(invoke).mockResolvedValueOnce(...)` を使って戻り値を制御します。

2. **window 寸法のスタブ** (22-32 行): `window.innerWidth`/`innerHeight` を 1920×1080 に固定。`fitToWindow` の計算を予測可能にするため

3. **ResizeObserver のモック** (35-39 行): jsdom には ResizeObserver が無いため、no-op のモック

### テストファイルの配置

| 場所 | 内容 |
| --- | --- |
| `src/components/__tests__/*.test.tsx` | コンポーネントテスト (AboutDialog、FileOpenButton、ImageViewer、ThumbnailBar) |
| `src/hooks/__tests__/*.test.ts` | フックテスト (useKeyboard、useImagePreloader、useThumbnailGenerator) |
| `src/store/__tests__/*.test.ts` | ストアテスト (action と state の動作) |

`tsconfig.json:24` で `**/*.test.ts` と `**/*.test.tsx`、`**/__tests__/**` を本番ビルド対象から除外しています。`tsconfig.test.json` がテスト用の型チェック設定です。

### Tauri モックされたテストの書き方

`useThumbnailGenerator` を例にすると、テスト内で次のように invoke のレスポンスを偽装できます。

```typescript
import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";

vi.mocked(invoke).mockImplementation(async (cmd, args) => {
  if (cmd === "get_cached_thumbnail") return null;
  if (cmd === "generate_thumbnail_with_dimensions") {
    return { thumbnail_base64: "AAAA", original_width: 100, original_height: 100 };
  }
  if (cmd === "set_cached_thumbnail") return undefined;
  throw new Error(`Unexpected invoke: ${cmd}`);
});
```

`invoke` を `vi.mocked()` でラップすると、TypeScript の型補完を効かせたままモック操作ができます。

### Zustand ストアのテスト

ストアは React コンポーネント外でも使えるため、ピュアな関数のように呼んでテストできます。

```typescript
import { useAppStore } from "../index";

beforeEach(() => {
  // ストアを初期状態に戻す
  useAppStore.setState({ /* 初期値 */ });
});

it("zoomIn は現在の zoom を 1.2 倍する", () => {
  useAppStore.setState((s) => ({ view: { ...s.view, zoom: 100 } }));
  useAppStore.getState().zoomIn();
  expect(useAppStore.getState().view.zoom).toBeCloseTo(120);
});
```

`.claude/rules/zustand-store.md` のルールに従い、テストでも **状態の更新は不変的に** 行います。

### React コンポーネントのテスト

```typescript
import { render, screen, fireEvent } from "@testing-library/react";
import AboutDialog from "../AboutDialog";

it("Esc キーで閉じる", () => {
  render(<AboutDialog />);
  // ...
});
```

詳細は React Testing Library のドキュメント https://testing-library.com/docs/react-testing-library/intro/ を参照。

---

## CI で何が走るか

`.github/workflows/ci.yml` を読むと、PR で実行されるチェックがわかります。

### Frontend tests (Ubuntu 上)

```yaml
- npm ci
- npm run type-check
- npm run lint
- npm run format
- npm run test
```

つまり **型・lint・format・vitest が全部通る必要があります**。手元では:

```bash
npm run type-check
npm run lint
npm run format
npm test
```

を実行して全部通せば CI も通ります。

### Backend tests (Ubuntu 上)

```yaml
- (apt で webkit2gtk 等をインストール)
- (Rust toolchain stable)
- cargo test --lib
```

**`--lib` 付き** で実行。手元の Windows でも `cd src-tauri && cargo test --lib` で同じテストが走ります。

> CI は Markdown ファイル (`*.md`) や `scripts/`、`public/` 配下の変更ではスキップされます (`.github/workflows/ci.yml:6-9`、`paths-ignore`)。今回追加した `docs/onboarding/*.md` は CI を起動しません。

---

## ハンズオン演習

[06-frontend-walkthrough](./06-frontend-walkthrough.md#ハンズオン演習) で書いた **「Ctrl+R でランダムジャンプ」** ショートカットに、vitest テストを 1 件追加してみましょう。

### 手順

1. まず 06 章の演習を実施し、`useKeyboard.ts` に Ctrl+R ハンドラを追加した状態に戻す
2. `src/hooks/__tests__/useKeyboard.test.ts` (既存ファイルがあれば追記、無ければ新規作成) を開く
3. 既存のテスト構成を観察して、似た形でテストを書く

   テストの大枠 (擬似コード):

   ```typescript
   import { renderHook } from "@testing-library/react";
   import { useKeyboard } from "../useKeyboard";
   import { useAppStore } from "../../store";

   describe("useKeyboard", () => {
     it("Ctrl+R はランダムなインデックスで navigateToImage を呼ぶ", () => {
       // 1. ストアを folder.images に 5 枚入った状態にセット
       useAppStore.setState({
         folder: {
           path: "/dummy",
           images: Array.from({ length: 5 }, (_, i) => ({
             path: `/dummy/${i}.jpg`,
             filename: `${i}.jpg`,
             size: 0,
             modified: 0,
             format: "jpeg",
           })),
           imagesByPath: new Map(),
           sortOrder: "name",
         },
       });

       // 2. navigateToImage をスパイに差し替え
       const navigateSpy = vi.fn();
       useAppStore.setState({ navigateToImage: navigateSpy });

       // 3. フックをマウント
       renderHook(() => useKeyboard());

       // 4. Ctrl+R を発火
       const event = new KeyboardEvent("keydown", { key: "r", ctrlKey: true });
       document.dispatchEvent(event);

       // 5. 検証
       expect(navigateSpy).toHaveBeenCalledTimes(1);
       const calledWith = navigateSpy.mock.calls[0][0];
       expect(calledWith).toBeGreaterThanOrEqual(0);
       expect(calledWith).toBeLessThan(5);
     });
   });
   ```

4. `npm test` を実行して、追加したテストがパスすることを確認
5. **わざと壊す**: `useKeyboard.ts` の Ctrl+R ハンドラから `event.ctrlKey` チェックを外してみる → テストが壊れるかは状況次第ですが、`navigateToImage` を別の意図しないキーで呼ぶようにするとテストが落ちることが体験できます
6. **コミットしないで戻す**: `git restore src/hooks/useKeyboard.ts src/hooks/__tests__/useKeyboard.test.ts` (新規作成した場合は `git rm` してから)

### 終わったら

ストアの状態を初期化、フックをレンダ、イベントを発火、結果を assert、という基本パターンが身につけば、ほとんどのフロントロジックがテスト可能になります。

---

## 次のステップ

テストの感覚がつかめたら → [08-development-workflow.md](./08-development-workflow.md) で日々の開発フローを学びます。
