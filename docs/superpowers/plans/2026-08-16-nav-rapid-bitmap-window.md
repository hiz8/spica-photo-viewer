# NAV_rapid Bitmap Window（仮説 C）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** デコード済み `ImageBitmap` の方向性窓 + canvas hit paint + 即時スケジューラで、NAV_rapid フル品質 paint 中央値を fast クラスタ（~30ms 台）へ移す（サイクルゲート ≥10% 改善、最終目標 <100ms）。

**Architecture:** (1) モジュールレベル `bitmapCache`（自前 `close()` で決定的解放）、(2) hit 時は `<canvas>` に `drawImage`（フル解像度ピクセル、デコード不要）、(3) `useImagePreloader` を「500ms タイマー + ±5 element preload」から「index 変更で即時・進行方向近傍 4 枚・`fetch→blob→createImageBitmap`」へ作り直し。cold 経路（bitmap 無し）・GIF は既存 `<img>` パス無変更。

**Tech Stack:** TypeScript strict + React 19 + Zustand（既存）。新規依存なし。

**Spec:** `docs/superpowers/specs/2026-08-16-nav-rapid-bitmap-window-design.md`（このブランチにコミット済み。プランは spec から論証する — 実装者は両方読むこと）

## Global Constraints

- **メトリクス定義・bench プロトコル・`bench-helpers.ts` の変更禁止**（ユーザー決定: 現行ゲート維持）
- **Rust（`src-tauri/`）変更禁止**
- メモリ: `BITMAP_CACHE_BUDGET_BYTES = 500MB` / 窓 = current + 4 近傍（spec §1–2 の値をそのまま使う）
- `npm run type-check` は新規エラーゼロ。`npm run type-check:test` は **main 由来の既存エラーがある**ため「新規エラーを増やさない」がゲート（修正もしない）
- サブエージェント編集では biome hook が発火しない: **各タスクのコミット前に `npx biome format --write <変更ファイル>` と `npx biome lint <変更ファイル>` を必ず実行**（e2e/ は `npm run lint` の対象外なので特に必須）
- 既存テストを削除しない。挙動が変わったテスト（旧 preloader API 前提）は新挙動を検証する形に**書き換える**
- コミットは `worktree-nav-rapid-bitmap-window` ブランチ。メッセージ末尾に `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- `perfEvent("preload:done")` と `cache.preloaded`（= `getStatus().preloadedCount`）の互換維持（bench が依存）。スケジューラは **`src:set` を発行しない**

---

### Task 1: memory 定数 + bitmapCache

**Files:**
- Create: `src/constants/memory.ts`
- Create: `src/utils/bitmapCache.ts`
- Test: `src/utils/__tests__/bitmapCache.test.ts`

**Interfaces:**
- Produces: `BITMAP_CACHE_BUDGET_BYTES: number` / `BITMAP_WINDOW_SIZE: number`（Task 4 が使用）; `setBitmap(path, bitmap)` / `getBitmap(path)` / `hasBitmap(path)` / `deleteBitmap(path)` / `clearBitmaps()` / `bitmapBytes()` / `bitmapPaths()`（Task 4/5 が使用）。eviction 判断はしない（会計と `close()` のみ）

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/utils/__tests__/bitmapCache.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bitmapBytes,
  bitmapPaths,
  clearBitmaps,
  deleteBitmap,
  getBitmap,
  hasBitmap,
  setBitmap,
} from "../bitmapCache";

// jsdom has no ImageBitmap; the cache only touches width/height/close.
const fakeBitmap = (width: number, height: number) =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

describe("bitmapCache", () => {
  afterEach(() => {
    clearBitmaps();
  });

  it("stores and retrieves bitmaps by path", () => {
    const bmp = fakeBitmap(100, 50);
    setBitmap("/a.jpg", bmp);
    expect(hasBitmap("/a.jpg")).toBe(true);
    expect(getBitmap("/a.jpg")).toBe(bmp);
    expect(getBitmap("/missing.jpg")).toBeUndefined();
  });

  it("closes the previous bitmap when a path is overwritten", () => {
    const first = fakeBitmap(10, 10);
    const second = fakeBitmap(20, 20);
    setBitmap("/a.jpg", first);
    setBitmap("/a.jpg", second);
    expect(first.close).toHaveBeenCalledOnce();
    expect(getBitmap("/a.jpg")).toBe(second);
  });

  it("closes on delete and removes the entry", () => {
    const bmp = fakeBitmap(10, 10);
    setBitmap("/a.jpg", bmp);
    deleteBitmap("/a.jpg");
    expect(bmp.close).toHaveBeenCalledOnce();
    expect(hasBitmap("/a.jpg")).toBe(false);
  });

  it("delete of an unknown path is a no-op", () => {
    expect(() => deleteBitmap("/missing.jpg")).not.toThrow();
  });

  it("closes everything on clear", () => {
    const a = fakeBitmap(10, 10);
    const b = fakeBitmap(20, 20);
    setBitmap("/a.jpg", a);
    setBitmap("/b.jpg", b);
    clearBitmaps();
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(bitmapPaths()).toEqual([]);
  });

  it("accounts bytes as width*height*4", () => {
    setBitmap("/a.jpg", fakeBitmap(100, 50)); // 20_000
    setBitmap("/b.jpg", fakeBitmap(10, 10)); // 400
    expect(bitmapBytes()).toBe(100 * 50 * 4 + 10 * 10 * 4);
    deleteBitmap("/a.jpg");
    expect(bitmapBytes()).toBe(400);
  });

  it("lists cached paths", () => {
    setBitmap("/a.jpg", fakeBitmap(1, 1));
    setBitmap("/b.jpg", fakeBitmap(1, 1));
    expect(bitmapPaths().sort()).toEqual(["/a.jpg", "/b.jpg"]);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest --run src/utils/__tests__/bitmapCache.test.ts`
Expected: FAIL（モジュール不在）

- [ ] **Step 3: 実装**

```ts
// src/constants/memory.ts
/**
 * Memory constants for the decoded-bitmap cache (hypothesis C).
 * A 20MP RGBA bitmap is ~80MB; the retained set (current image plus
 * BITMAP_WINDOW_SIZE neighbors) must stay inside the budget.
 */
export const BITMAP_CACHE_BUDGET_BYTES = 500 * 1024 * 1024;

/**
 * Neighbors kept decoded around the current image (in addition to it).
 * With the current image this is 5 x ~80MB = ~400MB for the large corpus.
 */
export const BITMAP_WINDOW_SIZE = 4;
```

```ts
// src/utils/bitmapCache.ts
/**
 * Module-level cache of decoded full-resolution bitmaps (hypothesis C).
 * Keeps decoded pixels alive independent of the renderer's own image-cache
 * eviction, so a preload-hit navigation can paint without re-decoding.
 * Not part of the Zustand store: ImageBitmap objects are large mutable
 * resources, not immutable state. Eviction POLICY lives in
 * useImagePreloader (it knows index/direction/budget); this module only
 * does bookkeeping and deterministic release via close().
 */
const bitmaps = new Map<string, ImageBitmap>();

export const setBitmap = (path: string, bitmap: ImageBitmap): void => {
  bitmaps.get(path)?.close();
  bitmaps.set(path, bitmap);
};

export const getBitmap = (path: string): ImageBitmap | undefined =>
  bitmaps.get(path);

export const hasBitmap = (path: string): boolean => bitmaps.has(path);

export const deleteBitmap = (path: string): void => {
  bitmaps.get(path)?.close();
  bitmaps.delete(path);
};

export const clearBitmaps = (): void => {
  for (const bitmap of bitmaps.values()) {
    bitmap.close();
  }
  bitmaps.clear();
};

export const bitmapBytes = (): number => {
  let total = 0;
  for (const bitmap of bitmaps.values()) {
    total += bitmap.width * bitmap.height * 4;
  }
  return total;
};

export const bitmapPaths = (): string[] => [...bitmaps.keys()];
```

- [ ] **Step 4: green 確認**

Run: `npx vitest --run src/utils/__tests__/bitmapCache.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: biome + type-check + コミット**

```bash
npx biome format --write src/constants/memory.ts src/utils/bitmapCache.ts src/utils/__tests__/bitmapCache.test.ts
npx biome lint src/constants/memory.ts src/utils/bitmapCache.ts src/utils/__tests__/bitmapCache.test.ts
npm run type-check
git add src/constants/memory.ts src/utils/bitmapCache.ts src/utils/__tests__/bitmapCache.test.ts
git commit -m "feat(cache): decoded-bitmap cache with deterministic close()"
```

---

### Task 2: computeWindow（純関数）

**Files:**
- Create: `src/utils/preloadWindow.ts`
- Test: `src/utils/__tests__/preloadWindow.test.ts`

**Interfaces:**
- Consumes: `BITMAP_WINDOW_SIZE`（Task 1）
- Produces: `computeWindow(index: number, direction: 1 | -1, length: number, size?: number): number[]` — 優先順（=デコード順）の近傍 index 列。Task 4 が使用

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/utils/__tests__/preloadWindow.test.ts
import { describe, expect, it } from "vitest";
import { computeWindow } from "../preloadWindow";

describe("computeWindow", () => {
  it("forward mid-folder: 3 ahead then 1 behind", () => {
    expect(computeWindow(5, 1, 16)).toEqual([6, 7, 8, 4]);
  });

  it("backward mid-folder is the mirror", () => {
    expect(computeWindow(5, -1, 16)).toEqual([4, 3, 2, 6]);
  });

  it("at index 0 forward, fills from ahead only", () => {
    expect(computeWindow(0, 1, 16)).toEqual([1, 2, 3, 4]);
  });

  it("at the last index forward, fills from behind", () => {
    expect(computeWindow(15, 1, 16)).toEqual([14, 13, 12, 11]);
  });

  it("two-image folder yields the single neighbor", () => {
    expect(computeWindow(1, 1, 2)).toEqual([0]);
    expect(computeWindow(0, 1, 2)).toEqual([1]);
  });

  it("single-image folder yields nothing", () => {
    expect(computeWindow(0, 1, 1)).toEqual([]);
  });

  it("respects an explicit size", () => {
    expect(computeWindow(5, 1, 16, 2)).toEqual([6, 7]);
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest --run src/utils/__tests__/preloadWindow.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装**

```ts
// src/utils/preloadWindow.ts
import { BITMAP_WINDOW_SIZE } from "../constants/memory";

/**
 * Priority-ordered neighbor indices to keep decoded around `index`
 * (order = decode order). Forward: [i+1, i+2, i+3, i-1], then further
 * ahead, then further behind; backward is the mirror. 3 steps of lead at
 * the 250ms navigation floor gives ~750ms, enough for a ~400ms decode at
 * MAX_CONCURRENT_LOADS parallelism. See the design spec
 * (docs/superpowers/specs/2026-08-16-nav-rapid-bitmap-window-design.md).
 */
export const computeWindow = (
  index: number,
  direction: 1 | -1,
  length: number,
  size: number = BITMAP_WINDOW_SIZE,
): number[] => {
  const candidates: number[] = [
    index + direction,
    index + 2 * direction,
    index + 3 * direction,
    index - direction,
  ];
  for (let k = 4; k < length; k++) candidates.push(index + k * direction);
  for (let k = 2; k < length; k++) candidates.push(index - k * direction);

  const result: number[] = [];
  for (const i of candidates) {
    if (i >= 0 && i < length && i !== index && !result.includes(i)) {
      result.push(i);
    }
    if (result.length === size) break;
  }
  return result;
};
```

- [ ] **Step 4: green 確認**

Run: `npx vitest --run src/utils/__tests__/preloadWindow.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: biome + type-check + コミット**

```bash
npx biome format --write src/utils/preloadWindow.ts src/utils/__tests__/preloadWindow.test.ts
npx biome lint src/utils/preloadWindow.ts src/utils/__tests__/preloadWindow.test.ts
npm run type-check
git add src/utils/preloadWindow.ts src/utils/__tests__/preloadWindow.test.ts
git commit -m "feat(preload): direction-biased decode window"
```

---

### Task 3: bitmapLoader（fetch→blob→createImageBitmap + element 保持ヘルパ）

**Files:**
- Create: `src/utils/bitmapLoader.ts`
- Test: `src/utils/__tests__/bitmapLoader.test.ts`

**Interfaces:**
- Consumes: `imageSrc(path)` / `imageFormat(path)`（`src/utils/imageSrc.ts` 既存）、`setBitmap`（Task 1）
- Produces: `loadBitmapViaProtocol(path: string, signal?: AbortSignal): Promise<{ data: ImageData; bitmap: ImageBitmap }>`（Task 4 が使用）; `retainElementAsBitmap(path: string, element: HTMLImageElement): void`（Task 5 が使用）

- [ ] **Step 1: 失敗するテストを書く**

```ts
// src/utils/__tests__/bitmapLoader.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearBitmaps, getBitmap } from "../bitmapCache";
import { loadBitmapViaProtocol, retainElementAsBitmap } from "../bitmapLoader";

const fakeBitmap = (width: number, height: number) =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

describe("bitmapLoader", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => new Blob() })),
    );
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => fakeBitmap(800, 1200)),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearBitmaps();
  });

  it("fetches the protocol URL and returns bitmap-derived ImageData", async () => {
    const { data, bitmap } = await loadBitmapViaProtocol("C:\\pics\\a.jpg");
    expect(fetch).toHaveBeenCalledWith(
      `http://spica-img.localhost/${encodeURIComponent("C:\\pics\\a.jpg")}`,
      { signal: undefined },
    );
    expect(bitmap.width).toBe(800);
    expect(data).toEqual({
      path: "C:\\pics\\a.jpg",
      src: `http://spica-img.localhost/${encodeURIComponent("C:\\pics\\a.jpg")}`,
      width: 800,
      height: 1200,
      format: "jpg",
    });
  });

  it("does not emit a src:set perf mark (bench pairing must stay clean)", async () => {
    window.__PERF__ = [];
    await loadBitmapViaProtocol("C:\\pics\\a.jpg");
    expect((window.__PERF__ ?? []).find((e) => e.name === "src:set")).toBeUndefined();
  });

  it("throws on a non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);
    await expect(loadBitmapViaProtocol("C:\\pics\\a.jpg")).rejects.toThrow(
      /404/,
    );
  });

  it("forwards the abort signal to fetch", async () => {
    const controller = new AbortController();
    await loadBitmapViaProtocol("C:\\pics\\a.jpg", controller.signal);
    expect(fetch).toHaveBeenCalledWith(expect.any(String), {
      signal: controller.signal,
    });
  });

  it("retainElementAsBitmap enters the decoded element into the cache", async () => {
    const element = new Image();
    retainElementAsBitmap("C:\\pics\\a.jpg", element);
    await vi.waitFor(() => {
      expect(getBitmap("C:\\pics\\a.jpg")).toBeDefined();
    });
    expect(createImageBitmap).toHaveBeenCalledWith(element);
  });

  it("retainElementAsBitmap is a no-op without createImageBitmap support", () => {
    vi.stubGlobal("createImageBitmap", undefined);
    expect(() => retainElementAsBitmap("C:\\pics\\a.jpg", new Image())).not.toThrow();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest --run src/utils/__tests__/bitmapLoader.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装**

```ts
// src/utils/bitmapLoader.ts
/**
 * Loads an image over the spica-img protocol and decodes it to an
 * ImageBitmap off the main thread. Deliberately does NOT go through an
 * HTMLImageElement and emits no `src:set` perf mark: the scheduler's loads
 * must not depend on the renderer image cache nor pollute the fetch_decode
 * bench pairing (src:set -> decode:done belongs to the viewer path).
 * EXIF orientation follows createImageBitmap's default ("from-image"),
 * matching <img>; width/height are post-orientation.
 */
import type { ImageData } from "../types";
import { setBitmap } from "./bitmapCache";
import { imageFormat, imageSrc } from "./imageSrc";

export const loadBitmapViaProtocol = async (
  path: string,
  signal?: AbortSignal,
): Promise<{ data: ImageData; bitmap: ImageBitmap }> => {
  const src = imageSrc(path);
  const response = await fetch(src, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${path} (${response.status})`);
  }
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  return {
    data: {
      path,
      src,
      width: bitmap.width,
      height: bitmap.height,
      format: imageFormat(path),
    },
    bitmap,
  };
};

/**
 * Best-effort: enter a viewer-loaded, already-decoded element into the
 * bitmap cache so a revisit paints without re-decoding (fixes the
 * "ImageViewer loads are never retained" asymmetry). Fire-and-forget and
 * off the main thread; the scheduler evicts it when it leaves the window.
 */
export const retainElementAsBitmap = (
  path: string,
  element: HTMLImageElement,
): void => {
  if (typeof createImageBitmap !== "function") return;
  void createImageBitmap(element)
    .then((bitmap) => setBitmap(path, bitmap))
    .catch(() => {
      /* retention is opportunistic; the scheduler can redo it */
    });
};
```

- [ ] **Step 4: green 確認**

Run: `npx vitest --run src/utils/__tests__/bitmapLoader.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: biome + type-check + コミット**

```bash
npx biome format --write src/utils/bitmapLoader.ts src/utils/__tests__/bitmapLoader.test.ts
npx biome lint src/utils/bitmapLoader.ts src/utils/__tests__/bitmapLoader.test.ts
npm run type-check
git add src/utils/bitmapLoader.ts src/utils/__tests__/bitmapLoader.test.ts
git commit -m "feat(preload): off-main bitmap loader over spica-img"
```

---

### Task 4: スケジューラ（useImagePreloader 作り直し）

**Files:**
- Modify: `src/hooks/useImagePreloader.ts`（全面書き換え）
- Test: `src/hooks/__tests__/useImagePreloader.test.ts`（全面書き換え — 旧 API `preloadImage`/`startPreloading`/`cleanupCache` 前提のテストは新挙動の検証に置換）

**Interfaces:**
- Consumes: Task 1–3 の全 API、`MAX_CONCURRENT_LOADS`（timing 既存）、store（`folder`/`currentImage`/`thumbnailGeneration`/`ui`/`setPreloadedImage`/`removePreloadedImage`）
- Produces: `useImagePreloader(): void`（戻り値なし。ImageViewer は既にマウントのみ — `useImagePreloader();` — なので呼び出し側変更不要）。挙動契約: `preload:done` イベント / `cache.preloaded` 反映 / 不変条件 preloaded ⊆ bitmapCache ∪ {current}（非 GIF）

- [ ] **Step 1: 新テストを書く（旧ファイルを置換）**

```ts
// src/hooks/__tests__/useImagePreloader.test.ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageData, ImageInfo } from "../../types";
import {
  clearBitmaps,
  getBitmap,
  hasBitmap,
  setBitmap,
} from "../../utils/bitmapCache";
import { _setPerfEnabledForTests } from "../../utils/perf";

const fakeBitmap = (width = 10, height = 10) =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;

const imageInfo = (i: number, overrides: Partial<ImageInfo> = {}): ImageInfo => ({
  path: `/test/image${i}.jpg`,
  filename: `image${i}.jpg`,
  size: 1024,
  modified: 1700000000000 - i,
  format: "jpeg",
  ...overrides,
});

const fullData = (path: string): ImageData => ({
  path,
  src: `http://spica-img.localhost/x`,
  width: 800,
  height: 600,
  format: "jpg",
});

// The scheduler reads live state via useAppStore.getState(), so the mock
// exposes the same object through both the hook call and getState.
const mockStore = {
  folder: { path: "/test", images: [] as ImageInfo[] },
  currentImage: {
    index: -1,
    path: "",
    data: null as ImageData | null,
  },
  cache: { preloaded: new Map<string, ImageData>() },
  thumbnailGeneration: { allGenerated: true },
  ui: { thumbnailDisplayed: false },
  // Mirrors the real store: the scheduler's no-retry guard reads
  // cache.preloaded, so the mock MUST actually write the entry — otherwise
  // a rejected load pumps itself forever.
  setPreloadedImage: vi.fn((path: string, data: ImageData) => {
    mockStore.cache.preloaded.set(path, data);
  }),
  removePreloadedImage: vi.fn((path: string) => {
    mockStore.cache.preloaded.delete(path);
  }),
};

vi.mock("../../store", () => {
  const mockUseAppStore = vi.fn(() => mockStore);
  (mockUseAppStore as unknown as { getState: () => typeof mockStore }).getState =
    () => mockStore;
  return { useAppStore: mockUseAppStore };
});

vi.mock("../../utils/bitmapLoader", () => ({
  loadBitmapViaProtocol: vi.fn(),
  retainElementAsBitmap: vi.fn(),
}));

import { useImagePreloader } from "../useImagePreloader";
import { loadBitmapViaProtocol } from "../../utils/bitmapLoader";

const mockLoad = vi.mocked(loadBitmapViaProtocol);

/** Configure the store as "index navigated to i, full-res displayed". */
const showFullRes = (index: number) => {
  mockStore.currentImage.index = index;
  mockStore.currentImage.path = mockStore.folder.images[index]?.path ?? "";
  mockStore.currentImage.data = fullData(mockStore.currentImage.path);
  mockStore.ui.thumbnailDisplayed = false;
};

const flush = async () => {
  // Drain chained load->settle->pump microtask rounds (launch, settle,
  // finally-pump, second launch, ...).
  await act(async () => {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  });
};

describe("useImagePreloader (bitmap window scheduler)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearBitmaps();
    mockStore.folder.path = "/test";
    mockStore.folder.images = Array.from({ length: 16 }, (_, i) => imageInfo(i));
    mockStore.currentImage.index = -1;
    mockStore.currentImage.path = "";
    mockStore.currentImage.data = null;
    mockStore.cache.preloaded = new Map();
    mockStore.thumbnailGeneration.allGenerated = true;
    mockStore.ui.thumbnailDisplayed = false;
    mockLoad.mockImplementation(async (path: string) => ({
      data: fullData(path),
      bitmap: fakeBitmap(),
    }));
  });

  afterEach(() => {
    clearBitmaps();
    _setPerfEnabledForTests(null);
    window.__PERF__ = [];
  });

  it("launches window decodes immediately (no delay timer), capped at 3", async () => {
    showFullRes(0);
    renderHook(() => useImagePreloader());
    // synchronous launch on mount: [1,2,3,4] capped at MAX_CONCURRENT_LOADS
    expect(mockLoad.mock.calls.map((c) => c[0])).toEqual([
      "/test/image1.jpg",
      "/test/image2.jpg",
      "/test/image3.jpg",
    ]);
  });

  it("pumps the next target when a slot frees, and caches + reports results", async () => {
    _setPerfEnabledForTests(true);
    showFullRes(0);
    renderHook(() => useImagePreloader());
    await flush();
    // 4th target launched after a completion freed a slot
    expect(mockLoad.mock.calls.map((c) => c[0])).toContain("/test/image4.jpg");
    await flush();
    expect(hasBitmap("/test/image1.jpg")).toBe(true);
    expect(mockStore.setPreloadedImage).toHaveBeenCalledWith(
      "/test/image1.jpg",
      fullData("/test/image1.jpg"),
    );
    const done = (window.__PERF__ ?? []).filter((e) => e.name === "preload:done");
    expect(done.map((e) => e.detail?.path)).toContain("/test/image1.jpg");
  });

  it("does not start while a thumbnail placeholder is displayed", () => {
    showFullRes(0);
    mockStore.ui.thumbnailDisplayed = true;
    renderHook(() => useImagePreloader());
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("does not start before all thumbnails are generated", () => {
    showFullRes(0);
    mockStore.thumbnailGeneration.allGenerated = false;
    renderHook(() => useImagePreloader());
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("prefers the backward neighbor first when navigating backward", async () => {
    showFullRes(8);
    const { rerender } = renderHook(() => useImagePreloader());
    await flush();
    mockLoad.mockClear();
    clearBitmaps();
    showFullRes(7); // 8 -> 7 = backward
    rerender();
    expect(mockLoad.mock.calls[0][0]).toBe("/test/image6.jpg");
  });

  it("skips GIFs", async () => {
    mockStore.folder.images[1] = imageInfo(1, { format: "gif" });
    showFullRes(0);
    renderHook(() => useImagePreloader());
    const paths = mockLoad.mock.calls.map((c) => c[0]);
    expect(paths).not.toContain("/test/image1.jpg");
  });

  it("evicts bitmap + preload entry when a path leaves the window", async () => {
    const far = fakeBitmap();
    setBitmap("/test/image15.jpg", far);
    mockStore.cache.preloaded.set("/test/image15.jpg", fullData("/test/image15.jpg"));
    showFullRes(0);
    renderHook(() => useImagePreloader());
    expect(far.close).toHaveBeenCalledOnce();
    expect(hasBitmap("/test/image15.jpg")).toBe(false);
    expect(mockStore.removePreloadedImage).toHaveBeenCalledWith(
      "/test/image15.jpg",
    );
  });

  it("marks failed loads as error entries and does not retry them", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockLoad.mockRejectedValue(new Error("boom"));
    showFullRes(0);
    const { rerender } = renderHook(() => useImagePreloader());
    await flush();
    expect(mockStore.setPreloadedImage).toHaveBeenCalledWith("/test/image1.jpg", {
      path: "/test/image1.jpg",
      src: "",
      width: 0,
      height: 0,
      format: "error",
    });
    // the mock wrote the error entries into cache.preloaded; re-render: no retry
    mockLoad.mockClear();
    rerender();
    await flush();
    expect(mockLoad).not.toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it("clears all bitmaps when the folder changes", async () => {
    showFullRes(0);
    const { rerender } = renderHook(() => useImagePreloader());
    await flush();
    expect(getBitmap("/test/image1.jpg")).toBeDefined();
    mockStore.folder.path = "/other";
    rerender();
    expect(getBitmap("/test/image1.jpg")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest --run src/hooks/__tests__/useImagePreloader.test.ts`
Expected: FAIL（旧実装は旧 API を返す / 即時起動しない）

- [ ] **Step 3: 実装（全面置換）**

```ts
// src/hooks/useImagePreloader.ts
import { useCallback, useEffect, useRef } from "react";
import {
  BITMAP_CACHE_BUDGET_BYTES,
  BITMAP_WINDOW_SIZE,
} from "../constants/memory";
import { MAX_CONCURRENT_LOADS } from "../constants/timing";
import { useAppStore } from "../store";
import type { ImageData } from "../types";
import {
  bitmapBytes,
  bitmapPaths,
  clearBitmaps,
  deleteBitmap,
  hasBitmap,
  setBitmap,
} from "../utils/bitmapCache";
import { loadBitmapViaProtocol } from "../utils/bitmapLoader";
import { getFilename } from "../utils/path";
import { perfEvent } from "../utils/perf";
import { computeWindow } from "../utils/preloadWindow";

/**
 * Decoded-bitmap window scheduler (hypothesis C). Keeps the current image's
 * neighbors decoded as ImageBitmaps so a preload-hit navigation paints at
 * full resolution without re-decoding. Launches immediately on index change
 * (the old PRELOAD_DELAY_MS timer meant nothing ever preloaded during rapid
 * navigation), but only once the current image itself is displayed at full
 * resolution, so window decodes never compete with the decode the user is
 * waiting for (protects NAV_cold / TTFI_cold).
 * Invariant (non-GIF): cache.preloaded ⊆ bitmapCache ∪ {current} — eviction
 * always removes both, so a "preloaded" hit implies decoded pixels exist.
 */
export const useImagePreloader = (): void => {
  const { folder, currentImage, thumbnailGeneration, ui } = useAppStore();

  const directionRef = useRef<1 | -1>(1);
  const prevIndexRef = useRef(-1);
  const pendingRef = useRef(new Map<string, AbortController>());

  const currentReady =
    currentImage.data !== null &&
    currentImage.data.width > 0 &&
    !ui.thumbnailDisplayed;

  /**
   * Recomputes the retained set from live state, evicts what fell out,
   * and fills free load slots in priority order. Called from the index
   * effect and from every load completion (to pump queued targets).
   */
  const pump = useCallback(() => {
    const state = useAppStore.getState();
    const images = state.folder.images;
    const index = state.currentImage.index;
    if (index < 0 || index >= images.length) return;
    if (!state.thumbnailGeneration.allGenerated) return;
    const data = state.currentImage.data;
    if (!data || data.width <= 0 || state.ui.thumbnailDisplayed) return;

    const windowIndices = computeWindow(
      index,
      directionRef.current,
      images.length,
      BITMAP_WINDOW_SIZE,
    );
    const currentPath = images[index].path;
    const keep = new Set<string>([currentPath]);
    for (const i of windowIndices) keep.add(images[i].path);

    // Evict decoded bitmaps (and their preload entries) outside the window.
    for (const path of bitmapPaths()) {
      if (!keep.has(path)) {
        deleteBitmap(path);
        state.removePreloadedImage(path);
        console.log(`Cleaned from preload cache: ${getFilename(path)}`);
      }
    }
    // Budget guard for oversized images: evict farthest-first, never current.
    const ranked = [currentPath, ...windowIndices.map((i) => images[i].path)];
    while (bitmapBytes() > BITMAP_CACHE_BUDGET_BYTES) {
      const victim = [...ranked]
        .reverse()
        .find((p) => p !== currentPath && hasBitmap(p));
      if (!victim) break;
      deleteBitmap(victim);
      state.removePreloadedImage(victim);
    }
    // Abort loads whose target left the window.
    for (const [path, controller] of pendingRef.current) {
      if (!keep.has(path)) {
        controller.abort();
        pendingRef.current.delete(path);
      }
    }

    // Fill free slots in priority order.
    for (const i of windowIndices) {
      if (pendingRef.current.size >= MAX_CONCURRENT_LOADS) break;
      const info = images[i];
      if (info.format === "gif") continue;
      const path = info.path;
      if (hasBitmap(path) || pendingRef.current.has(path)) continue;
      if (state.cache.preloaded.get(path)?.format === "error") continue;

      const controller = new AbortController();
      pendingRef.current.set(path, controller);
      void loadBitmapViaProtocol(path, controller.signal)
        .then(({ data: loaded, bitmap }) => {
          if (!pendingRef.current.has(path)) {
            bitmap.close(); // aborted or evicted while decoding
            return;
          }
          setBitmap(path, bitmap);
          useAppStore.getState().setPreloadedImage(path, loaded);
          perfEvent("preload:done", { path });
          console.log(`Preloaded bitmap: ${getFilename(path)}`);
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          console.warn(`Failed to preload image: ${getFilename(path)}`, error);
          const errorData: ImageData = {
            path,
            src: "",
            width: 0,
            height: 0,
            format: "error",
          };
          useAppStore.getState().setPreloadedImage(path, errorData);
        })
        .finally(() => {
          pendingRef.current.delete(path);
          pump();
        });
    }
  }, []);

  // Folder change invalidates every retained bitmap and in-flight load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: folder.path is the intentional reset trigger; the effect body must not read it
  useEffect(() => {
    clearBitmaps();
    for (const controller of pendingRef.current.values()) controller.abort();
    pendingRef.current.clear();
    prevIndexRef.current = -1;
    directionRef.current = 1;
  }, [folder.path]);

  useEffect(() => {
    const index = currentImage.index;
    if (index !== prevIndexRef.current) {
      if (prevIndexRef.current !== -1 && index !== -1) {
        directionRef.current = index > prevIndexRef.current ? 1 : -1;
      }
      prevIndexRef.current = index;
    }
    if (index === -1 || !thumbnailGeneration.allGenerated || !currentReady) {
      return;
    }
    pump();
  }, [
    currentImage.index,
    folder.images,
    thumbnailGeneration.allGenerated,
    currentReady,
    pump,
  ]);

  // Abort in-flight loads on unmount.
  useEffect(
    () => () => {
      for (const controller of pendingRef.current.values()) controller.abort();
      pendingRef.current.clear();
    },
    [],
  );
};
```

- [ ] **Step 4: green 確認 + 依存箇所の確認**

Run: `npx vitest --run src/hooks/__tests__/useImagePreloader.test.ts`
Expected: PASS（9 tests）

Run: `grep -rn "useImagePreloader\|retainedImages\|PRELOAD_DELAY_MS\|PRELOAD_RANGE" src/`
Expected: `useImagePreloader` の利用は `ImageViewer.tsx`（マウントのみ）とテストのみ / `retainedImages` の残存参照なし / `PRELOAD_DELAY_MS`・`PRELOAD_RANGE` は `constants/timing.ts` の定義と **`useThumbnailGenerator` 等の他利用者のみ**（あれば残す。preloader からの参照は消える。定義自体は削除しない — e2e の `bench.perf.ts` が `PRELOAD_RANGE` のミラー値を持つため定義を残して整合を保つ）

- [ ] **Step 5: 全体テスト + biome + type-check + コミット**

```bash
npx vitest --run
npx biome format --write src/hooks/useImagePreloader.ts src/hooks/__tests__/useImagePreloader.test.ts
npx biome lint src/hooks/useImagePreloader.ts src/hooks/__tests__/useImagePreloader.test.ts
npm run type-check
git add src/hooks/useImagePreloader.ts src/hooks/__tests__/useImagePreloader.test.ts
git commit -m "feat(preload): immediate direction-aware bitmap window scheduler"
```

`npx vitest --run` で ImageViewer など他テストが落ちた場合: 旧 preloader API に依存していないか確認し、依存があればそのテストを新 API（マウントのみ）に合わせて修正してからコミット。

---

### Task 5: ImageViewer canvas hit パス + cold ロードの bitmap 化

**Files:**
- Create: `src/utils/canvasDraw.ts`
- Modify: `src/components/ImageViewer.tsx`
- Test: `src/components/__tests__/ImageViewer.test.tsx`（既存 green 維持 + canvas ケース追加）

**Interfaces:**
- Consumes: `getBitmap`（Task 1）、`retainElementAsBitmap`（Task 3）
- Produces: `drawBitmapToCanvas(canvas: HTMLCanvasElement, bitmap: ImageBitmap): void`。描画契約: bitmap があり data がフル解像度なら `<canvas>`（`paint:done` thumbnail:false を double rAF で発行）、なければ既存 `<img>` パス（無変更）

- [ ] **Step 1: canvasDraw を書く**

```ts
// src/utils/canvasDraw.ts
/**
 * Sizes the canvas to the bitmap and paints it in one place, so component
 * tests can mock this module (jsdom has no 2D context). After drawImage the
 * canvas owns its own backing pixels — evicting/closing the source bitmap
 * afterwards is safe.
 */
export const drawBitmapToCanvas = (
  canvas: HTMLCanvasElement,
  bitmap: ImageBitmap,
): void => {
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.drawImage(bitmap, 0, 0);
  }
};
```

- [ ] **Step 2: 失敗するテストを追加（既存 describe 群の末尾に追記）**

既存 `src/components/__tests__/ImageViewer.test.tsx` の mock 群に以下を追加:

```ts
vi.mock("../../utils/canvasDraw", () => ({
  drawBitmapToCanvas: vi.fn(),
}));
```

import 群の下（`const mockLoadImageViaProtocol = ...` の隣）に:

```ts
import { drawBitmapToCanvas } from "../../utils/canvasDraw";
import { clearBitmaps, setBitmap } from "../../utils/bitmapCache";
import { _setPerfEnabledForTests } from "../../utils/perf";

const fakeBitmap = (width: number, height: number) =>
  ({ width, height, close: vi.fn() }) as unknown as ImageBitmap;
```

`beforeEach` の末尾に `clearBitmaps();` を追加した上で、テスト追加:

```ts
describe("Canvas hit path (decoded bitmap window)", () => {
  const path = "C:\\photos\\hit.jpg";
  const data = {
    path,
    src: PROTOCOL_SRC(path),
    width: 800,
    height: 600,
    format: "jpg",
  };

  it("renders a canvas and draws the retained bitmap when available", () => {
    setBitmap(path, fakeBitmap(800, 600));
    mockStore.currentImage.path = path;
    mockStore.currentImage.data = data;

    const { container } = render(<ImageViewer />);

    expect(container.querySelector("canvas")).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(drawBitmapToCanvas).toHaveBeenCalledOnce();
  });

  it("falls back to <img> when no bitmap is cached", () => {
    mockStore.currentImage.path = path;
    mockStore.currentImage.data = data;

    const { container } = render(<ImageViewer />);

    expect(container.querySelector("img")).toBeInTheDocument();
    expect(container.querySelector("canvas")).not.toBeInTheDocument();
  });

  it("falls back to <img> while a thumbnail placeholder is displayed", () => {
    setBitmap(path, fakeBitmap(800, 600));
    mockStore.currentImage.path = path;
    mockStore.currentImage.data = data;
    mockStore.ui.thumbnailDisplayed = true;

    const { container } = render(<ImageViewer />);

    expect(container.querySelector("img")).toBeInTheDocument();
    expect(container.querySelector("canvas")).not.toBeInTheDocument();
  });

  it("emits a full-resolution paint:done from the canvas path", async () => {
    _setPerfEnabledForTests(true);
    window.__PERF__ = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    setBitmap(path, fakeBitmap(800, 600));
    mockStore.currentImage.path = path;
    mockStore.currentImage.data = data;

    render(<ImageViewer />);

    const paint = (window.__PERF__ ?? []).find((e) => e.name === "paint:done");
    expect(paint?.detail).toEqual({ path, thumbnail: false });
    vi.unstubAllGlobals();
    _setPerfEnabledForTests(null);
    window.__PERF__ = [];
  });
});
```

Run: `npx vitest --run src/components/__tests__/ImageViewer.test.tsx`
Expected: 新 4 ケース FAIL（canvas 未実装）、既存は PASS のまま

- [ ] **Step 3: ImageViewer を実装**

`src/components/ImageViewer.tsx` への変更（既存 543 行の構造は維持し、以下の差分を適用）:

1. import 追加:
```ts
import { getBitmap } from "../utils/bitmapCache";
import { retainElementAsBitmap } from "../utils/bitmapLoader";
import { drawBitmapToCanvas } from "../utils/canvasDraw";
```
2. ref 追加（`imageRef` の隣）:
```ts
const canvasRef = useRef<HTMLCanvasElement>(null);
```
3. **cold ロードの bitmap 化**: `loadImage` 内の非 GIF 3 サイト（thumbnail upgrade / two-phase PHASE 2 / direct load）で、`const fullImageData = (await loadImageViaProtocol(path)).data;` を
```ts
const { data: fullImageData, element } = await loadImageViaProtocol(path);
```
に変え、各サイトの `setPreloadedImage(path, fullImageData);` の直後に
```ts
retainElementAsBitmap(path, element);
```
を追加（3 サイトとも同一。GIF 分岐は触らない）。
4. **描画分岐**: JSX の `{currentImage.data && (<img ... />)}` を次に置換:
```tsx
{currentImage.data && displayBitmap && (
  <canvas
    ref={canvasRef}
    role="img"
    aria-label={getFilename(currentImage.path) || "Current image"}
    style={imageStyle}
    onMouseDown={handleMouseDown}
    onDoubleClick={handleDoubleClick}
  />
)}
{currentImage.data && !displayBitmap && (
  <img
    ref={imageRef}
    src={currentImage.data.src}
    alt={getFilename(currentImage.path) || "Current image"}
    style={imageStyle}
    onMouseDown={handleMouseDown}
    onDoubleClick={handleDoubleClick}
    draggable={false}
  />
)}
```
`displayBitmap` はコンポーネント本体（`imageStyle` 定義の前）で:
```ts
// A retained decoded bitmap lets us paint at full resolution without the
// <img> re-decode. Read at render time: hits have their bitmap by the time
// navigation re-renders; cold loads keep the <img> path for their lifetime.
const displayBitmap =
  currentImage.data &&
  currentImage.data.width > 0 &&
  !ui.thumbnailDisplayed &&
  currentImage.data.path === currentImage.path
    ? getBitmap(currentImage.path)
    : undefined;
```
（`ui` は既に store から取得済み）
5. **描画 effect**（perf effect の直前に追加。ブラウザの paint 前に描くため layout effect）:
```ts
// Paint the retained bitmap before the frame is presented. The canvas owns
// its own backing pixels afterwards, so later eviction of the bitmap is safe.
useLayoutEffect(() => {
  const canvas = canvasRef.current;
  const data = currentImage.data;
  if (!canvas || !data) return;
  const bitmap = getBitmap(data.path);
  if (bitmap) {
    drawBitmapToCanvas(canvas, bitmap);
  }
}, [currentImage.data]);
```
（`useLayoutEffect` を react の import に追加）
6. **perf effect の分岐**: 既存の decode/paint effect（`imageRef.current` の `img.decode()` を使う箇所）の `const img = imageRef.current;` の前に:
```ts
if (canvasRef.current) {
  // Canvas path: pixels are already decoded; only the paint mark applies.
  markPaint();
  return () => {
    cancelled = true;
  };
}
```
7. **イベントターゲット判定の統一**: `handleContainerClick` の `e.target === imageRef.current`、`handleMouseDown` / `handleDoubleClick` の同判定を
```ts
const isDisplayTarget =
  e.target === imageRef.current || e.target === canvasRef.current;
```
の形にそれぞれ置換（3 箇所。`handleMouseDown` は `if (isDisplayTarget)`、`handleDoubleClick` も同様、`handleContainerClick` は `const isImageClick = e.target === imageRef.current || e.target === canvasRef.current;`）。

- [ ] **Step 4: green 確認（新 + 既存全部）**

Run: `npx vitest --run src/components/__tests__/ImageViewer.test.tsx`
Expected: PASS（既存 + 新 4）

Run: `npx vitest --run`
Expected: 全件 PASS

- [ ] **Step 5: biome + type-check + コミット**

```bash
npx biome format --write src/utils/canvasDraw.ts src/components/ImageViewer.tsx src/components/__tests__/ImageViewer.test.tsx
npx biome lint src/utils/canvasDraw.ts src/components/ImageViewer.tsx src/components/__tests__/ImageViewer.test.tsx
npm run type-check
git add src/utils/canvasDraw.ts src/components/ImageViewer.tsx src/components/__tests__/ImageViewer.test.tsx
git commit -m "feat(viewer): canvas paint for retained bitmaps + retain viewer loads"
```

---

### Task 6: E2E 更新（selector + exif hit-canvas 視覚ケース + corpus）

**Files:**
- Modify: `e2e/scripts/generate-corpus.mjs`（exif/img-001.jpg 追加）
- Modify: `e2e/specs/visual.e2e.ts`

**Interfaces:**
- Consumes: `__SPICA_TEST__` フック（既存）、Task 5 の canvas 描画（hit で `.image-viewer canvas` が現れる）
- Produces: なし（検証のみ）

- [ ] **Step 1: corpus に exif/img-001.jpg（orientation なし）を追加**

`e2e/scripts/generate-corpus.mjs` の exif ブロック（`const file = join(dir, "img-000.jpg");` を含む `{}` ブロック）の直後・`console.log("corpus ready");` の前に:

```js
// Plain companion image in the exif set, so the hit-canvas visual test can
// open it first and then navigate to img-000 as a preload hit.
{
  const dir = join(OUT, "exif");
  const file = join(dir, "img-001.jpg");
  if (!existsSync(file)) {
    const width = 1200;
    const height = 800;
    const rand = mulberry32(99002);
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
```

Run: `npm run bench:corpus` → `exif/img-001.jpg generated`（既存ファイルはスキップされる）

- [ ] **Step 2: visual.e2e.ts の navigation テストを canvas 対応にする**

`"navigation keeps the image visible"` の waitUntil 内 execute を次に置換（hit は `<canvas>`、miss は `<img>` のどちらも許容）:

```ts
await browser.waitUntil(
  async () =>
    browser.execute(() => {
      const img = document.querySelector(".image-viewer img");
      if (img instanceof HTMLImageElement && img.naturalWidth > 0) return true;
      const canvas = document.querySelector(".image-viewer canvas");
      return canvas instanceof HTMLCanvasElement && canvas.width > 0;
    }),
  {
    timeout: 60000,
    timeoutMsg: "no visible image or canvas after navigation",
  },
);
```

- [ ] **Step 3: exif hit-canvas 視覚ケースを追加**

`visual.e2e.ts` の末尾（既存 exif テストの後）に:

```ts
it("applies EXIF orientation on the canvas hit path", async function () {
  this.timeout(180_000);
  // Open the plain companion; img-000 (orientation 6) becomes the window
  // neighbor and is decoded into the bitmap cache by the scheduler.
  const companion = join(CORPUS, "exif", "img-001.jpg");
  await browser.execute(
    (p: string) => void window.__SPICA_TEST__?.openImage(p),
    companion,
  );
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const status = window.__SPICA_TEST__?.getStatus();
        return (status?.preloadedCount ?? 0) >= 1 && !status?.isLoading;
      }),
    { timeout: 120_000, timeoutMsg: "exif neighbor was never preloaded" },
  );
  await browser.execute(() => window.__SPICA_TEST__?.navigateToImage(0));
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const canvas = document.querySelector(".image-viewer canvas");
        return canvas instanceof HTMLCanvasElement && canvas.width > 0;
      }),
    { timeout: 60_000, timeoutMsg: "hit navigation never painted a canvas" },
  );
  const dims = await browser.execute(() => {
    const canvas = document.querySelector(
      ".image-viewer canvas",
    ) as HTMLCanvasElement;
    return { w: canvas.width, h: canvas.height };
  });
  // encoded 1200x800 + orientation 6 -> createImageBitmap applies EXIF and
  // yields an 800x1200 bitmap, same as what <img> would display.
  expect(dims.w).toBe(800);
  expect(dims.h).toBe(1200);

  mkdirSync(SHOTS, { recursive: true });
  const shot = join(SHOTS, "visual-exif-canvas.png");
  await browser.saveScreenshot(shot);
  const stats = await sharp(shot).stats();
  const maxStdev = Math.max(...stats.channels.map((c) => c.stdev));
  expect(maxStdev).toBeGreaterThan(15);
});
```

- [ ] **Step 4: bench ビルドで E2E 実行**

```bash
npm run bench:build   # ~10 分。バックグラウンド推奨
npm run test:e2e
```
Expected: smoke + visual 全 green（新 exif hit-canvas ケース含む）

- [ ] **Step 5: biome + コミット**

```bash
npx biome format --write e2e/scripts/generate-corpus.mjs e2e/specs/visual.e2e.ts
npx biome lint e2e/scripts/generate-corpus.mjs e2e/specs/visual.e2e.ts
git add e2e/scripts/generate-corpus.mjs e2e/specs/visual.e2e.ts
git commit -m "test(e2e): canvas-aware visual gate + exif hit-canvas case"
```

---

### Task 7: 採否ゲート（bench サイクル — メインセッションで実行）

**Files:**
- Modify（採用時のみ）: `bench-results/baseline.json`、`docs/PERFORMANCE_AUTONOMY_PLAN.md` §8、`docs/PERFORMANCE_NAV_RAPID_PHASE2_HANDOFF.md` 進捗

サブエージェントは `bench:baseline` を権限拒否されるため、このタスクは**メインセッションが実行**する。

- [ ] **Step 1: 前提確認**: `npm test` / `cd src-tauri && cargo test --lib` / `npm run test:e2e` すべて green、Task 6 までコミット済み、working tree clean
- [ ] **Step 2: `npm run bench:build && npm run bench`**（~35 分、バックグラウンド。ベンチ中は他の重負荷処理禁止）
- [ ] **Step 3: 判定**（CLAUDE.md 準拠）: NAV_rapid 中央値が baseline 377.25ms 比 **≥10% 改善** / TTFI_cold・NAV_warm・NAV_cold が p95 の揺れを超えて悪化していない / NAV_rapid・PLACEHOLDER_dur の n=84 完全 / per-run ログ（`NAV_rapid run k:`）で hit の fast 化を確認
- [ ] **Step 4a（採用）**: `npm run bench:baseline` で canonize し、`docs/PERFORMANCE_AUTONOMY_PLAN.md` §8 の表・注記更新と handoff 進捗更新を**同一コミット**に含める
- [ ] **Step 4b（不採用）**: 原因を profiling（`npm run profile:nav-rapid` + analyze）で特定し、結果を handoff に記録して報告。当て推量の追い変更はしない（1 コミット 1 仮説）

---

## Self-Review

- **Spec coverage**: spec §1（bitmapCache/定数）→ Task 1、§2（computeWindow/bitmapLoader/スケジューラ/不変条件/起動ゲート/abort）→ Task 2–4、§3（canvas 分岐/描画 effect/perf 分岐/retain 3 サイト/イベント判定）→ Task 5、§5（E2E exif hit-canvas + corpus、ゲート）→ Task 6–7。§4（store 変更ほぼゼロ）は Task 4 の folder-effect と Task 5 の読み取りのみで整合
- **Placeholder scan**: 全ステップに実コードあり。TBD なし
- **Type consistency**: `computeWindow(index, direction, length, size?)` の引数順は Task 2 定義と Task 4 呼び出しで一致。`loadBitmapViaProtocol` の戻り値 `{data, bitmap}` は Task 3 定義と Task 4 の分割代入で一致。`retainElementAsBitmap(path, element)` は Task 3 定義と Task 5 呼び出しで一致。`drawBitmapToCanvas(canvas, bitmap)` は Task 5 内で一致。`useImagePreloader(): void` — ImageViewer は元々マウントのみで整合
- **bench 互換**: `preload:done` / `preloadedCount` / `preload` イベント / `src:set` 非発行 — Task 4 実装と Global Constraints で担保。`waitForPreloadSettled(5)` は current(viewer 由来) + 窓 4 = 5 で成立
