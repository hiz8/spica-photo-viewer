# 06. フロントエンドのコード読解 + IPC コントラクト

## この章で学ぶこと

- `main.tsx` → `App.tsx` の起動シーケンス
- Zustand ストアの状態形と主要アクション
- 6 つのカスタムフックそれぞれの役割
- フロント ↔ バックの IPC コントラクト一覧
- Tauri イベント購読の使い分け
- 二段階画像ロード戦略 (サムネイル → 本画像)

所要時間: 90 分

---

## ファイル構成のおさらい

```
src/
├── main.tsx                React エントリ
├── App.tsx                 ルートコンポーネント
├── components/
│   ├── ImageViewer.tsx     メイン画像表示・ズーム/パン
│   ├── ThumbnailBar.tsx    下部のサムネイル一覧
│   ├── DropZone.tsx        D&D 領域 (現状はメッセージ表示のみ)
│   ├── FileOpenButton.tsx  ファイル選択ボタン
│   └── AboutDialog.tsx     About ダイアログ
├── hooks/
│   ├── useKeyboard.ts          キーボードショートカット
│   ├── useCacheManager.ts      メモリキャッシュ管理
│   ├── useThumbnailGenerator.ts サムネイル生成キュー
│   ├── useImagePreloader.ts    本画像のプリロード
│   ├── useWindowState.ts       ウィンドウ状態の購読
│   └── useFileDrop.ts          ファイルドロップ (現状無効化)
├── store/index.ts          Zustand ストア
├── types/index.ts          型定義
├── constants/timing.ts     デバウンス時間などの定数
└── __tests__/setup.ts      vitest セットアップ
```

---

## 起動シーケンス: `main.tsx` → `App.tsx`

### `src/main.tsx` (10 行)

ごく標準的な React 18+ の起動コード。`<React.StrictMode>` で `<App>` をマウント。

```tsx
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

### `src/App.tsx` (71 行)

ルートコンポーネント。次の役割を持ちます。

1. **4 つのカスタムフックを起動** (`App.tsx:20-23`)
   - `useKeyboard()` — キーボードショートカット登録
   - `useCacheManager()` — キャッシュ初期化と定期クリーンアップ
   - `useWindowState()` — ウィンドウ状態の同期
   - `// useFileDrop()` ← 現状コメントアウト

2. **起動ファイルのチェック** (`App.tsx:26-42`)

   ```tsx
   useEffect(() => {
     const checkStartupFile = async () => {
       try {
         const startupFile = await invoke<string | null>("get_startup_file");
         if (startupFile) {
           console.log("Opening startup file:", startupFile);
           await openImageFromPath(startupFile);
         }
       } catch (error) {
         console.error("Failed to check startup file:", error);
       } finally {
         setCheckingStartupFile(false);
       }
     };
     checkStartupFile();
   }, [openImageFromPath, setCheckingStartupFile]);
   ```

   `invoke<string | null>("get_startup_file")` で Rust 側に問い合わせ、ファイル関連付けで起動された場合はそのパスを開きます。`finally` で `isCheckingStartupFile` フラグを `false` にして、welcome 画面の表示判定に使います。

3. **レイアウト**: `<DropZone>` の中に `<ImageViewer>`、welcome オーバーレイ、エラートースト、`<ThumbnailBar>`、`<AboutDialog>` を並べる
4. **welcome オーバーレイ条件** (`App.tsx:51`): `currentImage.path` が空 **かつ** 起動ファイルチェック完了後 のみ表示。これで「起動直後に一瞬 welcome が見える」フラッシュを防いでいます

---

## Zustand ストア: `src/store/index.ts`

このファイル (約 870 行) がフロント側の **唯一のグローバル状態** です。

### 状態の構造

`AppState` (`src/types/index.ts:47-88`) をそのまま使い、初期値を `store/index.ts:110-152` で定義。

```typescript
{
  currentImage: { path, index, data, error },
  folder: { path, images, imagesByPath, sortOrder },
  view: { zoom, panX, panY, isFullscreen, isMaximized, thumbnailOpacity, imageLeft?, imageTop?, imageWidth?, imageHeight? },
  cache: { thumbnails: Map, preloaded: Map, imageViewStates: Map, lastNavigationTime },
  thumbnailGeneration: { isGenerating, allGenerated, currentGeneratingPath },
  ui: { isLoading, showAbout, isDragOver, error, suppressTransition, suppressTransitionTimeoutId, thumbnailDisplayed?, isCheckingStartupFile },
}
```

### 重要な不変条件 (Zustand の使い方)

`.claude/rules/zustand-store.md` で明示されているとおり、**Zustand の状態は常に不変的に更新する** のがこのプロジェクトのルールです。

```typescript
// ✓ 良い例 (新しい Map を作る)
set((state) => ({
  cache: {
    ...state.cache,
    thumbnails: new Map(state.cache.thumbnails).set(path, data),
  },
}));

// ✗ 悪い例 (既存の Map を直接 mutate)
set((state) => {
  state.cache.thumbnails.set(path, data); // ❌ React が変更を検知しない
  return state;
});
```

ストア中の Map / Set / 配列を更新するときは、**必ず新しいインスタンスを作って差し替える** ようにしてください。`store/index.ts:681-691` の `setCachedThumbnail` などが模範例です。

### 主要アクション

| アクション | 行 | 何をするか |
| --- | --- | --- |
| `openImageFromPath` | 546-655 | パスを受け取り、フォルダ走査と現在画像インデックスの確定までを行う |
| `navigateToImage` | 293-413 | インデックスで画像移動。直前画像のズーム/パンを保存、キャッシュ済みなら 0ms で表示 |
| `navigateNext` / `navigatePrevious` | 415-457 | 壊れた画像をスキップしながら前後移動 |
| `setZoom` / `zoomIn` / `zoomOut` / `zoomAtPoint` | 210-516 | ズーム操作 (10〜2000% でクランプ、`zoomAtPoint` はカーソル中心) |
| `fitToWindow` | 518-544 | ウィンドウサイズに合わせて画像をフィット |
| `resizeToImage` | 722-773 | `invoke("resize_window_to_image", ...)` を呼ぶ |
| `openFileDialog` | 775-825 | `tauri-plugin-dialog` で OS ファイル選択ダイアログ |
| `openWithDialog` | 827-855 | `invoke("open_with_dialog", ...)` で「プログラムから開く」 |

### `navigateToImage` の二段階表示ロジック (293-413 行)

このプロジェクトの **「キャッシュにあれば 0ms 表示」** の仕組みは、ここで実現されています。重要なので抜粋します。

```typescript
// Priority 1: Check if image is already preloaded (full resolution)
const cachedImage = state.cache.preloaded.get(image.path);
let imageData: ImageData | null = null;
let thumbnailDisplayed = false;

if (cachedImage && cachedImage.format !== "error") {
  // Full resolution available - use it
  imageData = cachedImage;
} else {
  // Priority 2: Check if thumbnail is available for instant display
  const cachedThumbnail = state.cache.thumbnails.get(image.path);
  if (cachedThumbnail && cachedThumbnail !== "error") {
    imageData = thumbnailToImageData(image.path, cachedThumbnail);
    thumbnailDisplayed = true;
  }
}
```

このロジックの設計意図は [PROJECT_SPEC.md](../../PROJECT_SPEC.md) の「Display Priority (3 levels)」と「Cached Image Display (0ms)」セクションに詳しく書かれています。

加えて `suppressTransition` フラグ (`ui.suppressTransition`) を 300ms だけ立て、その間 CSS トランジションを無効化することで、ナビ中のアニメーションのチラつきを防いでいます (`store/index.ts:387-408`、`ImageViewer.tsx:445-447`)。

---

## カスタムフック詳説

### `useKeyboard` (`src/hooks/useKeyboard.ts`)

`document` に `keydown` リスナを 1 つ張って、すべてのショートカットを処理します (`useKeyboard.ts:56-122`)。Switch 文で Key 名を分岐:

| キー | アクション |
| --- | --- |
| `←` / `→` | `navigatePrevious` / `navigateNext` |
| `↑` / `↓` | `zoomIn` / `zoomOut` |
| `F11` | `toggleFullscreen` (内部で `getCurrentWindow().setFullscreen()`) |
| `Esc` | About 開いてれば閉じる、フルスクリーンなら抜ける、それ以外は `window.close()` |
| `F1` | `setShowAbout(true)` |
| `Ctrl+0` | `resetZoom` |
| `Ctrl+O` / `Ctrl+Shift+O` | `openFileDialog` / `openWithDialog` |

`getCurrentWindow().setFullscreen()` を呼ぶには capability で `core:window:allow-set-fullscreen` が必要 (`tauri.conf.json:31`)。許可されていないと例外になります。

### `useCacheManager` (`src/hooks/useCacheManager.ts`)

2 つの `useEffect` を持ちます。

1. **マウント時 (11-29 行)**: `invoke("clear_old_cache")` と `invoke("get_cache_stats")` をコールしてコンソールにログ
2. **30 秒ごと (32-68 行)**: メモリ上の `cache.preloaded` (上限 20)、`cache.thumbnails` (上限 100) が超過してたら古い順に削除

> 注意: 32-68 行のループは Map を **直接 mutate** しています (`cache.preloaded.delete(path)`)。これは Zustand のルールに反しているように見えますが、実装上は React の再レンダリングをトリガしないキャッシュ削除として動作しているため害はありません。新規にキャッシュ削減処理を書くときは [`.claude/rules/zustand-store.md`](../../.claude/rules/zustand-store.md) のルールに従って `set((state) => ({ cache: { ...state.cache, preloaded: new Map(...) } }))` で書くことを推奨します。

### `useThumbnailGenerator` (`src/hooks/useThumbnailGenerator.ts`)

このファイルが本プロジェクトで **最も巧妙なロジック** を持ちます。900 枚を超える写真フォルダでもスムーズに動作させるための工夫が詰まっています。

主要な仕掛け:

1. **優先度キュー** (`buildPriorityQueue`、135-174 行): 現在画像 → +1 → -1 → +2 → -2 ... の順序でサムネイル生成対象をリスト化
2. **3 段階の段階的拡張** (`expandQueueProgressively`、229-272 行):
   - Phase 0: 初期範囲 ±10 (`THUMBNAIL_GENERATION_INITIAL_RANGE`)
   - Phase 1: 拡張範囲 ±30 (`THUMBNAIL_GENERATION_EXPANDED_RANGE`)
   - Phase 2: 全画像
3. **AbortController でキャンセル**: ナビゲーションが起きたらサムネイル生成を中止して新しい優先度で再開 (`processQueue`、179-223 行)
4. **デバウンス**: 500ms (`THUMBNAIL_GENERATION_DEBOUNCE_MS`) 待ってから生成開始
5. **並列度制限**: 最大 3 件同時 (`MAX_CONCURRENT_LOADS`、`Promise.allSettled` で待つ)

各サムネイルの生成手順 (`generateThumbnail`、29-129 行):

```
1. メモリキャッシュにあれば即終了
2. invoke("get_cached_thumbnail") でディスクキャッシュを確認
3. ヒットすればメモリキャッシュに格納して終了
4. invoke("generate_thumbnail_with_dimensions") で新規生成
5. invoke("set_cached_thumbnail") でディスクに保存
6. メモリキャッシュにも格納
7. エラー時は "error" マーカーを書き込み (リトライ防止)
```

定数は `src/constants/timing.ts` に集約されています。

### `useImagePreloader` (`src/hooks/useImagePreloader.ts`)

すべてのサムネイル生成が完了 (`thumbnailGeneration.allGenerated === true`) してから、現在画像の前後 ±5 枚 (`PRELOAD_RANGE`) の本画像を `invoke("load_image")` で先読みします。

範囲外に出た画像はメモリから削除 (`cleanupCache`、118-152 行) します。

### `useWindowState` (`src/hooks/useWindowState.ts`)

起動時に `invoke("get_window_state")` で初期状態を取得し、その後 Tauri イベント (`tauri://resize`、`tauri://maximize`、`tauri://unmaximize`) を購読してストアの `view.isMaximized` / `view.isFullscreen` を同期します。

### `useFileDrop` (`src/hooks/useFileDrop.ts`)

`tauri://file-drop` イベントを購読してドロップされたファイルを開く実装ですが、現状 `App.tsx:21` でコメントアウトされています。`PROJECT_SPEC.md` の「Known Limitations」によれば、ブラウザのセキュリティ制約のため D&D が機能せず、代わりにファイル選択ダイアログを使う設計になっています。

---

## IPC コントラクト一覧

「フロントが Rust の何を呼んでいるか」をすべてリストアップします。新規にコマンドを追加するときの参考にしてください。

### `invoke` 呼び出し

| Rust コマンド (定義) | 呼び出し元 | 引数 | 戻り値 |
| --- | --- | --- | --- |
| `get_startup_file` (`commands/file.rs:125`) | `App.tsx:29` | なし | `string \| null` |
| `get_folder_images` (`commands/file.rs:40`) | `store/index.ts:577`、`useFileDrop.ts:62` (無効) | `{ path: string }` | `ImageInfo[]` |
| `load_image` (`commands/file.rs:71`) | `ImageViewer.tsx:86, 187, 222, 244`、`useImagePreloader.ts:47` | `{ path: string }` | `ImageData` |
| `validate_image_file` (`commands/file.rs:119`) | `useFileDrop.ts:40` (無効) | `{ path: string }` | `boolean` |
| `get_cached_thumbnail` (`commands/cache.rs:65`) | `useThumbnailGenerator.ts:47` | `{ path: string, size: number }` | `[base64, width, height] \| null` |
| `set_cached_thumbnail` (`commands/cache.rs:101`) | `useThumbnailGenerator.ts:79, 107` | `{ path, thumbnail, size, width, height }` | `void` |
| `generate_thumbnail_with_dimensions` (`commands/file.rs:159`) | `useThumbnailGenerator.ts:71` | `{ path: string, size: number }` | `{ thumbnail_base64, original_width, original_height }` |
| `clear_old_cache` (`commands/cache.rs:135`) | `useCacheManager.ts:15, 72` | なし | `void` |
| `get_cache_stats` (`commands/cache.rs:184`) | `useCacheManager.ts:19, 81` | なし | `Record<string, number>` |
| `get_window_state` (`commands/window.rs:20`) | `useWindowState.ts:15` | なし (`AppHandle` は自動注入) | `{ is_maximized, is_fullscreen }` |
| `maximize_window` (`commands/window.rs:162`) | `store/index.ts:572` | なし | `void` |
| `resize_window_to_image` (`commands/window.rs:40`) | `store/index.ts:749` | `{ imageWidth, imageHeight, zoomPercent, imageScreenCenterX, imageScreenCenterY, disableAnimation }` | `void` |
| `open_with_dialog` (`commands/file.rs:252`) | `store/index.ts:843` | `{ path: string }` | `void` |

未使用 (登録のみ):

- `handle_dropped_file` (`commands/file.rs:104`) — D&D 再有効化時に呼ぶ予定
- `generate_image_thumbnail` (`commands/file.rs:140`) — 新 API (`generate_thumbnail_with_dimensions`) に置き換えられたが残置
- `get_window_position` (`commands/window.rs:4`) — 現在フロントから呼んでいない

### `event listen` 購読

| イベント | 購読元 | 用途 |
| --- | --- | --- |
| `tauri://resize` | `useWindowState.ts:38` | リサイズ後に `get_window_state` を再取得 |
| `tauri://maximize` | `useWindowState.ts:42` | `setMaximized(true)` |
| `tauri://unmaximize` | `useWindowState.ts:47` | `setMaximized(false)` |
| `tauri://file-drop` | `useFileDrop.ts:21` (無効) | ドロップされたファイルを開く |

### Tauri Plugin API

| Plugin | 呼び出し元 | 用途 |
| --- | --- | --- |
| `@tauri-apps/plugin-dialog` の `open()` | `store/index.ts:785` | OS ファイル選択ダイアログ |
| `@tauri-apps/api/app` の `getVersion()` | `AboutDialog.tsx:14` | About に表示するバージョン |
| `@tauri-apps/api/window` の `getCurrentWindow()` | `useKeyboard.ts:22, 39, 49`、`useWindowState.ts:36` | フルスクリーン操作・ウィンドウクローズ・イベント購読 |

---

## 二段階画像ロード戦略の実装

`ImageViewer.tsx` の `loadImage` (44-289 行) は本プロジェクトで最も複雑なフロントロジックです。読み解くポイントを整理します。

```
[entry] currentImage.path が変わった
   ↓ useEffect (292-325 行)
   ↓ debounce: thumbnail 表示中なら 0ms、そうでなければ 50ms
   ▼
[loadImage]
  Case A: 全解像度 ImageData がすでに current に入っている
          → 何もしない (66-69 行)
  Case B: サムネイルが表示中で本画像にアップグレードしたい
          → invoke("load_image") → setImageData (76-114 行)
  Case C: ストアの cache.preloaded にある
          → setImageData して fitToWindow / updateImageDimensions (119-140 行)
  Case D: 上記以外
        → GIF? 直接 invoke("load_image") (242-266 行)
        → 非 GIF + キャッシュサムネイルあり? サムネイルを先に出してから
          バックグラウンドで本画像を invoke("load_image") (153-219 行)
        → どちらでもない? 直接 invoke("load_image") (221-241 行)
```

`AbortController` (`abortControllerRef`、`activeLoadPathRef`) で「ナビゲーションが進んだ後に古い画像が遅れて表示される」のを防いでいます。

`fitToWindow` (新画像、保存ビューステートなし) と `updateImageDimensions` (保存ビューステートあり) を切り替えているのは、戻ってきたときに前回のズーム/パンを復元するためです (`PROJECT_SPEC.md` の「View State Persistence」)。

---

## ハンズオン演習

`useKeyboard` に新しいショートカット **「Ctrl+R でランダムな画像にジャンプ」** を追加してみましょう。

### 手順

1. `src/hooks/useKeyboard.ts` を開く
2. `useAppStore()` から `navigateToImage` と `folder` を分割代入で追加で取り出す:

   ```typescript
   const {
     // ...既存...
     navigateToImage,
     folder,
   } = useAppStore();
   ```

3. `useEffect` 内の `switch` 文に `case "r":` / `case "R":` を追加:

   ```typescript
   case "r":
   case "R":
     if (event.ctrlKey) {
       event.preventDefault();
       const len = folder.images.length;
       if (len > 0) {
         const randomIndex = Math.floor(Math.random() * len);
         navigateToImage(randomIndex);
       }
     }
     break;
   ```

4. `useEffect` の依存配列にも `navigateToImage` と `folder.images.length` を追加 (この依存忘れが React のバグの王道なので注意)

5. `npm run tauri dev` で起動し、画像フォルダを開いてから `Ctrl+R` を連打 → 毎回違う画像にジャンプすることを確認

### 終わったら

この変更はコミットせず、`git restore src/hooks/useKeyboard.ts` で元に戻して構いません ([07-testing.md](./07-testing.md) のハンズオンで再度この変更を使います)。

ストアのアクションを呼び出すだけなら、IPC を意識せずにフロントだけで完結する機能が作れることがわかります。

---

## 次のステップ

フロント側のコードが読めるようになったら → [07-testing.md](./07-testing.md) でテストの書き方を学びます。
