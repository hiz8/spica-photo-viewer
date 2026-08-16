# Performance Measurement Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PERFORMANCE_AUTONOMY_PLAN.md の Phase 1〜3（計測 instrumentation・ベンチハーネス・baseline 確定）と Phase 6 の運用ルール整備を実装する。最適化そのもの（Phase 4〜5）は baseline 確定後に別プランで行う（スペック自身が「計測前の最適化禁止」を大原則としているため）。

**Architecture:** フロントは `window.__PERF__` バッファに mark を積むだけの軽量計時ユーティリティを埋め込み、区間の対応付け（measure 計算）はベンチハーネス側でオフラインに行う（ナビゲーション中断・abort があっても計測が壊れない）。Rust 側は `SPICA_PERF=1` 環境変数で有効化される JSON 1 行ログ。ベンチは WebdriverIO + `@wdio/tauri-service`（embedded provider、外部 msedgedriver 不要）で release ビルドを駆動する。

**Tech Stack:** TypeScript/React/Zustand/Vitest（フロント）、Rust/Tauri v2（バックエンド）、WebdriverIO v9 + `@wdio/tauri-service` + `tauri-plugin-wdio-webdriver`（E2E）、sharp（コーパス生成）。

**Spec:** `docs/PERFORMANCE_AUTONOMY_PLAN.md`

## 実コード調査で判明したスペックとの差分（このプランで吸収済み）

1. **`src/hooks/useImageLoader.ts` は存在しない。** 画像ロードは `src/components/ImageViewer.tsx` 内の `loadImage` コールバックと `src/hooks/useImagePreloader.ts` にある。
2. **`src-tauri/src/commands/image.rs` は存在しない。** `load_image` コマンドは `src-tauri/src/commands/file.rs`、実処理は `src-tauri/src/utils/image.rs`。
3. **「137 個の単体テスト」は古い。** 現在フロント 230 件（vitest 9 ファイル）+ Rust テスト。ゲートは件数固定ではなく「全テスト green」で定義する。
4. **既存の E2E ハーネスは無い**（`e2e/` ディレクトリ自体が無い）。Phase 2 はゼロから構築。
5. **ボトルネックの有力証拠:** `load_image` は `image::open`（フルデコード）→ 元フォーマットに**再エンコード** → base64 → JSON IPC → WebView で再デコード、という経路。20MP JPEG ではデコード+エンコード+base64 の三重コスト。スペックの Phase 5 第一候補（asset protocol 化）と整合。なお現状の再エンコードは EXIF を落とすため、asset protocol 化すると EXIF 回転の挙動が変わりうる（Phase 5 実施時の視覚ゲート注意点）。
6. **`tauri.conf.json` は `csp: null`、assetProtocol 設定なし。Cargo の tauri features に `protocol-asset` なし**（Phase 5 で必要になる事実の記録。今回は変更しない）。
7. **ディスクキャッシュ（`%APPDATA%\SpicaPhotoViewer\cache\`）はサムネイル JSON のみ。** フル画像の preload はプロセス内メモリ（Zustand の Map）。したがって TTFI_cold は「新規プロセス起動 + サムネイルディスクキャッシュ削除」で定義する。

## Global Constraints

- 対象プラットフォームは **Windows のみ**（`open_with_dialog` 等が Windows 専用）。ベンチも Windows 前提。
- **計測は必ず release ビルド**（`tauri build --no-bundle --features e2e`）。dev ビルドの数値は使わない。
- 計測コードは本番ビルドで **no-op** であること: フロントは `import.meta.env.VITE_PERF_LOG === "1"`（または DEV）でのみ有効、Rust は `SPICA_PERF=1` 実行時のみログ、wdio 用 Rust プラグインは cargo feature `e2e` の背後に置き通常ビルドに含めない。
- 各コミット前に `npm test`（フロント 230+）と `cd src-tauri && cargo test --lib` が green であること。
- **lint/format は hook に任せる**（コミット時に自動実行される。手動で `lint:fix`/`format:fix` を回す手順は入れない）。
- コーパス画像はコミットしない（生成スクリプトのみコミット、`e2e/fixtures/corpus/` は gitignore）。`bench-results/` は `baseline.json` のみコミット。
- Zustand ストアは `.claude/rules/zustand-store.md` に従う（イミュータブル更新、アクション追加時は `AppActions` → 実装 → `testUtils.tsx` のモック → ストアテストの順）。
- パフォーマンス mark 名はスペック §2 の固定名（`open:request` / `ipc:sent` / `ipc:received` / `decode:done` / `paint:done`）を使う。**measure はアプリ内で計算せず、mark の `detail.path` をキーにハーネス側で対応付けて算出する**（スペックからの設計変更。理由: 中断・abort 耐性とアプリ側コードの単純化。Task 1 でスペックにも追記する）。

---

### Task 1: スペック文書の修正（実装前の事実合わせ）

**Files:**
- Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md`

**Interfaces:**
- Consumes: なし
- Produces: 後続タスクが参照する正確なスペック

- [ ] **Step 1: Phase 1 のファイル参照を修正**

`docs/PERFORMANCE_AUTONOMY_PLAN.md` の Phase 1 セクションを以下の内容に書き換える:

- `src/hooks/useImageLoader.ts（存在すれば）` → `src/components/ImageViewer.tsx の loadImage コールバック（invoke("load_image") 呼び出し 4 箇所）`
- `src-tauri/src/commands/image.rs` → `src-tauri/src/commands/file.rs（load_image コマンド）と src-tauri/src/utils/image.rs（decode/encode 実処理）`

- [ ] **Step 2: §2 に measure 算出方針の注記を追加**

§2 の表の直後に追記:

```markdown
> **実装注記**: `measure: ttfi` 等の区間はアプリ内では計算しない。アプリは `detail.path` 付きの mark を `window.__PERF__` に積むだけで、対応付け（同一 path の `open:request` → `paint:done` など）はベンチハーネスがオフラインで行う。ナビゲーション中断や abort が起きても計測が壊れないため。
> また `paint:done` は `detail.thumbnail` フラグを持つ。サムネイル先行表示→フル解像度差し替えの 2 段階描画では、**最初の paint:done（thumbnail 含む）までを TTFI**、`thumbnail: false` の paint までを `TTFI_full` として両方集計する。
```

- [ ] **Step 3: Phase 2 / Phase 6 の記述を修正**

- Phase 2 冒頭「前段の E2E ハーネスを流用し」→「E2E ハーネスは存在しないためここで新規構築し」
- Phase 2 の「`@wdio/tauri-service` の埋め込みプロバイダ、または `tauri-driver` + `msedgedriver`」→「`@wdio/tauri-service` の embedded プロバイダ（Rust 側に `tauri-plugin-wdio-webdriver` を cargo feature `e2e` 付きで追加。外部ドライバ不要、WebView2 とのバージョン整合問題を回避）」
- Phase 6 と §6 の「既存 **137 個の単体テスト**」→「既存の全単体テスト（フロント vitest + Rust cargo test）」

- [ ] **Step 4: TTFI_cold の定義を明確化**

Phase 2 の TTFI_cold 項を修正: 「キャッシュディレクトリをクリア → 先頭画像を開く」→「**新規アプリプロセス起動** + `%APPDATA%\SpicaPhotoViewer\cache\` クリア（ディスク上のサムネイルキャッシュ）の状態で画像を開く。フル画像の preload はプロセス内メモリのため、セッション再起動が cold の必要条件」

- [ ] **Step 5: Commit**

```bash
git add docs/PERFORMANCE_AUTONOMY_PLAN.md
git commit -m "docs: align performance plan with actual codebase structure"
```

---

### Task 2: フロント計時ユーティリティ `src/utils/perf.ts`

**Files:**
- Create: `src/utils/perf.ts`
- Test: `src/utils/__tests__/perf.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `interface PerfEntry { type: "mark" | "event"; name: string; ts: number; detail?: Record<string, unknown> }`
  - `perfMark(name: string, detail?: Record<string, unknown>): void`
  - `perfEvent(name: string, detail?: Record<string, unknown>): void`
  - `isPerfEnabled(): boolean`
  - `_setPerfEnabledForTests(enabled: boolean | null): void`
  - グローバル: `window.__PERF__: PerfEntry[]`

- [ ] **Step 1: 失敗するテストを書く**

`src/utils/__tests__/perf.test.ts`:

```typescript
import { afterEach, describe, expect, it } from "vitest";
import {
  _setPerfEnabledForTests,
  isPerfEnabled,
  perfEvent,
  perfMark,
} from "../perf";

describe("perf", () => {
  afterEach(() => {
    _setPerfEnabledForTests(null);
    window.__PERF__ = [];
  });

  it("records a mark with name, ts, and detail when enabled", () => {
    _setPerfEnabledForTests(true);
    perfMark("open:request", { path: "C:\\img\\a.jpg" });

    expect(window.__PERF__).toHaveLength(1);
    const entry = window.__PERF__?.[0];
    expect(entry?.type).toBe("mark");
    expect(entry?.name).toBe("open:request");
    expect(typeof entry?.ts).toBe("number");
    expect(entry?.detail).toEqual({ path: "C:\\img\\a.jpg" });
  });

  it("records an event entry with type 'event'", () => {
    _setPerfEnabledForTests(true);
    perfEvent("preload", { path: "a.jpg", hit: true });

    expect(window.__PERF__?.[0]?.type).toBe("event");
    expect(window.__PERF__?.[0]?.detail).toEqual({ path: "a.jpg", hit: true });
  });

  it("does nothing when disabled", () => {
    _setPerfEnabledForTests(false);
    perfMark("open:request");
    perfEvent("preload");

    expect(window.__PERF__ ?? []).toHaveLength(0);
  });

  it("appends to an existing buffer without clearing it", () => {
    _setPerfEnabledForTests(true);
    perfMark("first");
    perfMark("second");

    expect(window.__PERF__?.map((e) => e.name)).toEqual(["first", "second"]);
  });

  it("isPerfEnabled reflects the forced test value", () => {
    _setPerfEnabledForTests(true);
    expect(isPerfEnabled()).toBe(true);
    _setPerfEnabledForTests(false);
    expect(isPerfEnabled()).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest --run src/utils/__tests__/perf.test.ts`
Expected: FAIL（`../perf` が存在しない）

- [ ] **Step 3: 実装**

`src/utils/perf.ts`:

```typescript
/**
 * Performance instrumentation utility.
 * Marks are pushed to window.__PERF__ so the E2E bench harness can read them
 * via browser.execute(). Interval pairing (ttfi = open:request -> paint:done)
 * is done offline by the harness, keyed by detail.path — the app never pairs
 * marks itself, so aborted navigations cannot corrupt measurements.
 *
 * Enabled when: DEV build, or release build with VITE_PERF_LOG=1 at build time.
 */

export interface PerfEntry {
  type: "mark" | "event";
  name: string;
  ts: number;
  detail?: Record<string, unknown>;
}

declare global {
  interface Window {
    __PERF__?: PerfEntry[];
  }
}

let forcedEnabled: boolean | null = null;

export const isPerfEnabled = (): boolean => {
  if (forcedEnabled !== null) return forcedEnabled;
  return import.meta.env.DEV || import.meta.env.VITE_PERF_LOG === "1";
};

/** Test-only override. Pass null to restore environment-based detection. */
export const _setPerfEnabledForTests = (enabled: boolean | null): void => {
  forcedEnabled = enabled;
};

const buffer = (): PerfEntry[] => {
  if (!window.__PERF__) {
    window.__PERF__ = [];
  }
  return window.__PERF__;
};

export const perfMark = (
  name: string,
  detail?: Record<string, unknown>,
): void => {
  if (!isPerfEnabled()) return;
  buffer().push({ type: "mark", name, ts: performance.now(), detail });
};

export const perfEvent = (
  name: string,
  detail?: Record<string, unknown>,
): void => {
  if (!isPerfEnabled()) return;
  buffer().push({ type: "event", name, ts: performance.now(), detail });
};
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest --run src/utils/__tests__/perf.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 全テスト実行 + Commit**

Run: `npm test` → 235 tests passed
Run: `npm run type-check` → エラーなし

```bash
git add src/utils/perf.ts src/utils/__tests__/perf.test.ts
git commit -m "feat(perf): add frontend performance mark utility"
```

---

### Task 3: フロント instrumentation の埋め込み + E2E 用テストフック

**Files:**
- Modify: `src/store/index.ts`（`navigateToImage` / `openImageFromPath` に mark、preload ヒット判定に event）
- Modify: `src/components/ImageViewer.tsx`（`ipc:sent`/`ipc:received`/`decode:done`/`paint:done`）
- Modify: `src/hooks/useImagePreloader.ts`（`preload:done` event）
- Create: `src/utils/testHooks.ts`
- Modify: `src/main.tsx`（`installTestHooks()` 呼び出し）
- Test: `src/store/__tests__/index.test.ts` に追記、`src/utils/__tests__/testHooks.test.ts` を新規作成

**Interfaces:**
- Consumes: Task 2 の `perfMark` / `perfEvent` / `isPerfEnabled` / `_setPerfEnabledForTests`
- Produces:
  - mark: `open:request` (`detail: { path, index?, trigger: "nav" | "open" }`)
  - mark: `ipc:sent` / `ipc:received` (`detail: { path }`)
  - mark: `decode:done` / `paint:done` (`detail: { path, thumbnail: boolean }`)
  - event: `preload` (`detail: { path, hit: boolean, thumbnailFallback: boolean }`)
  - event: `preload:done` (`detail: { path }`)
  - グローバル: `window.__SPICA_TEST__ = { openImage(path): Promise<void>; navigateToImage(index): void; navigateNext(): void; getStatus(): { path; index; hasData; isLoading; thumbnailDisplayed; preloadedCount }; clearPerf(): void }`（perf 有効時のみ）

- [ ] **Step 1: ストアの失敗するテストを書く**

`src/store/__tests__/index.test.ts` に describe ブロックを追加（既存のテストヘルパー/セットアップの流儀に合わせて配置すること）:

```typescript
import { _setPerfEnabledForTests } from "../../utils/perf";

describe("performance instrumentation", () => {
  beforeEach(() => {
    _setPerfEnabledForTests(true);
    window.__PERF__ = [];
  });

  afterEach(() => {
    _setPerfEnabledForTests(null);
    window.__PERF__ = [];
  });

  it("navigateToImage marks open:request with path and preload event", () => {
    const store = useAppStore.getState();
    store.setFolderImages("C:\\photos", [
      makeImageInfo("C:\\photos\\a.jpg"),
      makeImageInfo("C:\\photos\\b.jpg"),
    ]);

    store.navigateToImage(1);

    const marks = window.__PERF__ ?? [];
    const open = marks.find((e) => e.name === "open:request");
    expect(open?.detail).toMatchObject({
      path: "C:\\photos\\b.jpg",
      index: 1,
      trigger: "nav",
    });
    const preload = marks.find((e) => e.name === "preload");
    expect(preload?.detail).toMatchObject({
      path: "C:\\photos\\b.jpg",
      hit: false,
    });
  });

  it("navigateToImage reports preload hit when image is preloaded", () => {
    const store = useAppStore.getState();
    store.setFolderImages("C:\\photos", [
      makeImageInfo("C:\\photos\\a.jpg"),
      makeImageInfo("C:\\photos\\b.jpg"),
    ]);
    store.setPreloadedImage("C:\\photos\\b.jpg", {
      path: "C:\\photos\\b.jpg",
      base64: "xxx",
      width: 100,
      height: 100,
      format: "jpeg",
    });

    store.navigateToImage(1);

    const preload = (window.__PERF__ ?? []).find((e) => e.name === "preload");
    expect(preload?.detail).toMatchObject({ hit: true });
  });
});
```

`makeImageInfo` は既存の `src/utils/testFactories.ts` にファクトリがあればそれを使う。無ければ `{ path, filename: path.split("\\").pop() ?? "", size: 1, modified: 0, format: "jpg" }` を返すローカルヘルパーとして定義する。

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest --run src/store/__tests__/index.test.ts`
Expected: 新規 2 件が FAIL（mark が積まれない）、既存は PASS

- [ ] **Step 3: `src/store/index.ts` に mark を埋める**

- import 追加: `import { perfEvent, perfMark } from "../utils/perf";`
- `navigateToImage` の `if (index >= 0 && index < images.length) {` 直後（`const image = images[index];` の後）に:

```typescript
perfMark("open:request", { path: image.path, index, trigger: "nav" });
```

- `navigateToImage` 内の `set((state) => {` の中、`cachedImage` と `thumbnailDisplayed` が確定した直後（`if (cachedImage && ...) { ... } else { ... }` ブロックの後）に:

```typescript
perfEvent("preload", {
  path: image.path,
  hit: !!(cachedImage && cachedImage.format !== "error"),
  thumbnailFallback: thumbnailDisplayed,
});
```

- `openImageFromPath` の `try {` 直後に:

```typescript
perfMark("open:request", { path: imagePath, trigger: "open" });
```

- [ ] **Step 4: ストアテストが通ることを確認**

Run: `npx vitest --run src/store/__tests__/index.test.ts`
Expected: PASS

- [ ] **Step 5: `ImageViewer.tsx` に IPC/描画 mark を埋める**

- import 追加: `import { isPerfEnabled, perfMark } from "../utils/perf";`
- `loadImage` コールバックの直前（コンポーネント内）にラッパーを定義し、`loadImage` 内の 4 箇所の `await invoke<AppImageData>("load_image", { path })` をすべて `await invokeLoadImage(path)` に置き換える:

```typescript
const invokeLoadImage = useCallback(async (path: string) => {
  perfMark("ipc:sent", { path });
  const data = await invoke<AppImageData>("load_image", { path });
  perfMark("ipc:received", { path });
  return data;
}, []);
```

（`loadImage` の useCallback 依存配列に `invokeLoadImage` を追加する。）

- `paint:done` / `decode:done` 用の effect を追加（`// Handle window resize` の effect の前あたり）:

```typescript
// Perf instrumentation: mark decode:done / paint:done when displayed data changes.
// Double rAF approximates the first frame actually painted with the new image.
useEffect(() => {
  const data = currentImage.data;
  if (!data || !isPerfEnabled()) return;
  const thumbnail = useAppStore.getState().ui.thumbnailDisplayed;
  let cancelled = false;

  const markPaint = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) {
          perfMark("paint:done", { path: data.path, thumbnail });
        }
      });
    });
  };

  const img = imageRef.current;
  if (img?.decode) {
    img
      .decode()
      .then(() => {
        if (!cancelled) perfMark("decode:done", { path: data.path, thumbnail });
      })
      .catch(() => {
        /* decode() rejects for data-URL races; paint mark still fires */
      })
      .finally(markPaint);
  } else {
    markPaint();
  }

  return () => {
    cancelled = true;
  };
}, [currentImage.data]);
```

- [ ] **Step 6: `useImagePreloader.ts` に preload 完了 event を追加**

- import 追加: `import { perfEvent } from "../utils/perf";`
- `preloadImage` 内、`setPreloadedImage(imagePath, imageData);` の直後に:

```typescript
perfEvent("preload:done", { path: imagePath });
```

- [ ] **Step 7: テストフックの失敗するテストを書く**

`src/utils/__tests__/testHooks.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _setPerfEnabledForTests } from "../perf";
import { installTestHooks } from "../testHooks";

describe("testHooks", () => {
  beforeEach(() => {
    window.__SPICA_TEST__ = undefined;
    window.__PERF__ = [];
  });

  afterEach(() => {
    _setPerfEnabledForTests(null);
  });

  it("installs window.__SPICA_TEST__ when perf is enabled", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    expect(window.__SPICA_TEST__).toBeDefined();
    expect(typeof window.__SPICA_TEST__?.openImage).toBe("function");
    expect(typeof window.__SPICA_TEST__?.getStatus).toBe("function");
  });

  it("does not install hooks when perf is disabled", () => {
    _setPerfEnabledForTests(false);
    installTestHooks();
    expect(window.__SPICA_TEST__).toBeUndefined();
  });

  it("getStatus reflects store state and clearPerf empties the buffer", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    window.__PERF__ = [{ type: "mark", name: "x", ts: 1 }];

    const status = window.__SPICA_TEST__?.getStatus();
    expect(status).toMatchObject({ index: -1, hasData: false });

    window.__SPICA_TEST__?.clearPerf();
    expect(window.__PERF__).toHaveLength(0);
  });
});
```

- [ ] **Step 8: テストフックを実装**

`src/utils/testHooks.ts`:

```typescript
/**
 * E2E test hooks. Only installed in perf-enabled builds (dev, or
 * VITE_PERF_LOG=1). The bench harness drives the app through these via
 * browser.execute() instead of simulating UI input, which keeps the
 * measured interval (open:request -> paint:done) identical to real usage.
 */
import { useAppStore } from "../store";
import { isPerfEnabled } from "./perf";

export interface SpicaTestHooks {
  openImage: (path: string) => Promise<void>;
  navigateToImage: (index: number) => void;
  navigateNext: () => void;
  getStatus: () => {
    path: string;
    index: number;
    hasData: boolean;
    isLoading: boolean;
    thumbnailDisplayed: boolean;
    preloadedCount: number;
  };
  clearPerf: () => void;
}

declare global {
  interface Window {
    __SPICA_TEST__?: SpicaTestHooks;
  }
}

export const installTestHooks = (): void => {
  if (!isPerfEnabled()) return;
  window.__SPICA_TEST__ = {
    openImage: (path) => useAppStore.getState().openImageFromPath(path),
    navigateToImage: (index) => useAppStore.getState().navigateToImage(index),
    navigateNext: () => useAppStore.getState().navigateNext(),
    getStatus: () => {
      const state = useAppStore.getState();
      return {
        path: state.currentImage.path,
        index: state.currentImage.index,
        hasData: state.currentImage.data !== null,
        isLoading: state.ui.isLoading,
        thumbnailDisplayed: state.ui.thumbnailDisplayed,
        preloadedCount: state.cache.preloaded.size,
      };
    },
    clearPerf: () => {
      window.__PERF__ = [];
    },
  };
};
```

`src/main.tsx` の ReactDOM render より前に追加:

```typescript
import { installTestHooks } from "./utils/testHooks";

installTestHooks();
```

- [ ] **Step 9: 全テスト + 型チェック確認、Commit**

Run: `npm test` → 全件 PASS（新規分を含む）
Run: `npm run type-check` → エラーなし

```bash
git add src/store/index.ts src/components/ImageViewer.tsx src/hooks/useImagePreloader.ts src/utils/testHooks.ts src/main.tsx src/store/__tests__/index.test.ts src/utils/__tests__/testHooks.test.ts
git commit -m "feat(perf): instrument image open/navigation path and add E2E test hooks"
```

- [ ] **Step 10: 手動スモーク（Phase 1 完了条件）**

Run: `npm run tauri dev` で起動し、画像を 1 枚開いて数回ナビゲーション。DevTools コンソールで `window.__PERF__` に `open:request` / `ipc:sent` / `ipc:received` / `decode:done` / `paint:done` / `preload` が入っていることを確認（DEV ビルドでは perf は常時有効）。確認できたら `docs/PERFORMANCE_AUTONOMY_PLAN.md` の Phase 1 のフロント側チェックボックスを更新してコミットに含める（次タスクのコミットでも可）。

---

### Task 4: Rust 側計時（`SPICA_PERF=1` で JSON 1 行ログ）

**Files:**
- Create: `src-tauri/src/utils/perf.rs`
- Modify: `src-tauri/src/utils/mod.rs`（`pub mod perf;` 追加）
- Modify: `src-tauri/src/utils/image.rs`（decode/encode/base64 の区間計時）
- Modify: `src-tauri/src/commands/file.rs`（`load_image` 全体の計時）

**Interfaces:**
- Consumes: なし
- Produces:
  - `PerfTimer::start(op: &'static str, path: &str) -> Option<PerfTimer>`（Drop で stderr に JSON 1 行）
  - `format_perf_line(op: &str, path: &str, ms: f64) -> String`
  - ログ形式: `{"perf":"rust","op":"decode","path":"C:\\...\\a.jpg","ms":123.45}`
  - op 一覧: `load_image`（コマンド全体）, `read_raw`（GIF 経路）, `decode`, `encode`, `base64`

- [ ] **Step 1: 失敗するテストを書く**

`src-tauri/src/utils/perf.rs` を作成し、まずテストのみ書く（実装は todo!() でよい）:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_perf_line_is_valid_json() {
        let line = format_perf_line("decode", r"C:\photos\a.jpg", 123.456);
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["perf"], "rust");
        assert_eq!(parsed["op"], "decode");
        assert_eq!(parsed["path"], r"C:\photos\a.jpg");
        assert!((parsed["ms"].as_f64().unwrap() - 123.46).abs() < 0.01);
    }

    #[test]
    fn test_timer_disabled_without_env_var() {
        // SPICA_PERF is not set in the test environment
        assert!(PerfTimer::start("decode", "x.jpg").is_none());
    }
}
```

- [ ] **Step 2: テストが失敗（コンパイルエラー）することを確認**

Run: `cd src-tauri && cargo test --lib utils::perf`
Expected: FAIL（`format_perf_line` / `PerfTimer` 未定義）

- [ ] **Step 3: 実装**

`src-tauri/src/utils/perf.rs` の本体:

```rust
//! Lightweight perf logging for bench runs. Enabled only when the process is
//! launched with SPICA_PERF=1; completely silent otherwise. One JSON object
//! per line on stderr so the bench harness (or a human) can grep/parse it.

use std::sync::OnceLock;
use std::time::Instant;

fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("SPICA_PERF").map(|v| v == "1").unwrap_or(false)
    })
}

pub fn format_perf_line(op: &str, path: &str, ms: f64) -> String {
    format!(
        r#"{{"perf":"rust","op":{},"path":{},"ms":{:.2}}}"#,
        serde_json::to_string(op).unwrap_or_else(|_| "\"?\"".into()),
        serde_json::to_string(path).unwrap_or_else(|_| "\"?\"".into()),
        ms
    )
}

pub struct PerfTimer {
    op: &'static str,
    path: String,
    start: Instant,
}

impl PerfTimer {
    pub fn start(op: &'static str, path: &str) -> Option<Self> {
        if !enabled() {
            return None;
        }
        Some(Self {
            op,
            path: path.to_string(),
            start: Instant::now(),
        })
    }
}

impl Drop for PerfTimer {
    fn drop(&mut self) {
        let ms = self.start.elapsed().as_secs_f64() * 1000.0;
        eprintln!("{}", format_perf_line(self.op, &self.path, ms));
    }
}
```

`src-tauri/src/utils/mod.rs` に `pub mod perf;` を追加。

- [ ] **Step 4: テストが通ることを確認**

Run: `cd src-tauri && cargo test --lib utils::perf`
Expected: PASS（2 tests）

- [ ] **Step 5: 計時を埋め込む**

`src-tauri/src/utils/image.rs` の `load_image_as_base64` を以下に書き換え（ロジックは不変、区間計時のみ追加）:

```rust
use crate::utils::perf::PerfTimer;

pub fn load_image_as_base64(path: &Path) -> Result<String, ImageError> {
    let path_str = path.to_string_lossy();

    // For GIF files, read the original file to preserve animation
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        if ext.to_lowercase() == "gif" {
            let _t = PerfTimer::start("read_raw", &path_str);
            let file_data = std::fs::read(path).map_err(ImageError::IoError)?;
            return Ok(general_purpose::STANDARD.encode(&file_data));
        }
    }

    // For other formats, use image processing
    let img = {
        let _t = PerfTimer::start("decode", &path_str);
        image::open(path)?
    };

    let mut buffer = Vec::new();
    let format = get_image_format(path).unwrap_or(ImageFormat::Jpeg);
    {
        let _t = PerfTimer::start("encode", &path_str);
        img.write_to(&mut std::io::Cursor::new(&mut buffer), format)?;
    }

    let _t = PerfTimer::start("base64", &path_str);
    Ok(general_purpose::STANDARD.encode(&buffer))
}
```

`src-tauri/src/commands/file.rs` の `load_image` 冒頭（`validate_image_path` の後）に:

```rust
let _t = crate::utils::perf::PerfTimer::start("load_image", &path);
```

- [ ] **Step 6: Rust 全テスト確認、Commit**

Run: `cd src-tauri && cargo test --lib`
Expected: 全件 PASS

```bash
git add src-tauri/src/utils/perf.rs src-tauri/src/utils/mod.rs src-tauri/src/utils/image.rs src-tauri/src/commands/file.rs
git commit -m "feat(perf): add SPICA_PERF-gated timing logs to image load pipeline"
```

`docs/PERFORMANCE_AUTONOMY_PLAN.md` の Phase 1 の Rust チェックボックスを更新して同コミットに含める。

---

### Task 5: E2E ハーネス骨格（WebdriverIO + `@wdio/tauri-service`）

**Files:**
- Modify: `package.json`（devDeps + scripts）
- Modify: `src-tauri/Cargo.toml`（feature `e2e` + `tauri-plugin-wdio-webdriver`）
- Modify: `src-tauri/src/lib.rs`（feature 付きプラグイン登録）
- Create: `e2e/wdio.conf.ts`
- Create: `e2e/tsconfig.json`
- Create: `e2e/specs/smoke.e2e.ts`
- Create: `e2e/scripts/build-bench.mjs`
- Modify: `.gitignore`（`bench-results/` 追記は Task 7 でまとめて可）

**Interfaces:**
- Consumes: Task 3 の `window.__SPICA_TEST__` / `window.__PERF__`
- Produces: `npm run bench:build`（perf 有効 release ビルド）、`npm run test:e2e`（スモーク）、後続タスクが使う wdio 設定

**注意:** `@wdio/tauri-service` / `tauri-plugin-wdio-webdriver` の正確なバージョン・オプション名は実装時に必ず公式ドキュメント（https://webdriver.io/docs/desktop-testing/tauri と https://v2.tauri.app/develop/tests/webdriver/）で確認すること。以下は 2026-08 時点の情報に基づく。

- [ ] **Step 1: npm 依存を追加**

```bash
npm install --save-dev @wdio/cli @wdio/local-runner @wdio/mocha-framework @wdio/spec-reporter @wdio/tauri-service tsx
```

- [ ] **Step 2: Rust 側に wdio プラグインを feature 付きで追加**

`src-tauri/Cargo.toml`:

```toml
[dependencies]
# ...既存の依存はそのまま...
tauri-plugin-wdio-webdriver = { version = "1", optional = true }

[features]
e2e = ["dep:tauri-plugin-wdio-webdriver"]
```

`src-tauri/src/lib.rs` の `run()` 内、`tauri::Builder::default()` のチェーンを変数に受けて条件付きでプラグイン登録:

```rust
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .invoke_handler(tauri::generate_handler![
            // ...既存のまま...
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Run: `cd src-tauri && cargo check` と `cargo check --features e2e` の両方が通ること。

- [ ] **Step 3: ベンチ用ビルドスクリプト**

`e2e/scripts/build-bench.mjs`:

```javascript
// Builds a release binary with perf instrumentation and the embedded
// WebDriver plugin enabled. VITE_PERF_LOG=1 is a build-time flag (frontend);
// SPICA_PERF=1 is set at runtime by wdio.conf.ts.
import { execSync } from "node:child_process";

execSync("npm run tauri build -- --no-bundle --features e2e", {
  stdio: "inherit",
  env: { ...process.env, VITE_PERF_LOG: "1" },
});
```

- [ ] **Step 4: wdio 設定とスモークスペック**

`e2e/wdio.conf.ts`:

```typescript
import { join } from "node:path";

const appBinaryPath = join(
  import.meta.dirname,
  "../src-tauri/target/release/spica-photo-viewer.exe",
);

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.ts"],
  maxInstances: 1,
  services: [
    [
      "tauri",
      {
        appBinaryPath,
        driverProvider: "embedded",
      },
    ],
  ],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 180000 },
  onPrepare: () => {
    // Runtime flag for the Rust-side perf logging in the launched app
    process.env.SPICA_PERF = "1";
  },
};
```

`e2e/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["node", "@wdio/globals/types", "@wdio/mocha-framework"],
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["./**/*.ts"]
}
```

`e2e/specs/smoke.e2e.ts`:

```typescript
import { browser, expect } from "@wdio/globals";

describe("smoke", () => {
  it("launches the app and exposes perf/test hooks", async () => {
    const hooks = await browser.execute(() => ({
      hasTestHooks: typeof window.__SPICA_TEST__ !== "undefined",
      hasPerfBuffer: Array.isArray(window.__PERF__ ?? []),
    }));
    expect(hooks.hasTestHooks).toBe(true);
    expect(hooks.hasPerfBuffer).toBe(true);
  });
});
```

（`window.__SPICA_TEST__` の型は wdio 側では `browser.execute` 内で `as any` を避けるため、`e2e/types.d.ts` を作り Task 3 と同じ `declare global` を複製してよい。）

- [ ] **Step 5: npm scripts 追加**

`package.json` の scripts に追加:

```jsonc
{
  "bench:build": "node e2e/scripts/build-bench.mjs",
  "test:e2e": "wdio run e2e/wdio.conf.ts --spec e2e/specs/smoke.e2e.ts"
}
```

- [ ] **Step 6: 動作確認**

Run: `npm run bench:build`（初回は release ビルドで数分かかる）
Run: `npm run test:e2e`
Expected: スモークスペック 1 件 PASS（アプリが起動し、release ビルドでもテストフックが生えている = `VITE_PERF_LOG=1` が効いている証明）

失敗した場合は superpowers:systematic-debugging に従うこと。典型的な原因: サービス/プラグインのオプション名の相違（公式ドキュメント再確認）、バイナリパス相違（`src-tauri/target/release/` 配下の実際の exe 名を確認）。

- [ ] **Step 7: 全テスト確認、Commit**

Run: `npm test` / `cd src-tauri && cargo test --lib` → PASS

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs e2e/
git commit -m "feat(e2e): add WebdriverIO tauri harness with e2e-gated webdriver plugin"
```

---

### Task 6: 固定コーパス生成スクリプト

**Files:**
- Create: `e2e/scripts/generate-corpus.mjs`
- Modify: `.gitignore`（`e2e/fixtures/corpus/` 追加）
- Modify: `package.json`（scripts に `bench:corpus`）

**Interfaces:**
- Consumes: なし
- Produces: `e2e/fixtures/corpus/{small,medium,large}/img-NNN.jpg`
  - small: 1024×768（約 0.8MP）× 8 枚
  - medium: 3264×2448（約 8MP）× 30 枚（NAV テストで ±5 preload 範囲外へジャンプするため多め）
  - large: 5472×3648（約 20MP）× 8 枚
  - シード付き決定論的生成（同じスクリプトから常に同一バイト列）

- [ ] **Step 1: sharp を追加**

```bash
npm install --save-dev sharp
```

- [ ] **Step 2: 生成スクリプトを書く**

`e2e/scripts/generate-corpus.mjs`:

```javascript
// Deterministic bench corpus generator. Images are gradient+noise so JPEG
// decode cost is realistic (pure flat color compresses to nothing and would
// make decode artificially cheap). Never commit the generated files.
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const OUT = join(import.meta.dirname, "../fixtures/corpus");

// mulberry32: tiny seeded PRNG, deterministic across runs/platforms
const mulberry32 = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SETS = [
  { name: "small", width: 1024, height: 768, count: 8 },
  { name: "medium", width: 3264, height: 2448, count: 30 },
  { name: "large", width: 5472, height: 3648, count: 8 },
];

for (const { name, width, height, count } of SETS) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const file = join(dir, `img-${String(i).padStart(3, "0")}.jpg`);
    if (existsSync(file)) continue;
    const rand = mulberry32(name.length * 1000 + i);
    const raw = Buffer.alloc(width * height * 3);
    for (let p = 0; p < raw.length; p += 3) {
      const x = (p / 3) % width;
      const y = Math.floor(p / 3 / width);
      raw[p] = (x * 255) / width + rand() * 40;
      raw[p + 1] = (y * 255) / height + rand() * 40;
      raw[p + 2] = ((x + y) * 128) / (width + height) + rand() * 40;
    }
    await sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 88 })
      .toFile(file);
    console.log(`generated ${file}`);
  }
}
console.log("corpus ready");
```

- [ ] **Step 3: gitignore と script 追加**

`.gitignore` に追記:

```
e2e/fixtures/corpus/
```

`package.json` scripts に追加:

```jsonc
{
  "bench:corpus": "node e2e/scripts/generate-corpus.mjs"
}
```

- [ ] **Step 4: 生成確認**

Run: `npm run bench:corpus`
Expected: 46 枚の JPEG が生成される（20MP 級の生成は数十秒かかる）。エクスプローラーまたは `Get-ChildItem e2e/fixtures/corpus -Recurse | Measure-Object` で 46 ファイルを確認。

- [ ] **Step 5: Commit**

```bash
git add e2e/scripts/generate-corpus.mjs .gitignore package.json package-lock.json
git commit -m "feat(e2e): add deterministic bench corpus generator"
```

---

### Task 7: ベンチスペックと結果集計

**Files:**
- Create: `e2e/lib/stats.ts`
- Test: `e2e/lib/stats.test.ts`（vitest で実行される）
- Create: `e2e/specs/bench.perf.ts`
- Create: `e2e/scripts/save-baseline.mjs`
- Modify: `package.json`（`bench` / `bench:baseline`）
- Modify: `.gitignore`（`bench-results/` を ignore、`!bench-results/baseline.json` で除外）

**Interfaces:**
- Consumes: Task 3 の mark 名と `window.__SPICA_TEST__`、Task 5 の wdio 設定、Task 6 のコーパス
- Produces:
  - `median(values: number[]): number` / `p95(values: number[]): number`（`e2e/lib/stats.ts`）
  - `bench-results/<git-sha>-<timestamp>.json`（スキーマはスペック §4。`TTFI_cold` に `ttfi_first_paint` と `ttfi_full` の両方を含める）
  - `npm run bench` / `npm run bench:baseline`

- [ ] **Step 1: stats の失敗するテストを書く**

`e2e/lib/stats.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { median, p95 } from "./stats";

describe("stats", () => {
  it("median of odd-length array is the middle value", () => {
    expect(median([5, 1, 3])).toBe(3);
  });
  it("median of even-length array averages the two middle values", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("p95 returns the value at the 95th percentile (nearest-rank)", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(p95(values)).toBe(95);
  });
  it("p95 of a short array returns the max", () => {
    expect(p95([10, 30, 20])).toBe(30);
  });
  it("throws on empty input", () => {
    expect(() => median([])).toThrow();
    expect(() => p95([])).toThrow();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest --run e2e/lib/stats.test.ts`
Expected: FAIL（vitest がこのパスを include していない場合は `vite.config.ts`/`vitest` 設定の `test.include` に `e2e/lib/**/*.test.ts` を追加する）

- [ ] **Step 3: 実装**

`e2e/lib/stats.ts`:

```typescript
export const median = (values: number[]): number => {
  if (values.length === 0) throw new Error("median of empty array");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const p95 = (values: number[]): number => {
  if (values.length === 0) throw new Error("p95 of empty array");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
};
```

Run: `npx vitest --run e2e/lib/stats.test.ts` → PASS

- [ ] **Step 4: ベンチスペックを書く**

`e2e/specs/bench.perf.ts`（核心部。ヘルパーは同ファイル内に置く）:

```typescript
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browser } from "@wdio/globals";
import { median, p95 } from "../lib/stats.ts";

const N = 7;
const CORPUS = join(import.meta.dirname, "../fixtures/corpus");
const RESULTS_DIR = join(import.meta.dirname, "../../bench-results");
const THUMB_CACHE = join(
  process.env.APPDATA ?? "",
  "SpicaPhotoViewer",
  "cache",
);

type PerfEntry = {
  type: string;
  name: string;
  ts: number;
  detail?: Record<string, unknown>;
};

const corpusFiles = (set: string): string[] =>
  readdirSync(join(CORPUS, set))
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .map((f) => join(CORPUS, set, f));

const getPerf = (): Promise<PerfEntry[]> =>
  browser.execute(() => (window as any).__PERF__ ?? []);

const clearPerf = (): Promise<void> =>
  browser.execute(() => (window as any).__SPICA_TEST__.clearPerf());

const openImage = (path: string): Promise<void> =>
  browser.execute(
    (p: string) => (window as any).__SPICA_TEST__.openImage(p),
    path,
  );

const navigateToImage = (index: number): Promise<void> =>
  browser.execute(
    (i: number) => (window as any).__SPICA_TEST__.navigateToImage(i),
    index,
  );

/** Wait until a full-resolution paint:done exists for `path`, return entries. */
const waitForFullPaint = async (path: string): Promise<PerfEntry[]> => {
  await browser.waitUntil(
    async () =>
      (await getPerf()).some(
        (e) =>
          e.name === "paint:done" &&
          e.detail?.path === path &&
          e.detail?.thumbnail === false,
      ),
    { timeout: 60000, timeoutMsg: `no full paint:done for ${path}` },
  );
  return getPerf();
};

/** ttfi from the open:request for `path` to first / full paint:done. */
const extractTtfi = (
  entries: PerfEntry[],
  path: string,
): { firstPaint: number; fullPaint: number; ipc: number | null } => {
  const open = entries.find(
    (e) => e.name === "open:request" && e.detail?.path === path,
  );
  const paints = entries.filter(
    (e) => e.name === "paint:done" && e.detail?.path === path,
  );
  const full = paints.find((e) => e.detail?.thumbnail === false);
  if (!open || paints.length === 0 || !full) {
    throw new Error(`incomplete marks for ${path}`);
  }
  const sent = entries.find(
    (e) => e.name === "ipc:sent" && e.detail?.path === path,
  );
  const received = entries.find(
    (e) => e.name === "ipc:received" && e.detail?.path === path,
  );
  return {
    firstPaint: paints[0].ts - open.ts,
    fullPaint: full.ts - open.ts,
    ipc: sent && received ? received.ts - sent.ts : null,
  };
};

const waitForPreloadSettled = async (minCount: number): Promise<void> => {
  await browser.waitUntil(
    async () => {
      const status = await browser.execute(() =>
        (window as any).__SPICA_TEST__.getStatus(),
      );
      return status.preloadedCount >= minCount;
    },
    { timeout: 120000, timeoutMsg: "preload never settled" },
  );
};

describe("bench", () => {
  const results: Record<string, number[]> = {
    TTFI_cold_first: [],
    TTFI_cold_full: [],
    TTFI_cold_ipc: [],
    NAV_warm: [],
    NAV_cold: [],
  };

  it("TTFI_cold (large corpus, fresh session per run)", async () => {
    const files = corpusFiles("large");
    for (let i = 0; i < N; i++) {
      rmSync(THUMB_CACHE, { recursive: true, force: true });
      await browser.reloadSession(); // fresh app process = cold in-memory caches
      await clearPerf();
      const target = files[i % files.length];
      await openImage(target);
      const entries = await waitForFullPaint(target);
      const { firstPaint, fullPaint, ipc } = extractTtfi(entries, target);
      results.TTFI_cold_first.push(firstPaint);
      results.TTFI_cold_full.push(fullPaint);
      if (ipc !== null) results.TTFI_cold_ipc.push(ipc);
    }
  });

  it("NAV_warm (medium corpus, sequential with preload hits)", async () => {
    const files = corpusFiles("medium");
    await browser.reloadSession();
    await openImage(files[0]);
    await waitForFullPaint(files[0]);
    await waitForPreloadSettled(5); // PRELOAD_RANGE=5 forward images ready

    for (let step = 1; step <= N; step++) {
      await clearPerf();
      await navigateToImage(step);
      const entries = await waitForFullPaint(files[step]);
      const preload = entries.find(
        (e) => e.name === "preload" && e.detail?.path === files[step],
      );
      if (preload?.detail?.hit !== true) {
        console.warn(`NAV_warm step ${step}: preload MISS — excluded`);
        await waitForPreloadSettled(5);
        continue;
      }
      results.NAV_warm.push(extractTtfi(entries, files[step]).fullPaint);
      // Let the preloader top up before the next step
      await waitForPreloadSettled(5);
    }
  });

  it("NAV_cold (medium corpus, far jumps outside preload range)", async () => {
    const files = corpusFiles("medium");
    // Continue in the same session; jump far beyond ±5 preload range each time
    let index = 0;
    for (let i = 0; i < N; i++) {
      index = (index + 13) % files.length; // stride > 2*PRELOAD_RANGE
      await clearPerf();
      await navigateToImage(index);
      const entries = await waitForFullPaint(files[index]);
      const preload = entries.find(
        (e) => e.name === "preload" && e.detail?.path === files[index],
      );
      if (preload?.detail?.hit === true) {
        console.warn(`NAV_cold run ${i}: unexpected preload HIT — excluded`);
        continue;
      }
      results.NAV_cold.push(extractTtfi(entries, files[index]).fullPaint);
    }
  });

  after(() => {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const sha = execSync("git rev-parse --short HEAD").toString().trim();
    const timestamp = new Date().toISOString();
    const summarize = (v: number[]) =>
      v.length > 0
        ? { median_ms: median(v), p95_ms: p95(v), n: v.length }
        : { median_ms: null, p95_ms: null, n: 0 };
    const out = {
      gitSha: sha,
      timestamp,
      buildProfile: "release",
      runs: N,
      corpus: ["small", "medium", "large"],
      metrics: {
        TTFI_cold: {
          ...summarize(results.TTFI_cold_first),
          full: summarize(results.TTFI_cold_full),
        },
        NAV_warm: summarize(results.NAV_warm),
        NAV_cold: summarize(results.NAV_cold),
        breakdown: {
          ipc_cold: summarize(results.TTFI_cold_ipc),
        },
      },
    };
    const file = join(
      RESULTS_DIR,
      `${sha}-${timestamp.replace(/[:.]/g, "-")}.json`,
    );
    writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`bench results written to ${file}`);
    console.log(JSON.stringify(out.metrics, null, 2));
  });
});
```

実装時の注意:
- `browser.reloadSession()` が tauri-service でアプリ再起動になることを確認する。ならない場合のフォールバック: TTFI_cold だけ別スペックに分け、外側スクリプト（`e2e/scripts/run-cold.mjs`）で wdio を N 回起動し、1 回 1 計測の JSON を追記合成する。
- `decode:done` の内訳（`ipc:received` → `decode:done`）も同じ `extractTtfi` の要領で `breakdown.decode_cold` として追加してよい。

- [ ] **Step 5: save-baseline スクリプトと scripts 追加**

`e2e/scripts/save-baseline.mjs`:

```javascript
// Copies the newest bench result to bench-results/baseline.json.
import { copyFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "../../bench-results");
const newest = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && f !== "baseline.json")
  .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];

if (!newest) throw new Error("no bench results found");
copyFileSync(join(dir, newest.f), join(dir, "baseline.json"));
console.log(`baseline.json <- ${newest.f}`);
```

`package.json` scripts:

```jsonc
{
  "bench": "wdio run e2e/wdio.conf.ts --spec e2e/specs/bench.perf.ts",
  "bench:baseline": "npm run bench && node e2e/scripts/save-baseline.mjs"
}
```

`.gitignore` に追記:

```
bench-results/*
!bench-results/baseline.json
```

- [ ] **Step 6: 動作確認**

Run: `npm run bench:corpus`（未生成なら）→ `npm run bench:build` → `npm run bench`
Expected: 3 ケースが実行され `bench-results/<sha>-<ts>.json` が生成される。TTFI_cold の値がスペック §8 の記入に使える形（median/p95）で出力される。

- [ ] **Step 7: 全テスト確認、Commit**

Run: `npm test`（stats テスト含む）→ PASS

```bash
git add e2e/ package.json package-lock.json .gitignore
git commit -m "feat(bench): add performance bench spec with median/p95 aggregation"
```

`docs/PERFORMANCE_AUTONOMY_PLAN.md` の Phase 2 チェックボックスを更新して同コミットに含める。

---

### Task 8: 視覚ゲート（表示崩れ検出 E2E）

**Files:**
- Create: `e2e/specs/visual.e2e.ts`
- Modify: `package.json`（`test:e2e` の spec 指定を smoke + visual に拡張）

**Interfaces:**
- Consumes: Task 5 のハーネス、Task 6 のコーパス、Task 3 のテストフック
- Produces: `npm run test:e2e` で「画像が実際に画面に描画されている」ことの自動検証（Phase 6 の視覚ゲート）

- [ ] **Step 1: 視覚スペックを書く**

`e2e/specs/visual.e2e.ts`:

```typescript
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { browser, expect } from "@wdio/globals";
import sharp from "sharp";

const CORPUS = join(import.meta.dirname, "../fixtures/corpus");
const SHOTS = join(import.meta.dirname, "../screenshots");

describe("visual gate", () => {
  it("renders a large image without blank output", async () => {
    const files = readdirSync(join(CORPUS, "large")).sort();
    const target = join(CORPUS, "large", files[0]);

    await browser.execute(
      (p: string) => (window as any).__SPICA_TEST__.openImage(p),
      target,
    );
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const img = document.querySelector(".image-viewer img");
          return (
            img instanceof HTMLImageElement &&
            img.naturalWidth > 0 &&
            img.getBoundingClientRect().width > 100
          );
        }),
      { timeout: 60000, timeoutMsg: "image element never became visible" },
    );

    mkdirSync(SHOTS, { recursive: true });
    const shot = join(SHOTS, "visual-large.png");
    await browser.saveScreenshot(shot);

    // A correctly rendered gradient corpus image has high pixel variance;
    // a blank/black/white window does not.
    const stats = await sharp(shot).stats();
    const maxStdev = Math.max(...stats.channels.map((c) => c.stdev));
    expect(maxStdev).toBeGreaterThan(15);
  });

  it("navigation keeps the image visible", async () => {
    await browser.execute(() => (window as any).__SPICA_TEST__.navigateNext());
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const img = document.querySelector(".image-viewer img");
          return img instanceof HTMLImageElement && img.naturalWidth > 0;
        }),
      { timeout: 60000 },
    );
  });
});
```

`e2e/screenshots/` を `.gitignore` に追加。

- [ ] **Step 2: `test:e2e` を全 E2E スペック実行に変更**

`package.json`: `"test:e2e": "wdio run e2e/wdio.conf.ts --spec e2e/specs/smoke.e2e.ts --spec e2e/specs/visual.e2e.ts"`
（bench.perf.ts は `npm run bench` 専用のまま分離しておく。）

- [ ] **Step 3: 動作確認、Commit**

Run: `npm run test:e2e` → smoke + visual PASS

```bash
git add e2e/specs/visual.e2e.ts package.json .gitignore
git commit -m "feat(e2e): add visual regression gate for image rendering"
```

---

### Task 9: baseline 確定と運用ルールの整備（Phase 3 + Phase 6 準備）

**Files:**
- Create: `bench-results/baseline.json`（bench 実行結果）
- Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md`（§8 の baseline 表、進捗チェックリスト）
- Modify: `CLAUDE.md`（Performance changes 運用ルール）

**Interfaces:**
- Consumes: Task 7 の `npm run bench:baseline`
- Produces: 以降の最適化プランが比較基準にする `bench-results/baseline.json` と CLAUDE.md のゲート運用ルール

- [ ] **Step 1: baseline を計測**

他のアプリを閉じ、電源接続状態で実行（ノイズ対策）:

Run: `npm run bench:corpus`（生成済みならスキップされる）
Run: `npm run bench:build`
Run: `npm run bench:baseline`
Expected: `bench-results/baseline.json` が生成される

- [ ] **Step 2: §8 の表を実測値で埋める**

`docs/PERFORMANCE_AUTONOMY_PLAN.md` §8 の `_TBD_` を baseline.json の値で置換。TTFI_cold は first paint と full paint を両方記載する。Phase 1〜3 のチェックボックスと §9 サマリを更新する。

- [ ] **Step 3: CLAUDE.md に運用ルールを追記**

`CLAUDE.md` 末尾に追加（スペック §6 の案を実測に合わせて修正した版）:

```markdown
## Performance changes

- パフォーマンス関連の変更後は、必ず `npm run bench:build && npm run bench` を実行する（release ビルド、N=7、中央値/p95）。
- `bench-results/baseline.json` と比較し、以下を**すべて**満たす場合のみ採用する:
  - 対象指標の中央値が baseline 比 **10% 以上改善**
  - 他の指標が p95 の揺れを超えて悪化していない
  - `npm test` と `cd src-tauri && cargo test --lib` が全件 green
  - `npm run test:e2e`（視覚ゲート含む）が green
- 満たさない変更は `git revert` する。
- 最適化前に必ず profiling（`SPICA_PERF=1` の Rust ログと `__PERF__` の ipc/decode 内訳）で支配的ボトルネックを特定し、1 コミット 1 仮説とする。当て推量での複数同時変更は禁止。
- 採用時は `npm run bench:baseline` で `baseline.json` を更新し、同じコミットに含める。
```

- [ ] **Step 4: Commit**

```bash
git add bench-results/baseline.json docs/PERFORMANCE_AUTONOMY_PLAN.md CLAUDE.md
git commit -m "feat(bench): record performance baseline and adoption gate rules"
```

---

## このプランの後（別プラン: Phase 4〜5）

baseline の内訳（`ipc` vs `decode`、Rust 側の `decode`/`encode`/`base64` ログ)を見て支配区間を 1 つ特定してから、最適化プランを新規作成する。調査済みの有力仮説と必要な事実:

- **base64 IPC 撤廃（asset protocol 化）**: `load_image` の「フルデコード→再エンコード→base64」を `convertFileSrc` に置換。必要な変更: Cargo `tauri` features に `protocol-asset` 追加、`tauri.conf.json` に `app.security.assetProtocol: { enable: true, scope: [...] }` と CSP `img-src 'self' asset: http://asset.localhost` 追加。寸法取得は既存の `get_image_dimensions`（ヘッダ読みのみで安価）を流用。**注意**: 現状は再エンコードで EXIF が落ちているが、asset protocol では原本バイトが WebView に渡り EXIF 回転が適用されるため、回転付き JPEG で表示が変わる（視覚ゲートのコーパスに EXIF 回転画像を足して検証すること）。preload 戦略も `<img src>` 保持から `Image`/`createImageBitmap` ベースへの変更が必要。
- 中間案（低リスク）: 再エンコードをやめ原本バイトをそのまま base64 する（GIF が既にこの経路）。デコード+エンコードのコストが消え、IPC コストのみ残る。

## Self-Review 済み事項

- スペック Phase 1→Task 2-4、Phase 2→Task 5-8、Phase 3→Task 9、§5 scripts→Task 5/7、§6 CLAUDE.md→Task 9 でカバー。Phase 4-6 の実行は運用フェーズ（このプランのスコープ外、ルールは Task 9 で整備済み）。
- mark 名はスペック §2 の固定名と一致（measure のみハーネス側算出に変更、Task 1 でスペックに反映)。
- `window.__SPICA_TEST__` / `window.__PERF__` / `PerfEntry` / stats 関数のシグネチャは Task 2/3/7 間で一致。
