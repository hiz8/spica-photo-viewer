# プレビュー層 Phase 1 — 計測系拡張（tier / NAV_visible / ZOOM_full / NAV_cold 再定義）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「サムネイルバーに見えている画像は必ずプレースホルダー無しで表示される」（Picasa 同等）という保証を数値で判定できるよう、新指標 **NAV_visible / PLACEHOLDER_dur_visible / ZOOM_full** を bench に追加し、`paint:done` に表示 tier を付け、NAV_cold を「メモリ冷・ディスク温」の miss 経路へ再定義し、**最適化コードは一切変更せずに**新 baseline を記録する。

**Architecture:** アプリ側は perf マークとテストフックのみ追加（`paint:done`.tier / `zoom:request` / `__SPICA_TEST__.evictDecoded|zoomIn|resetZoom` / `getStatus().displayedTier`）。bench は既存の `bench.perf.ts` セッション（NAV_warm → NAV_cold → NAV_rapid）の後ろに NAV_visible（large コーパスを非単調に 12 ステップ × N=7 run）と ZOOM_full（N=7）を追加し、NAV_cold はジャンプ前に `evictDecoded()` を呼ぶ。マークの対応付けは従来通りハーネス側のオフライン処理（`bench-helpers.ts` の純関数）で行い、純関数は vitest で検証する。

**Tech Stack:** TypeScript strict + React 19 + Zustand（既存）/ WebdriverIO + `@wdio/tauri-service` embedded（既存 bench ハーネス）/ vitest。新規依存なし。Rust 無変更。

**Spec:** `docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md` §7（計測・テスト・採否ゲート）と §3 D1 / D5。指標定義の正本は `docs/PERFORMANCE_AUTONOMY_PLAN.md` §2/§4（Task 9 で更新）。運用ゲートは `CLAUDE.md`「Performance changes」。

## Global Constraints

- **最適化コードの変更禁止**: `src/` の変更は perf マーク（`tier`・`zoom:request`）、`src/utils/displayTier.ts`（純関数）、`src/utils/testHooks.ts` に限る。`src-tauri/` は不変更。表示・ロード・スケジューラの挙動を変える変更が必要になったらプラン違反 — 停止してレビューに戻す
- 既存指標 TTFI_cold / NAV_warm / NAV_rapid の**計測プロトコルを変えない**（`ttfi-cold.perf.ts` / `run-bench.mjs` は不変更。`bench.perf.ts` の既存 it ブロックは NAV_cold 以外触らない）。NAV_cold は spec D5 の通り再定義する（旧 baseline と比較不能になることは承認済み）
- `waitForFullPaint` / `extractTimings` の「フル paint = 最初の `paint:done` with `thumbnail === false`」判定は**変更しない**（D1: tier は detail の追加であり、thumbnail フラグの意味は不変）
- 計測は必ず release ビルド（`npm run bench:build` → `npm run bench`）。N=7。ベンチ中は他の重負荷アプリ禁止
- **`npm run type-check` は新規エラーゼロ。`npm run type-check:test` は着手前にエラー件数を記録し「増やさない」をゲートとする**（main 由来の既存エラーがある可能性。修正しない）
- **サブエージェント編集では biome の PostToolUse hook が発火しない**（CI 落ち実績）。各タスクのコミット前に、変更した全ファイルへ `npx biome format --write <paths>` と `npx biome lint <paths>` を実行し、差分・エラーゼロを確認してからコミットする（`npm run lint` / `npm run format` は **src/ しか見ない**ため `e2e/` には使えない）
- 既存テストを削除しない。挙動が変わるテスト（paint:done の detail 完全一致）は新挙動を検証する形に書き換える
- ブランチ: `worktree-preview-tier-phase1-measurement`。コミットは Conventional Commits、末尾に `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- `perfEvent("preload:done")` / `cache.preloaded`（= `getStatus().preloadedCount`）/ `preload` イベントのスキーマは不変（bench が依存）

## ファイル構成

| ファイル | 責務 |
|---|---|
| Create: `src/utils/displayTier.ts` + `src/utils/__tests__/displayTier.test.ts` | `DisplayTier` 型と `displayTierOf(data, thumbnailDisplayed)` 純関数（store / ImageViewer / testHooks が共用） |
| Modify: `src/components/ImageViewer.tsx`（paint effect） + `src/components/__tests__/ImageViewer.test.tsx` | `paint:done` detail に `tier` |
| Modify: `src/store/index.ts`（zoomIn / zoomOut / zoomAtPoint） + `src/store/__tests__/index.test.ts` | `zoom:request` マーク |
| Modify: `src/utils/testHooks.ts` + `src/utils/__tests__/testHooks.test.ts` + `e2e/types.d.ts` | `evictDecoded` / `zoomIn` / `resetZoom` フック、`getStatus().displayedTier` |
| Modify: `e2e/lib/bench-helpers.ts` + `e2e/lib/bench-helpers.test.ts` | `Timings.fullTier`、`extractZoomTiming`、`visibleThumbnailCapacity`、フックのラッパ |
| Modify: `e2e/specs/bench.perf.ts` | NAV_cold 再定義 / NAV_visible / ZOOM_full / 集計 |
| Modify: `e2e/scripts/save-baseline.mjs` | 新指標の degenerate ガード |
| Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md` §2/§4/§8、`CLAUDE.md`、spec §7.1 | 定義・スキーマ・baseline 記録 |
| Modify: `bench-results/baseline.json` | 新指標入り baseline（Task 10、判定 run と同一 JSON） |

---

### Task 0: 着手前の記録

- [ ] **Step 1: type-check:test の既存エラー件数を記録**

Run: `npm run type-check:test 2>&1 | grep -c "error TS"`
Expected: 数値（0 かもしれない）。この値を `E0` として以降のゲートで使う（増えたら新規エラー）。

- [ ] **Step 2: 単体テストの green 確認**

Run: `npm test`
Expected: 全件 PASS（PR #271 時点で 273）。失敗があれば停止して報告。

---

### Task 1: `displayTierOf` 純関数

**Files:**
- Create: `src/utils/displayTier.ts`
- Test: `src/utils/__tests__/displayTier.test.ts`

**Interfaces:**
- Produces: `type DisplayTier = "none" | "thumbnail" | "preview" | "full"`、`displayTierOf(data: ImageData | null, thumbnailDisplayed: boolean | undefined): DisplayTier`（Task 2/3/4 が使用）

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/utils/__tests__/displayTier.test.ts
import { describe, expect, it } from "vitest";
import { mockImageData } from "../testUtils";
import { displayTierOf } from "../displayTier";

describe("displayTierOf", () => {
  it("is 'none' without image data", () => {
    expect(displayTierOf(null, false)).toBe("none");
    expect(displayTierOf(null, true)).toBe("none");
  });

  it("is 'thumbnail' while the placeholder is displayed", () => {
    expect(displayTierOf(mockImageData, true)).toBe("thumbnail");
  });

  it("is 'full' for displayed image data that is not a placeholder", () => {
    expect(displayTierOf(mockImageData, false)).toBe("full");
    expect(displayTierOf(mockImageData, undefined)).toBe("full");
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest --run src/utils/__tests__/displayTier.test.ts`
Expected: FAIL（`../displayTier` が見つからない）

- [ ] **Step 3: 実装**

```ts
// src/utils/displayTier.ts
import type { ImageData } from "../types";

/**
 * What the viewer is showing for the current image. Reported in perf marks
 * (`paint:done`.tier, `zoom:request`.displayedTier) and by the E2E status
 * hook so the bench can tell a placeholder paint from a real one without
 * inferring it. "preview" is reserved for the display-resolution tier
 * (design spec 2026-08-21 §6.4) — nothing produces it yet; until then a
 * non-placeholder display is always "full".
 */
export type DisplayTier = "none" | "thumbnail" | "preview" | "full";

export const displayTierOf = (
  data: ImageData | null,
  thumbnailDisplayed: boolean | undefined,
): DisplayTier => {
  if (!data) return "none";
  if (thumbnailDisplayed) return "thumbnail";
  return "full";
};
```

- [ ] **Step 4: 成功を確認**

Run: `npx vitest --run src/utils/__tests__/displayTier.test.ts`
Expected: 3 PASS

- [ ] **Step 5: biome + コミット**

```bash
npx biome format --write src/utils/displayTier.ts src/utils/__tests__/displayTier.test.ts
npx biome lint src/utils/displayTier.ts src/utils/__tests__/displayTier.test.ts
git add src/utils/displayTier.ts src/utils/__tests__/displayTier.test.ts
git commit -m "feat(perf): add displayTierOf helper for tiered paint marks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `paint:done` に `tier` を追加（ImageViewer）

**Files:**
- Modify: `src/components/ImageViewer.tsx`（「Perf instrumentation」の useEffect。現行は `perfMark("paint:done", { path: data.path, thumbnail })`）
- Test: `src/components/__tests__/ImageViewer.test.tsx`（`describe("Canvas hit path (decoded bitmap window)")` 内の `"emits a full-resolution paint:done from the canvas path"` を更新し、placeholder 経路のテストを追加）

**Interfaces:**
- Consumes: Task 1 の `displayTierOf`
- Produces: `paint:done` detail `{ path, thumbnail: boolean, tier: DisplayTier }`（`thumbnail === false` ⇔ `tier !== "thumbnail"`。bench は `thumbnail` で full paint を判定し続け、`tier` は診断と ZOOM_full の対応付けに使う）。`decode:done` の detail は不変

- [ ] **Step 1: 既存テストの期待値を更新し、placeholder 経路のテストを追加（失敗させる）**

`"emits a full-resolution paint:done from the canvas path"` の expect を次に変更:

```ts
      expect(paint?.detail).toEqual({ path, thumbnail: false, tier: "full" });
```

同じ describe ブロックの末尾に追加:

```ts
    it("tags a thumbnail placeholder paint with tier 'thumbnail'", async () => {
      _setPerfEnabledForTests(true);
      window.__PERF__ = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
      // No retained bitmap and thumbnailDisplayed=true: the <img> placeholder
      // path. jsdom's <img> has no decode(), so the paint mark fires through
      // the synchronous fallback.
      mockStore.ui.thumbnailDisplayed = true;
      mockStore.currentImage.path = path;
      mockStore.currentImage.data = { ...data, src: "data:jpeg;base64,AAAA" };

      const { container } = render(<ImageViewer />);
      expect(container.querySelector("img")).toBeInTheDocument();

      await vi.waitFor(() => {
        const paint = (window.__PERF__ ?? []).find(
          (e) => e.name === "paint:done",
        );
        expect(paint?.detail).toEqual({
          path,
          thumbnail: true,
          tier: "thumbnail",
        });
      });

      mockStore.ui.thumbnailDisplayed = false;
      vi.unstubAllGlobals();
      _setPerfEnabledForTests(null);
      window.__PERF__ = [];
    });
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest --run src/components/__tests__/ImageViewer.test.tsx -t "paint:done"`
Expected: 2 件 FAIL（detail に `tier` が無い）

- [ ] **Step 3: 実装**

`src/components/ImageViewer.tsx` の import に追加:

```ts
import { displayTierOf } from "../utils/displayTier";
```

paint effect を次のように変更（`thumbnail` の算出直後に `tier` を追加し、`paint:done` の detail に渡す。`decode:done` は不変）:

```ts
  useEffect(() => {
    const data = currentImage.data;
    if (!data || !isPerfEnabled()) return;
    const thumbnail = !!useAppStore.getState().ui.thumbnailDisplayed;
    // Display tier of this paint (design spec 2026-08-21 §7.1). The bench
    // keeps judging "full paint" by thumbnail === false; tier is the
    // explicit label that will distinguish preview from full later.
    const tier = displayTierOf(data, thumbnail);
    let cancelled = false;

    const markPaint = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!cancelled) {
            perfMark("paint:done", { path: data.path, thumbnail, tier });
          }
        });
      });
    };
```

- [ ] **Step 4: 成功を確認**

Run: `npx vitest --run src/components/__tests__/ImageViewer.test.tsx`
Expected: 全件 PASS（新規 1 件含む）

- [ ] **Step 5: biome + コミット**

```bash
npx biome format --write src/components/ImageViewer.tsx src/components/__tests__/ImageViewer.test.tsx
npx biome lint src/components/ImageViewer.tsx src/components/__tests__/ImageViewer.test.tsx
git add src/components/ImageViewer.tsx src/components/__tests__/ImageViewer.test.tsx
git commit -m "feat(perf): tag paint:done marks with the display tier

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `zoom:request` マーク（store）

**Files:**
- Modify: `src/store/index.ts`（`zoomIn` / `zoomOut` / `zoomAtPoint`）
- Test: `src/store/__tests__/index.test.ts`（`describe("zoom operations")` の直後に新 describe を追加）

**Interfaces:**
- Consumes: Task 1 の `displayTierOf`、既存 `perfMark`
- Produces: mark `zoom:request` detail `{ path: string, zoom: number, displayedTier: DisplayTier }`。要求のたびに無条件で発行（クランプで zoom が変わらなくても出る。「要求時刻」が欲しいため）。Task 5 の `extractZoomTiming` が消費

- [ ] **Step 1: 失敗するテストを書く**

`src/store/__tests__/index.test.ts` の `describe("zoom operations", ...)` ブロックの直後（同じ `describe("AppStore")` 内）に追加:

```ts
  describe("zoom:request perf mark", () => {
    const path = "C:\\pics\\a.jpg";
    const marks = () =>
      (window.__PERF__ ?? []).filter((e) => e.name === "zoom:request");

    beforeEach(() => {
      _setPerfEnabledForTests(true);
      window.__PERF__ = [];
      useAppStore.setState({
        currentImage: { path, index: 0, data: mockImageData, error: null },
      });
    });

    afterEach(() => {
      _setPerfEnabledForTests(null);
      window.__PERF__ = [];
    });

    it("zoomIn records the requested zoom and the displayed tier", () => {
      useAppStore.getState().zoomIn();
      expect(marks()).toHaveLength(1);
      expect(marks()[0].detail).toEqual({
        path,
        zoom: 120,
        displayedTier: "full",
      });
    });

    it("zoomOut and zoomAtPoint also record zoom:request", () => {
      useAppStore.getState().setZoom(120);
      useAppStore.getState().zoomOut();
      useAppStore.getState().zoomAtPoint(1.2, 0, 0);
      expect(marks().map((m) => m.detail?.zoom)).toEqual([100, 120]);
    });

    it("reports the thumbnail tier while the placeholder is displayed", () => {
      useAppStore.getState().setThumbnailDisplayed(true);
      useAppStore.getState().zoomIn();
      expect(marks()[0].detail?.displayedTier).toBe("thumbnail");
    });

    it("reports 'none' when no image data is displayed", () => {
      useAppStore.getState().setImageData(null);
      useAppStore.getState().zoomIn();
      expect(marks()[0].detail?.displayedTier).toBe("none");
    });

    it("records nothing when perf is disabled", () => {
      _setPerfEnabledForTests(false);
      useAppStore.getState().zoomIn();
      expect(marks()).toHaveLength(0);
    });
  });
```

（`afterEach` が未 import なら `import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";` を確認。ファイル先頭は既に `afterEach` を import 済み。）

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest --run src/store/__tests__/index.test.ts -t "zoom:request"`
Expected: 4 件 FAIL（マークが出ない）、"records nothing when perf is disabled" のみ PASS

- [ ] **Step 3: 実装**

`src/store/index.ts` の import に追加:

```ts
import { displayTierOf } from "../utils/displayTier";
```

`zoomIn` / `zoomOut` / `zoomAtPoint` を次に変更（`perfMark` は既に import 済み）:

```ts
  zoomIn: () => {
    const state = get();
    const newZoom = Math.min(2000, state.view.zoom * 1.2);
    perfMark("zoom:request", {
      path: state.currentImage.path,
      zoom: newZoom,
      displayedTier: displayTierOf(
        state.currentImage.data,
        state.ui.thumbnailDisplayed,
      ),
    });
    state.setZoom(newZoom);
  },

  zoomOut: () => {
    const state = get();
    const newZoom = Math.max(10, state.view.zoom / 1.2);
    perfMark("zoom:request", {
      path: state.currentImage.path,
      zoom: newZoom,
      displayedTier: displayTierOf(
        state.currentImage.data,
        state.ui.thumbnailDisplayed,
      ),
    });
    state.setZoom(newZoom);
  },

  zoomAtPoint: (zoomFactor, pointX, pointY) => {
    const state = get();
    const currentZoom = state.view.zoom;
    const newZoom = Math.max(10, Math.min(2000, currentZoom * zoomFactor));
    perfMark("zoom:request", {
      path: state.currentImage.path,
      zoom: newZoom,
      displayedTier: displayTierOf(
        state.currentImage.data,
        state.ui.thumbnailDisplayed,
      ),
    });

    if (newZoom !== currentZoom) {
      // （以下、既存のパン再計算と set はそのまま）
```

- [ ] **Step 4: 成功を確認**

Run: `npx vitest --run src/store/__tests__/index.test.ts`
Expected: 全件 PASS

- [ ] **Step 5: biome + コミット**

```bash
npx biome format --write src/store/index.ts src/store/__tests__/index.test.ts
npx biome lint src/store/index.ts src/store/__tests__/index.test.ts
git add src/store/index.ts src/store/__tests__/index.test.ts
git commit -m "feat(perf): emit zoom:request marks from zoom actions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: テストフック `evictDecoded` / `zoomIn` / `resetZoom` + `getStatus().displayedTier`

**Files:**
- Modify: `src/utils/testHooks.ts`
- Modify: `e2e/types.d.ts`（`SpicaTestHooks` のミラー。**両ファイルを同時に揃える**）
- Test: `src/utils/__tests__/testHooks.test.ts`

**Interfaces:**
- Consumes: `clearBitmaps` / `bitmapPaths`（`src/utils/bitmapCache.ts`）、store の `removePreloadedImages` / `zoomIn` / `resetZoom`、Task 1 の `displayTierOf`
- Produces: `__SPICA_TEST__.evictDecoded(): { evictedBitmaps: number; evictedPreloaded: number }`（デコード済みビットマップと `cache.preloaded` を全消去。サムネイルとディスクキャッシュは保持。**プリローダーが静穏なときに呼ぶ前提** — in-flight ロードは中断しない）/ `zoomIn(): void` / `resetZoom(): void` / `getStatus().displayedTier: DisplayTier`。Task 5 のラッパが消費

- [ ] **Step 1: 失敗するテストを書く**

`src/utils/__tests__/testHooks.test.ts` に追加（import に `mockImageData` と `useAppStore` が必要）:

```ts
import { useAppStore } from "../../store";
import { mockImageData } from "../testUtils";
```

`describe("testHooks")` 内に追加:

```ts
  it("getStatus reports the displayed tier", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    expect(window.__SPICA_TEST__?.getStatus().displayedTier).toBe("none");

    useAppStore.getState().setImageData(mockImageData);
    expect(window.__SPICA_TEST__?.getStatus().displayedTier).toBe("full");

    useAppStore.getState().setThumbnailDisplayed(true);
    expect(window.__SPICA_TEST__?.getStatus().displayedTier).toBe(
      "thumbnail",
    );

    useAppStore.getState().setThumbnailDisplayed(false);
    useAppStore.getState().setImageData(null);
  });

  it("evictDecoded drops every retained bitmap and preload entry", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    setBitmap("C:\\pics\\a.jpg", { close: () => {} } as ImageBitmap);
    useAppStore.getState().setPreloadedImage("C:\\pics\\a.jpg", mockImageData);
    useAppStore.getState().setPreloadedImage("C:\\pics\\b.jpg", mockImageData);

    const result = window.__SPICA_TEST__?.evictDecoded();

    expect(result).toEqual({ evictedBitmaps: 1, evictedPreloaded: 2 });
    expect(window.__SPICA_TEST__?.getStatus()).toMatchObject({
      bitmapPaths: [],
      preloadedCount: 0,
    });
  });

  it("zoomIn and resetZoom drive the store's zoom actions", () => {
    _setPerfEnabledForTests(true);
    installTestHooks();
    window.__SPICA_TEST__?.zoomIn();
    expect(useAppStore.getState().view.zoom).toBe(120);

    window.__SPICA_TEST__?.resetZoom();
    expect(useAppStore.getState().view.zoom).toBe(100);
  });
```

（store はモジュールシングルトンなので、`afterEach` で `useAppStore.getState().setImageData(null)` 相当の後始末がテスト内に入っていることを確認する。上のテストは自分で戻している。）

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest --run src/utils/__tests__/testHooks.test.ts`
Expected: 新規 3 件 FAIL（`displayedTier` undefined / `evictDecoded` is not a function / `zoomIn` is not a function）

- [ ] **Step 3: 実装**

`src/utils/testHooks.ts` を次のように変更:

```ts
import { useAppStore } from "../store";
import { bitmapPaths, clearBitmaps } from "./bitmapCache";
import { type DisplayTier, displayTierOf } from "./displayTier";
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
    /**
     * Paths with a retained decoded bitmap. A cache.preloaded entry alone
     * does not imply one (viewer-loaded entries survive a folder switch and
     * their bitmap retention races clearBitmaps()), and only a path listed
     * here paints via <canvas> on navigation.
     */
    bitmapPaths: string[];
    /** What the viewer currently shows (see displayTier.ts). */
    displayedTier: DisplayTier;
  };
  clearPerf: () => void;
  /**
   * Drops every decoded bitmap and every cache.preloaded entry, keeping
   * thumbnails and the on-disk cache: the "memory-cold, disk-warm" state
   * NAV_cold measures from. Does not abort in-flight preloads — call it
   * only once the preloader is quiet (the bench waits for that first).
   */
  evictDecoded: () => { evictedBitmaps: number; evictedPreloaded: number };
  zoomIn: () => void;
  resetZoom: () => void;
}
```

`installTestHooks` 内:

```ts
    getStatus: () => {
      const state = useAppStore.getState();
      return {
        path: state.currentImage.path,
        index: state.currentImage.index,
        hasData: state.currentImage.data !== null,
        isLoading: state.ui.isLoading,
        // ui.thumbnailDisplayed is optional in AppState; normalize to boolean
        // to match the SpicaTestHooks#getStatus contract.
        thumbnailDisplayed: !!state.ui.thumbnailDisplayed,
        preloadedCount: state.cache.preloaded.size,
        bitmapPaths: bitmapPaths(),
        displayedTier: displayTierOf(
          state.currentImage.data,
          state.ui.thumbnailDisplayed,
        ),
      };
    },
    clearPerf: () => {
      window.__PERF__ = [];
    },
    evictDecoded: () => {
      const evictedBitmaps = bitmapPaths().length;
      clearBitmaps();
      const state = useAppStore.getState();
      const evictedPreloaded = state.cache.preloaded.size;
      state.removePreloadedImages([...state.cache.preloaded.keys()]);
      return { evictedBitmaps, evictedPreloaded };
    },
    zoomIn: () => useAppStore.getState().zoomIn(),
    resetZoom: () => useAppStore.getState().resetZoom(),
```

`e2e/types.d.ts` の `SpicaTestHooks` に同じメンバーを追加（`DisplayTier` は e2e 側では文字列ユニオンをそのまま書く）:

```ts
    /** What the viewer currently shows: none | thumbnail | preview | full. */
    displayedTier: "none" | "thumbnail" | "preview" | "full";
  };
  clearPerf: () => void;
  /** Drops decoded bitmaps + cache.preloaded (thumbnails/disk cache stay). */
  evictDecoded: () => { evictedBitmaps: number; evictedPreloaded: number };
  zoomIn: () => void;
  resetZoom: () => void;
}
```

- [ ] **Step 4: 成功を確認**

Run: `npx vitest --run src/utils/__tests__/testHooks.test.ts` → 全件 PASS
Run: `npm run type-check` → エラー 0 / `npm run type-check:test 2>&1 | grep -c "error TS"` → `E0` 以下

- [ ] **Step 5: biome + コミット**

```bash
npx biome format --write src/utils/testHooks.ts src/utils/__tests__/testHooks.test.ts e2e/types.d.ts
npx biome lint src/utils/testHooks.ts src/utils/__tests__/testHooks.test.ts e2e/types.d.ts
git add src/utils/testHooks.ts src/utils/__tests__/testHooks.test.ts e2e/types.d.ts
git commit -m "feat(e2e): add evictDecoded/zoomIn/resetZoom test hooks and displayedTier status

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: bench-helpers — `fullTier` / `extractZoomTiming` / `visibleThumbnailCapacity` / フックラッパ

**Files:**
- Modify: `e2e/lib/bench-helpers.ts`
- Test: `e2e/lib/bench-helpers.test.ts`（`npm test` に含まれる）

**Interfaces:**
- Consumes: Task 2 の `paint:done`.tier、Task 3 の `zoom:request`、Task 4 のフック
- Produces:
  - `Timings.fullTier: string | null`（フル paint の `detail.tier`。旧ビルドでは null）
  - `extractZoomTiming(entries: PerfEntry[], path: string): number | null` — `zoom:request` → それ以降の最初の `paint:done` with `tier === "full"`。要求時の `displayedTier === "full"` なら **0**。要求が無い／full paint が無いなら null
  - `THUMBNAIL_ITEM_PITCH_PX = 40`、`visibleThumbnailCapacity(innerWidth: number): number`（= `Math.floor(innerWidth / 40)`。`src/App.css` の `.thumbnail-item` 30px + margin 5px×2 のミラー）
  - `getInnerWidth(): Promise<number>`、`evictDecoded(): Promise<{evictedBitmaps:number; evictedPreloaded:number} | undefined>`、`zoomIn(): Promise<void>`、`resetZoom(): Promise<void>`

- [ ] **Step 1: 失敗するテストを書く**

`e2e/lib/bench-helpers.test.ts` の import を拡張し、末尾に describe を追加:

```ts
import { describe, expect, it } from "vitest";
import {
  extractTimings,
  extractZoomTiming,
  type PerfEntry,
  placeholderDuration,
  visibleThumbnailCapacity,
} from "./bench-helpers";
```

```ts
describe("extractTimings.fullTier", () => {
  const path = "/corpus/large/img-02.jpg";

  it("exposes the tier of the first non-placeholder paint", () => {
    const entries: PerfEntry[] = [
      { type: "mark", name: "open:request", ts: 0, detail: { path } },
      {
        type: "mark",
        name: "paint:done",
        ts: 20,
        detail: { path, thumbnail: true, tier: "thumbnail" },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 60,
        detail: { path, thumbnail: false, tier: "preview" },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 500,
        detail: { path, thumbnail: false, tier: "full" },
      },
    ];
    const timings = extractTimings(entries, path);
    expect(timings.fullPaint).toBe(60); // first thumbnail:false paint wins
    expect(timings.fullTier).toBe("preview");
  });

  it("is null on marks without a tier (older builds)", () => {
    const entries: PerfEntry[] = [
      { type: "mark", name: "open:request", ts: 0, detail: { path } },
      {
        type: "mark",
        name: "paint:done",
        ts: 25,
        detail: { path, thumbnail: false },
      },
    ];
    expect(extractTimings(entries, path).fullTier).toBeNull();
  });
});

describe("extractZoomTiming", () => {
  const path = "/corpus/large/img-03.jpg";

  it("is 0 when the displayed tier at request time is already full", () => {
    const entries: PerfEntry[] = [
      {
        type: "mark",
        name: "zoom:request",
        ts: 1000,
        detail: { path, zoom: 120, displayedTier: "full" },
      },
    ];
    expect(extractZoomTiming(entries, path)).toBe(0);
  });

  it("measures request -> first full paint at or after the request", () => {
    const entries: PerfEntry[] = [
      // A full paint BEFORE the request must not be picked up.
      {
        type: "mark",
        name: "paint:done",
        ts: 900,
        detail: { path, thumbnail: false, tier: "full" },
      },
      {
        type: "mark",
        name: "zoom:request",
        ts: 1000,
        detail: { path, zoom: 120, displayedTier: "preview" },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 1010,
        detail: { path, thumbnail: false, tier: "preview" },
      },
      {
        type: "mark",
        name: "paint:done",
        ts: 1400,
        detail: { path, thumbnail: false, tier: "full" },
      },
    ];
    expect(extractZoomTiming(entries, path)).toBe(400);
  });

  it("is null without a zoom:request or without a following full paint", () => {
    expect(extractZoomTiming([], path)).toBeNull();
    const pending: PerfEntry[] = [
      {
        type: "mark",
        name: "zoom:request",
        ts: 1000,
        detail: { path, zoom: 120, displayedTier: "preview" },
      },
    ];
    expect(extractZoomTiming(pending, path)).toBeNull();
  });

  it("ignores marks for other paths", () => {
    const entries: PerfEntry[] = [
      {
        type: "mark",
        name: "zoom:request",
        ts: 1000,
        detail: { path: "/other.jpg", zoom: 120, displayedTier: "full" },
      },
    ];
    expect(extractZoomTiming(entries, path)).toBeNull();
  });
});

describe("visibleThumbnailCapacity", () => {
  it("mirrors the 40px thumbnail pitch", () => {
    expect(visibleThumbnailCapacity(1920)).toBe(48);
    expect(visibleThumbnailCapacity(2560)).toBe(64);
    expect(visibleThumbnailCapacity(639)).toBe(15);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest --run e2e/lib/bench-helpers.test.ts`
Expected: 新規 describe が FAIL（export が無い）

- [ ] **Step 3: 実装**

`e2e/lib/bench-helpers.ts`:

`Timings` 型に追加:

```ts
export type Timings = {
  /** open:request -> first paint:done (may be a thumbnail preview). */
  firstPaint: number;
  /** open:request -> first paint:done with thumbnail === false. */
  fullPaint: number;
  /**
   * `detail.tier` of that first non-placeholder paint ("full" today,
   * "preview" once the display-resolution tier exists). null on builds
   * that predate the tier detail.
   */
  fullTier: string | null;
  /** src:set -> full-res decode:done, or null when either mark is missing. */
  fetchDecode: number | null;
};
```

`extractTimings` の return に追加:

```ts
  return {
    firstPaint: paints[0].ts - open.ts,
    fullPaint: full.ts - open.ts,
    fullTier: typeof full.detail?.tier === "string" ? full.detail.tier : null,
    // decode:done is best-effort: img.decode() rejects on data-URL races.
    fetchDecode: srcSet && fullDecode ? fullDecode.ts - srcSet.ts : null,
  };
```

`placeholderDuration` の後に追加:

```ts
/**
 * ZOOM_full interval for `path`: zoom:request -> the first paint:done with
 * tier "full" at or after the request. 0 when the displayed tier at request
 * time was already "full" (nothing to upgrade; the correct value for a
 * full-resolution display, which is every zoom today). null when there is no
 * zoom:request for `path` or no full paint has followed it yet — the caller
 * decides whether that is "still loading" or a timeout.
 */
export const extractZoomTiming = (
  entries: PerfEntry[],
  path: string,
): number | null => {
  const request = entries.find(
    (e) => e.name === "zoom:request" && e.detail?.path === path,
  );
  if (!request) return null;
  if (request.detail?.displayedTier === "full") return 0;
  const full = entries.find(
    (e) =>
      e.name === "paint:done" &&
      e.detail?.path === path &&
      e.detail?.tier === "full" &&
      e.ts >= request.ts,
  );
  return full ? full.ts - request.ts : null;
};

/**
 * Mirrors `.thumbnail-item` in src/App.css: 30px wide + 5px margin each
 * side. The bar centers the current item (50vw padding), so this many
 * thumbnails are visible at once in a window of the given inner width.
 */
export const THUMBNAIL_ITEM_PITCH_PX = 40;

export const visibleThumbnailCapacity = (innerWidth: number): number =>
  Math.floor(innerWidth / THUMBNAIL_ITEM_PITCH_PX);

export const getInnerWidth = (): Promise<number> =>
  browser.execute(() => window.innerWidth);

/** See SpicaTestHooks#evictDecoded: memory-cold, disk-warm. */
export const evictDecoded = () =>
  browser.execute(() => window.__SPICA_TEST__?.evictDecoded());

export const zoomIn = (): Promise<void> =>
  browser.execute(() => {
    window.__SPICA_TEST__?.zoomIn();
  });

export const resetZoom = (): Promise<void> =>
  browser.execute(() => {
    window.__SPICA_TEST__?.resetZoom();
  });
```

- [ ] **Step 4: 成功を確認**

Run: `npx vitest --run e2e/lib/bench-helpers.test.ts` → 全件 PASS
Run: `npm run type-check:test 2>&1 | grep -c "error TS"` → `E0` 以下

- [ ] **Step 5: biome + コミット**

```bash
npx biome format --write e2e/lib/bench-helpers.ts e2e/lib/bench-helpers.test.ts
npx biome lint e2e/lib/bench-helpers.ts e2e/lib/bench-helpers.test.ts
git add e2e/lib/bench-helpers.ts e2e/lib/bench-helpers.test.ts
git commit -m "test(e2e): add zoom/visible-range helpers and tier to bench timings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: bench.perf.ts — NAV_cold の再定義（D5）

**Files:**
- Modify: `e2e/specs/bench.perf.ts`（ファイル先頭コメント、`COLD_JUMP_STRIDE` コメント、NAV_cold の it ブロック）

**Interfaces:**
- Consumes: Task 5 の `evictDecoded`
- Produces: NAV_cold の意味 = 「プリローダー静穏 → `evictDecoded()` → stride ジャンプ → 非プレースホルダー paint」（ディスク温・メモリ冷の miss 経路）。HIT 除外ガードは維持（発生したら計測異常として除外・警告）

- [ ] **Step 1: import にラッパを追加**

```ts
import {
  COLD_SAMPLES_FILE,
  type ColdSample,
  N,
  type PerfEntry,
  RESULTS_DIR,
  type Summary,
  clearPerf,
  corpusFiles,
  evictDecoded,
  extractTimings,
  getPerf,
  getStatus,
  navigateToImage,
  openImage,
  placeholderDuration,
  preloadHit,
  waitForFullPaint,
} from "../lib/bench-helpers.ts";
```

- [ ] **Step 2: NAV_cold ブロックを書き換える**

```ts
  it("NAV_cold (medium corpus, memory-cold jumps: decoded cache evicted first)", async function () {
    this.timeout(900_000);
    const files = corpusFiles("medium");
    assertCorpusFits(files);

    // Continue in the same session, starting from wherever NAV_warm left off.
    let index = (await getStatus())?.index ?? 0;

    for (let i = 0; i < N; i++) {
      index = (index + COLD_JUMP_STRIDE) % files.length;
      // Memory-cold, disk-warm (design spec 2026-08-21 D5): once the
      // preloader is quiet, drop every decoded bitmap and preload entry so
      // the jump target is served through the miss path regardless of how
      // wide the retained window is. Thumbnails and the on-disk cache stay,
      // as they would for any image the user has browsed past before.
      // Quiet first: evictDecoded() does not abort in-flight loads, and a
      // load completing after the eviction would re-insert its entry.
      await waitForPreloadQuiet();
      const evicted = await evictDecoded();
      await clearPerf();
      await navigateToImage(index);
      const entries = await waitForFullPaint(files[index]);

      if (preloadHit(entries, files[index]) === true) {
        console.warn(
          `NAV_cold run ${i} (index ${index}): unexpected preload HIT after evicting ${JSON.stringify(evicted)} - sample excluded`,
        );
        continue;
      }
      results.NAV_cold.push(extractTimings(entries, files[index]).fullPaint);
    }
    console.log(`NAV_cold samples: ${JSON.stringify(results.NAV_cold)}`);
  });
```

`COLD_JUMP_STRIDE` のコメントを更新:

```ts
/**
 * Stride between NAV_cold jumps. Kept > 2 * PRELOAD_RANGE from the original
 * "far jump" protocol so the index sequence is unchanged; since D5 the miss
 * is guaranteed by evictDecoded() rather than by distance.
 */
const COLD_JUMP_STRIDE = 13;
```

ファイル先頭コメントの `cold needs that same cache to have moved on (the app keeps only current +/-5)` を次に変更:

```
 * preload cache, and cold evicts the decoded cache (bitmaps + cache.preloaded)
 * right before each jump so the target goes through the miss path whatever
 * the retained window is.
```

- [ ] **Step 3: 型と整形を確認**

Run: `npm run type-check:test 2>&1 | grep -c "error TS"` → `E0` 以下
Run: `npx biome format --write e2e/specs/bench.perf.ts && npx biome lint e2e/specs/bench.perf.ts`

- [ ] **Step 4: コミット**

```bash
git add e2e/specs/bench.perf.ts
git commit -m "bench: redefine NAV_cold as memory-cold/disk-warm via evictDecoded

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: bench.perf.ts — NAV_visible / PLACEHOLDER_dur_visible

**Files:**
- Modify: `e2e/specs/bench.perf.ts`（定数、サンプル入れ物、NAV_rapid の後ろに it ブロック、`after()` の出力）

**Interfaces:**
- Consumes: Task 5 の `getInnerWidth` / `visibleThumbnailCapacity`、既存の `waitForPreloadSettled` / `waitForPreloadQuiet` / `RAPID_MIN_INTERVAL_MS`
- Produces: JSON `metrics.NAV_visible = { median_ms, p95_ms, n, steps: 12, sequence: number[], hit_rate }`、`metrics.PLACEHOLDER_dur_visible = Summary`、`metrics.breakdown.fetch_decode_visible_miss = Summary`。n は必ず `runs × 12 = 84`

- [ ] **Step 1: 定数とサンプル入れ物を追加**

`RAPID_MIN_INTERVAL_MS` の定義の後に:

```ts
/**
 * NAV_visible: a deterministic NON-monotonic walk over the large corpus —
 * backward steps, far jumps and short forward runs, every target a thumbnail
 * that is visible in the bar (asserted against window.innerWidth at run
 * time). This is the Picasa guarantee under test: a visible thumbnail never
 * shows a placeholder. Starts from index 0 each run:
 * 0 -> 5 -> 2 -> 9 -> 1 -> 12 -> 7 -> 3 -> 14 -> 6 -> 11 -> 0 -> 8.
 */
const VISIBLE_SEQUENCE: readonly number[] = [
  5, 2, 9, 1, 12, 7, 3, 14, 6, 11, 0, 8,
];
```

`rapid` の定義の後に:

```ts
/** NAV_visible pools every step of every run - hits AND misses both count. */
const visible = {
  fullPaint: [] as number[],
  placeholderDur: [] as number[],
  missFetchDecode: [] as number[],
  hits: 0,
  total: 0,
};
```

- [ ] **Step 2: it ブロックを NAV_rapid の直後に追加**

```ts
  it("NAV_visible (large corpus, non-monotonic walk over visible thumbnails)", async function () {
    this.timeout(900_000);
    const files = corpusFiles("large");
    if (Math.max(...VISIBLE_SEQUENCE) >= files.length) {
      throw new Error(
        `large corpus has ${files.length} images, NAV_visible needs index ${Math.max(...VISIBLE_SEQUENCE)}`,
      );
    }
    // The metric is only meaningful if every target thumbnail is actually
    // visible in the bar; the bar shows floor(innerWidth / 40px) items.
    const innerWidth = await getInnerWidth();
    const capacity = visibleThumbnailCapacity(innerWidth);
    if (capacity < files.length) {
      throw new Error(
        `NAV_visible needs every large-corpus thumbnail visible: a ${innerWidth}px window shows ${capacity}, corpus has ${files.length}`,
      );
    }

    // Same deterministic start as NAV_rapid: index 0 displayed, preloader
    // populated and quiet. (openImage on the already-open folder is a
    // no-op for the caches; it just re-selects index 0.)
    await clearPerf();
    await openImage(files[0]);
    await waitForFullPaint(files[0]);
    await waitForPreloadSettled(Math.min(5, files.length - 1));
    await waitForPreloadQuiet();

    for (let run = 0; run < N; run++) {
      if (run > 0) {
        await clearPerf();
        await navigateToImage(0);
        await waitForFullPaint(files[0]);
        await waitForPreloadQuiet();
      }

      const runFullPaints: number[] = [];
      let runHits = 0;

      for (const index of VISIBLE_SEQUENCE) {
        await clearPerf();
        const navAt = Date.now();
        await navigateToImage(index);
        const entries = await waitForFullPaint(files[index]);

        const timings = extractTimings(entries, files[index]);
        visible.total++;
        visible.fullPaint.push(timings.fullPaint);
        visible.placeholderDur.push(placeholderDuration(timings));
        runFullPaints.push(timings.fullPaint);
        const hit = preloadHit(entries, files[index]);
        if (hit === true) {
          visible.hits++;
          runHits++;
        }
        if (hit === false && timings.fetchDecode !== null) {
          visible.missFetchDecode.push(timings.fetchDecode);
        }

        // Same pacing floor as NAV_rapid (full paint awaited, >= 250ms).
        const elapsed = Date.now() - navAt;
        if (elapsed < RAPID_MIN_INTERVAL_MS) {
          await browser.pause(RAPID_MIN_INTERVAL_MS - elapsed);
        }
      }
      console.log(
        `NAV_visible run ${run}: ${JSON.stringify(runFullPaints)} (hits ${runHits}/${VISIBLE_SEQUENCE.length})`,
      );
    }
    console.log(
      `NAV_visible samples: ${JSON.stringify(visible.fullPaint)} (hits ${visible.hits}/${visible.total})`,
    );
    console.log(
      `PLACEHOLDER_dur_visible samples: ${JSON.stringify(visible.placeholderDur)}`,
    );
  });
```

import に `getInnerWidth` と `visibleThumbnailCapacity` を追加する。

- [ ] **Step 3: `after()` の出力に追加**

`PLACEHOLDER_dur: summarize(rapid.placeholderDur),` の直後:

```ts
        NAV_visible: {
          ...summarize(visible.fullPaint),
          steps: VISIBLE_SEQUENCE.length,
          sequence: [...VISIBLE_SEQUENCE],
          hit_rate: visible.total > 0 ? visible.hits / visible.total : null,
        },
        PLACEHOLDER_dur_visible: summarize(visible.placeholderDur),
```

`breakdown` に追加:

```ts
          fetch_decode_visible_miss: summarize(visible.missFetchDecode),
```

- [ ] **Step 4: 型と整形**

Run: `npm run type-check:test 2>&1 | grep -c "error TS"` → `E0` 以下
Run: `npx biome format --write e2e/specs/bench.perf.ts && npx biome lint e2e/specs/bench.perf.ts`

- [ ] **Step 5: コミット**

```bash
git add e2e/specs/bench.perf.ts
git commit -m "bench: add NAV_visible / PLACEHOLDER_dur_visible (non-monotonic walk over visible thumbnails)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: bench.perf.ts — ZOOM_full

**Files:**
- Modify: `e2e/specs/bench.perf.ts`（NAV_visible の直後に it ブロック、`after()` の出力）

**Interfaces:**
- Consumes: Task 5 の `zoomIn` / `resetZoom` / `extractZoomTiming`
- Produces: `metrics.ZOOM_full = Summary`（n = runs。今は全サンプル 0 が期待値 = 表示が既に full）

- [ ] **Step 1: サンプル入れ物と it ブロック**

`visible` の後に:

```ts
/** ZOOM_full: zoom:request -> full-resolution paint, one sample per run. */
const zoomFull: number[] = [];
```

NAV_visible の直後に（**必ず最後の it にする**: ズームは view state に保存されるため他指標の前に置かない）:

```ts
  it("ZOOM_full (large corpus, zoom-in to full resolution)", async function () {
    this.timeout(600_000);
    const files = corpusFiles("large");

    for (let i = 0; i < N; i++) {
      const index = 1 + (i % (files.length - 1));
      await clearPerf();
      await navigateToImage(index);
      await waitForFullPaint(files[index]);

      await clearPerf();
      await zoomIn();
      let sample: number | null = null;
      try {
        // 0 immediately when the display was already full resolution;
        // otherwise the time to the full-resolution paint the zoom triggers.
        await browser.waitUntil(
          async () =>
            extractZoomTiming(await getPerf(), files[index]) !== null,
          {
            timeout: 30_000,
            interval: 100,
            timeoutMsg: `no full-resolution paint after zoom:request for ${files[index]}`,
          },
        );
        sample = extractZoomTiming(await getPerf(), files[index]);
      } catch (error) {
        console.warn(
          `ZOOM_full sample ${i}: ${(error as Error).message} - sample excluded`,
        );
      }
      if (sample !== null) zoomFull.push(sample);
      // Back to fit so the saved view state of this image stays default.
      await resetZoom();
    }
    console.log(`ZOOM_full samples: ${JSON.stringify(zoomFull)}`);
  });
```

import に `extractZoomTiming`、`resetZoom`、`zoomIn` を追加する。

- [ ] **Step 2: `after()` の出力に追加**

`PLACEHOLDER_dur_visible: summarize(visible.placeholderDur),` の直後:

```ts
        ZOOM_full: summarize(zoomFull),
```

- [ ] **Step 3: 型と整形**

Run: `npm run type-check:test 2>&1 | grep -c "error TS"` → `E0` 以下
Run: `npx biome format --write e2e/specs/bench.perf.ts && npx biome lint e2e/specs/bench.perf.ts`

- [ ] **Step 4: コミット**

```bash
git add e2e/specs/bench.perf.ts
git commit -m "bench: add ZOOM_full (zoom:request -> full-resolution paint)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: save-baseline の degenerate ガード拡張

**Files:**
- Modify: `e2e/scripts/save-baseline.mjs`

**Interfaces:**
- Consumes: Task 7/8 の JSON キー（`NAV_visible.steps`、`PLACEHOLDER_dur_visible`、`ZOOM_full`）
- Produces: 新指標の n 欠落で baseline 化を拒否する

- [ ] **Step 1: ガードを追加**

NAV_rapid / PLACEHOLDER_dur のループの直後に:

```js
// NAV_visible / PLACEHOLDER_dur_visible: same pooling rule as NAV_rapid
// (steps x runs, no exclusion), so a short pool means steps failed to paint.
const visible = data.metrics?.NAV_visible;
const expectedVisibleN = data.runs * (visible?.steps ?? 0);
for (const [key, m] of [
  ["NAV_visible", visible],
  ["PLACEHOLDER_dur_visible", data.metrics?.PLACEHOLDER_dur_visible],
]) {
  if (
    !m ||
    m.median_ms === null ||
    m.n !== expectedVisibleN ||
    expectedVisibleN === 0
  ) {
    throw new Error(
      `${newest.f}: ${key} is degenerate (median_ms=${m?.median_ms}, n=${m?.n}, expected n=${expectedVisibleN}) - refusing to save as baseline`,
    );
  }
}

// ZOOM_full: one sample per run. median_ms === 0 is legitimate (the display
// was already full resolution when the zoom was requested).
const zoom = data.metrics?.ZOOM_full;
if (!zoom || zoom.median_ms === null || zoom.n < data.runs) {
  throw new Error(
    `${newest.f}: ZOOM_full is degenerate (median_ms=${zoom?.median_ms}, n=${zoom?.n}, runs=${data.runs}) - refusing to save as baseline`,
  );
}
```

- [ ] **Step 2: 手元で動作確認（偽 JSON で拒否されること）**

```bash
node -e "
const fs=require('fs');const b=JSON.parse(fs.readFileSync('bench-results/baseline.json','utf8'));
fs.writeFileSync('bench-results/zz-test-degenerate.json', JSON.stringify(b));
"
node e2e/scripts/save-baseline.mjs; echo "exit=$?"
rm bench-results/zz-test-degenerate.json
```

Expected: `NAV_visible is degenerate ... refusing to save as baseline` で非ゼロ終了（現 baseline には NAV_visible が無い）。`baseline.json` は変更されていないこと（`git status` で確認）。

- [ ] **Step 3: biome + コミット**

```bash
npx biome format --write e2e/scripts/save-baseline.mjs
npx biome lint e2e/scripts/save-baseline.mjs
git add e2e/scripts/save-baseline.mjs
git commit -m "bench: guard baseline canonization on NAV_visible / ZOOM_full completeness

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: 指標定義ドキュメントの更新（baseline 記録の前に）

**Files:**
- Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md` §2（集計する指標）/ §4（スキーマ）
- Modify: `CLAUDE.md`「Performance changes」
- Modify: `docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md` §7.1（ZOOM_full の Phase 1 値）

- [ ] **Step 1: AUTONOMY_PLAN §2 のマーク表に `tier` を追記**

`paint:done` 行の直後の実装注記に追加:

```
> `paint:done` は `detail.tier`（`"thumbnail" | "preview" | "full"`）も持つ（2026-08-21、プレビュー層の設計 D1）。`thumbnail === false` ⇔ `tier !== "thumbnail"`。bench の「フル品質 paint」判定は従来通り `thumbnail === false` で行い、`tier` は「最初の非プレースホルダー paint が preview か full か」の診断と ZOOM_full の対応付けに使う。`zoom:request`（detail: `path`, `zoom`, `displayedTier`）はズーム操作の要求時刻。
```

- [ ] **Step 2: AUTONOMY_PLAN §2 の集計指標リストに追加・修正**

`NAV_cold` の行を次に置換:

```
- **NAV_cold**: **メモリ冷・ディスク温**の miss 経路。プリローダー静穏後にテストフック `evictDecoded()`（デコード済みビットマップ + `cache.preloaded` を全消去。サムネイルとディスクキャッシュは保持）を呼んでから stride ジャンプしたときの `ttfi`。2026-08-21 に再定義（旧定義「±5 の外への遠方ジャンプ」は保持窓が可視範囲に広がると成立しないため）。旧 baseline とは比較不能
```

`PLACEHOLDER_dur` の行の直後に追加:

```
- **NAV_visible**（2026-08-21 追加、プレビュー層ワークストリームの主指標）: large コーパス（16 枚、全てサムネイルバー可視範囲内であることを `window.innerWidth / 40px` で実行時に検証）を index 0 から決定的な**非単調** 12 ステップ列 `[5,2,9,1,12,7,3,14,6,11,0,8]`（後退・ジャンプ・前進を含む）でナビゲーションしたときの各ステップの `open:request` → `paint:done`(thumbnail: false)。ペーシングは NAV_rapid と同じ（フル品質 paint 待ち + 下限 250ms）。hit/miss を除外せず pool（n = runs × 12 = 84 固定）、`hit_rate` を併記。「サムネイルが見えている画像はプレースホルダー無しで即時表示」（Picasa 同等）の数値定義
- **PLACEHOLDER_dur_visible**: NAV_visible の同一サンプルにおける「最初の paint → フル品質 paint」の間隔。0 が正しい値（PLACEHOLDER_dur と同じ読み方）
- **ZOOM_full**（2026-08-21 追加）: large コーパスで画像を表示後に `zoomIn()` したときの `zoom:request` → 最初の `paint:done`(tier: "full")。要求時の表示が既に full なら **0**（アップグレード不要）。現行は常に 0。表示解像度プレビュー層の導入後は 20MP フルデコード相当（~400ms 帯）に移る見込みで、これは D1 で承認されたトレードオフ — 回帰ゲートではなく悪化監視（目安: 中央値 ≤ 500ms）。n = runs
```

- [ ] **Step 3: AUTONOMY_PLAN §4 スキーマに追加**

`"PLACEHOLDER_dur": { ... },` の直後:

```jsonc
    "NAV_visible": {
      "median_ms": 0,
      "p95_ms": 0,
      "n": 84,
      "steps": 12,
      "sequence": [5, 2, 9, 1, 12, 7, 3, 14, 6, 11, 0, 8],
      "hit_rate": 1.0
    },
    "PLACEHOLDER_dur_visible": { "median_ms": 0, "p95_ms": 0, "n": 84 },
    "ZOOM_full": { "median_ms": 0, "p95_ms": 0, "n": 7 },
```

`breakdown` に `"fetch_decode_visible_miss": { "median_ms": 0, "p95_ms": 0, "n": 0 }` を追加。

- [ ] **Step 4: CLAUDE.md「Performance changes」に追記**

最後の箇条書きの後に追加:

```
- プレビュー層ワークストリーム（2026-08-21〜、設計: `docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md`）の主指標は **NAV_visible**（可視サムネイルへの非単調ナビ 12 ステップ × 7 run、n=84 固定）。目標: **NAV_visible 中央値 < 100ms かつ hit_rate = 1.0 かつ PLACEHOLDER_dur_visible p95 < 80ms（目標 0）**。サイクル毎の改善判定は NAV_visible 中央値で行う。
- `paint:done` の `tier`（thumbnail / preview / full）により「フル品質 paint」= 最初の非プレースホルダー paint（preview または full）と定義する（D1）。フル解像度への到達は **ZOOM_full**（zoom:request → tier full の paint。表示が既に full なら 0）で別途監視し、回帰ゲートには含めない（目安: 中央値 ≤ 500ms）。
- NAV_cold は「プリローダー静穏 → `evictDecoded()` → ジャンプ」のメモリ冷・ディスク温経路（2026-08-21 再定義）。旧 baseline の NAV_cold とは比較しない。
```

- [ ] **Step 5: spec §7.1 の ZOOM_full 行を Phase 1 の実装に合わせる**

`**Phase 1 時点では値は \`null\`**（現行はズームで再 paint が起きないため \`paint:done\` が出ない）— n ガードは Phase 3 から有効化し、Phase 3 の bench で初回記録する` を次に置換:

```
`zoom:request` 時点の表示 tier が既に full なら **0**（アップグレード不要 = 正しい値）。**Phase 1 では全サンプル 0（n=7）**。Phase 3 で ~400ms 帯（20MP フルデコード）へ移るのは D1 で承認済みのトレードオフであり回帰とは扱わない（目安: 中央値 ≤ 500ms、超えたら調査）
```

- [ ] **Step 6: コミット**

```bash
git add docs/PERFORMANCE_AUTONOMY_PLAN.md CLAUDE.md docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md
git commit -m "docs(perf): define tier marks, NAV_visible, ZOOM_full and the memory-cold NAV_cold

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: release ビルド → E2E → フルベンチ → baseline 記録（メインセッションで実行）

**Files:**
- Modify: `bench-results/baseline.json`（`npm run bench:baseline` が上書き）
- Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md` §8（新 baseline 表）

- [ ] **Step 1: release ビルド**

Run（バックグラウンド、~10 分）: `npm run bench:build`
Expected: `src-tauri/target/release/spica-photo-viewer.exe` が更新される

- [ ] **Step 2: 単体・Rust・E2E**

```bash
npm test
cd src-tauri && cargo test --lib && cd ..
npm run test:e2e
```

Expected: vitest 全件 PASS（273 + 新規）、cargo 62 PASS、e2e 13/13（smoke + centering + visual）PASS。**e2e は 2 回連続 green を確認**（flake の切り分け）

- [ ] **Step 3: フルベンチ**

Run（バックグラウンド、~30 分。他の重負荷アプリを起動しない）: `npm run bench`
Expected: `bench-results/<sha>-<timestamp>.json` が生成される。ログに `NAV_visible run k: [...] (hits x/12)` が 7 行、`ZOOM_full samples: [0,0,0,0,0,0,0]`

- [ ] **Step 4: 判定（記録して報告する）**

baseline（`c4dc4d8`）との比較表を作る:

| 指標 | 判定 |
|---|---|
| TTFI_cold / NAV_warm / NAV_rapid 中央値 | baseline の p95 を超えて悪化していないこと（プロトコル無変更。アプリ変更はマーク追加のみなので差は環境ドリフト） |
| NAV_cold | 新定義の初回記録（参考: 旧 180.6ms。evict 後の miss 経路なので同程度〜やや上を予想） |
| NAV_visible | n = 84、hit_rate と中央値/p95 を記録（予想: hit_rate 0.3〜0.5、中央値 ~300–450ms = 苦情の数値再現） |
| PLACEHOLDER_dur_visible | n = 84、p95 を記録（予想: ~300–400ms） |
| ZOOM_full | n = 7、中央値 0 |
| n 完全性 | NAV_rapid / PLACEHOLDER_dur / NAV_visible / PLACEHOLDER_dur_visible = 84、他 = 7。欠けていたら原因を調査し、説明できるまで baseline 化しない |

- [ ] **Step 5: baseline 化と §8 更新**

Run: `npm run bench:baseline`（bench は再実行されない。直近 run の JSON がそのまま baseline になる）
`docs/PERFORMANCE_AUTONOMY_PLAN.md` §8 の表に NAV_visible / PLACEHOLDER_dur_visible / ZOOM_full / 新 NAV_cold の行を追加し、見出しの gitSha / timestamp を新 baseline に合わせる。NAV_cold 再定義と ZOOM_full = 0 の注記を §8 に追記する。

- [ ] **Step 6: コミット**

```bash
git add bench-results/baseline.json docs/PERFORMANCE_AUTONOMY_PLAN.md
git commit -m "bench: record baseline with NAV_visible / ZOOM_full and the memory-cold NAV_cold

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: push と PR**

```bash
git -c credential.helper="!gh auth git-credential" push https://github.com/hiz8/spica-photo-viewer.git worktree-preview-tier-phase1-measurement
gh pr create --base main --title "bench: add NAV_visible / ZOOM_full metrics and tiered paint marks (preview-tier phase 1)" --body-file <(本文)
```

PR 本文には: 目的（プレビュー層 Phase 1 = 計測系のみ）、新指標の定義、NAV_cold 再定義、baseline 比較表、ゲート結果（vitest / cargo / e2e / bench）、`🤖 Generated with [Claude Code](https://claude.com/claude-code)`。

---

## Self-Review 済みの確認点

- **Spec 対応**: spec §7.1 の `tier`（Task 2）、NAV_visible / PLACEHOLDER_dur_visible（Task 7）、ZOOM_full（Task 8、0 ルールは Task 10 Step 5 で spec 側を更新）、NAV_cold D5（Task 6）、`save-baseline` ガード（Task 9）、AUTONOMY_PLAN §2/§4/§8 更新（Task 10/11）、テストフック `evictDecoded` / `zoomIn`（Task 4）を全てカバー。spec §7.2 の vitest 項目のうち Phase 1 に属するもの（helpers 純関数・フック）はカバー。E2E 視覚 4 ケースと Rust テストは Phase 2/3 の範囲
- **最適化コード無変更**: `src/` の変更は ImageViewer の paint effect（detail 追加のみ）、store の 3 ズームアクション（perfMark 追加のみ）、testHooks、displayTier の新規純関数。表示・ロード・スケジューラの分岐は触らない
- **型の一貫性**: `DisplayTier` は src 側の型、e2e 側は同じ文字列ユニオンを直書き（`e2e/types.d.ts` は src を import しない方針を踏襲）。`extractZoomTiming` の戻り `number | null`、`Timings.fullTier: string | null`、`evictDecoded` の戻り `{evictedBitmaps, evictedPreloaded}` は Task 4/5/6/8 で同一
- **既存指標のプロトコル**: NAV_warm / NAV_rapid / TTFI_cold の it ブロックとヘルパ判定は無変更。NAV_visible / ZOOM_full は NAV_rapid の**後ろ**に追加（実行順: NAV_warm → NAV_cold → NAV_rapid → NAV_visible → ZOOM_full）。ZOOM_full は view state を触るため最後
- **n 規則**: NAV_visible / PLACEHOLDER_dur_visible は除外ルールなし（84 固定）、ZOOM_full は runs（7）。`save-baseline` が両方をガード
