# サムネイルバーの自動表示・非表示（Picasa 準拠）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** サムネイルバーを普段は不透明度 0 で隠し、バーへのホバーか「下方向への素早い振り」で 500ms のフェードで表示、下への移動が止まって 2000ms か上方向への素早い振りで隠す。

**Architecture:** ジェスチャー判定は DOM もタイマーも持たない純粋な状態機械 `stepBar(state, event)`（`src/utils/thumbnailBarGesture.ts`）に閉じ込め、合成サンプルの表で検証する。`useThumbnailBarVisibility` フックが `window` の `pointermove` とホバー・キーボードフォーカスを状態機械に流し、`hideAt` のタイマーを 1 本だけ管理し、`shown` が反転したときだけ React state を更新する。ThumbnailBar はフックの `shown` をクラス `shown` に反映し、非表示中はクリックとホイールを無視する。レイアウト（80px 帯）は一切変えない。

**Tech Stack:** React 19 / TypeScript 7 / zustand 5 / vitest 4 + jsdom 29 + @testing-library/react 16 / CSS。

**Spec:** `docs/superpowers/specs/2026-09-23-thumbnail-bar-auto-hide-design.md`（以下「スペック」。§ と D 番号はスペックのもの）

## Global Constraints

- レイアウトは変えない（D1）。`viewerLayoutArea`、`THUMBNAIL_BAR_HEIGHT`、`.thumbnail-bar` の `height: 80px` / `position: fixed` に触らない。
- 非表示は `opacity` のみで行い、`display: none` / `visibility: hidden` は使わない（スペック §4.6。`scrollToActiveItem` が `offsetLeft` / `offsetWidth` に依存するため）。
- 閾値（スペック §4.5）: 活性化距離 150px、V_on 800px/s、V_keep 150px/s、速度窓 60ms、停止判定 100ms、傾き上限 45°、逆走許容 4px、非表示遅延 2000ms、フェード 500ms。
- 維持条件は 2 閾値（V_keep < V_on）。1 閾値に単純化しない（D2、ユーザー選択）。
- mousemove ごとに React の再レンダリングを起こさない（`shown` の反転時のみ `setState`）。
- コメントは Why のみ（CLAUDE.md）。新規ファイルの先頭に `// Spec: docs/superpowers/specs/2026-09-23-thumbnail-bar-auto-hide-design.md` を 1 回書き、以降のインラインは `§4.3` / `(D6)` のみ。
- 各コミット前に `npm run lint:fix`、`npm run format:fix`、`npm test` を実行し、lint / format の差分もコミットに含める（サブエージェントの編集では lint/format hook が発火しないため）。
- `package-lock.json` に `npm install` 由来の EOL 差分が出たら `git checkout -- package-lock.json` で戻す。
- `package.json` は CRLF。sed で編集しない（本計画では編集不要）。

## ファイル構成

| ファイル | 種別 | 責務 |
|---|---|---|
| `src/utils/thumbnailBarGesture.ts` | 新規 | 純粋な状態機械（スペック §4）。閾値定数 `THUMBNAIL_BAR_GESTURE` |
| `src/utils/__tests__/thumbnailBarGesture.test.ts` | 新規 | 合成サンプル（60 / 144 / 1000Hz）のテーブル駆動テスト |
| `src/hooks/useThumbnailBarVisibility.ts` | 新規 | イベント購読・タイマー・`shown` の React state |
| `src/hooks/__tests__/useThumbnailBarVisibility.test.ts` | 新規 | 配線のテスト（fake timers） |
| `src/constants/timing.ts` | 変更 | `THUMBNAIL_BAR_HIDE_DELAY_MS = 2000` |
| `src/components/ThumbnailBar.tsx` | 変更 | フックの組み込み、`hovered` → `shown`、非表示中の入力無視 |
| `src/components/__tests__/ThumbnailBar.test.tsx` | 変更 | hover テストの置換と新規テスト |
| `src/App.css` | 変更 | 不透明度 0/1、500ms フェード、`pointer-events`、reduced-motion |
| store / types / testUtils / testFactories / store テスト | 変更 | 未使用の `thumbnailOpacity` / `setThumbnailOpacity` を削除（D10） |
| `PROJECT_SPEC.md` | 変更 | Thumbnail Bar / Image Info Overlay / windowed の記述、`thumbnailOpacity` 削除 |
| スペック | 変更 | §5 の 2 点を実装に合わせて訂正（Task 5 参照） |

## Task 0: worktree の初期化

worktree `.claude/worktrees/thumbnail-bar-auto-hide`（ブランチ `worktree-thumbnail-bar-auto-hide`）で作業する。すべてのコマンドはこのディレクトリで実行する。

- [ ] **Step 1: 依存関係をインストール**

Run: `npm install`
その後 `git status --short` で `package-lock.json` が変わっていれば `git checkout -- package-lock.json`。

- [ ] **Step 2: 既存テストが green であることを確認**

Run: `npm test`
Expected: 全件 PASS（失敗があれば着手前に報告する。release ビルド並走中は vitest の worker 起動タイムアウトが出ることがあり、再実行で通る）。

E2E 用のコーパスと bench ビルド（`npm run bench:corpus` → `npm run bench:build`）は Task 5 で行う。

---

### Task 1: 未使用の `thumbnailOpacity` を削除（D10）

**Files:**
- Modify: `src/store/index.ts`（155 行の `setThumbnailOpacity` 宣言、220 行の初期値、342-348 行の実装）
- Modify: `src/types/index.ts`（80 行と 119 行の `thumbnailOpacity: number;`）
- Modify: `src/utils/testUtils.tsx`（93 行の `thumbnailOpacity: 0.5,`、128 行の `setThumbnailOpacity: vi.fn(),`）
- Modify: `src/utils/testFactories.ts`（86 行と 118 行の `thumbnailOpacity: 0.5,`）
- Test: `src/store/__tests__/index.test.ts`（50 行、87 行、1221-1228 行）

**Interfaces:**
- Consumes: なし
- Produces: `ViewState` と `AppState["view"]` から `thumbnailOpacity` が消え、`AppActions` から `setThumbnailOpacity` が消える。

- [ ] **Step 1: store テストから削除**

`src/store/__tests__/index.test.ts`:
- 50 行付近のリセット用 `view` オブジェクトから `thumbnailOpacity: 0.5,` の行を削除。
- 87 行の `expect(state.view.thumbnailOpacity).toBe(0.5);` を削除。
- 1221-1228 行の `it("should set thumbnail opacity", ...)` ブロック全体を削除:

```ts
    it("should set thumbnail opacity", () => {
      const { setThumbnailOpacity } = useAppStore.getState();

      setThumbnailOpacity(1.0);
      expect(useAppStore.getState().view.thumbnailOpacity).toBe(1.0);

      setThumbnailOpacity(0.3);
      expect(useAppStore.getState().view.thumbnailOpacity).toBe(0.3);
    });
```

- [ ] **Step 2: 本体・型・モックから削除**

- `src/store/index.ts`: `setThumbnailOpacity: (opacity: number) => void;` の行、初期状態の `thumbnailOpacity: 0.5,` の行、実装ブロック全体を削除:

```ts
  setThumbnailOpacity: (opacity) =>
    set((state) => ({
      view: {
        ...state.view,
        thumbnailOpacity: opacity,
      },
    })),

```

- `src/types/index.ts`: 2 箇所の `thumbnailOpacity: number;` を削除。
- `src/utils/testUtils.tsx`: `thumbnailOpacity: 0.5,` と `setThumbnailOpacity: vi.fn(),` を削除。
- `src/utils/testFactories.ts`: 2 箇所の `thumbnailOpacity: 0.5,` を削除。

- [ ] **Step 3: 残存参照が無いことを確認**

Run: `git grep -n "thumbnailOpacity\|setThumbnailOpacity" -- src e2e`
Expected: 出力なし（`PROJECT_SPEC.md` の記述は Task 5 で直す）。

- [ ] **Step 4: 型チェックとテスト**

Run: `npm run type-check && npm run type-check:test && npm test`
Expected: すべて成功。

- [ ] **Step 5: コミット**

```bash
npm run lint:fix && npm run format:fix
git add -A src
git commit -m "refactor(store): drop unused thumbnailOpacity state and action"
```

---

### Task 2: ジェスチャー状態機械（スペック §4）

**Files:**
- Modify: `src/constants/timing.ts`（末尾に定数を追加）
- Create: `src/utils/thumbnailBarGesture.ts`
- Test: `src/utils/__tests__/thumbnailBarGesture.test.ts`

**Interfaces:**
- Consumes: なし
- Produces:
  - `THUMBNAIL_BAR_HIDE_DELAY_MS: number`（`src/constants/timing.ts`、値 2000）
  - `THUMBNAIL_BAR_GESTURE`（閾値。速度は px/ms）
  - `interface BarState { shown: boolean; hideAt: number | null; held: boolean; samples: readonly Sample[]; stroke: Stroke | null }`
  - `type BarEvent = { type: "move"; x: number; y: number; t: number; buttons: number } | { type: "tick"; t: number } | { type: "hoverChange"; held: boolean; t: number } | { type: "forceShow"; t: number }`
  - `initialBarState(t: number): BarState` — 表示状態、`hideAt = t + 2000`
  - `stepBar(state: BarState, event: BarEvent): BarState` — 純関数。入力を変更しない
  - 不変条件: `hideAt` は非 null の間、後ろへしか動かない（フックのタイマー 1 本運用がこれに依存する）

- [ ] **Step 1: 定数を追加**

`src/constants/timing.ts` の末尾に追加:

```ts

/** Spec: docs/superpowers/specs/2026-09-23-thumbnail-bar-auto-hide-design.md §4.5 */
export const THUMBNAIL_BAR_HIDE_DELAY_MS = 2000;
```

- [ ] **Step 2: 失敗するテストを書く**

`src/utils/__tests__/thumbnailBarGesture.test.ts`:

```ts
import { describe, it, expect } from "vitest";

import { THUMBNAIL_BAR_HIDE_DELAY_MS as DELAY } from "../../constants/timing";
import {
  type BarEvent,
  type BarState,
  initialBarState,
  stepBar,
} from "../thumbnailBarGesture";

type Waypoint = [x: number, y: number, t: number];

// Pointer samples at a fixed rate along straight segments between waypoints,
// the way a mouse reports a movement.
function track(points: Waypoint[], hz: number, buttons = 0): BarEvent[] {
  const events: BarEvent[] = [];
  const step = 1000 / hz;
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0, t0] = points[i];
    const [x1, y1, t1] = points[i + 1];
    const n = Math.max(1, Math.round((t1 - t0) / step));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const f = k / n;
      events.push({
        type: "move",
        x: x0 + (x1 - x0) * f,
        y: y0 + (y1 - y0) * f,
        t: t0 + (t1 - t0) * f,
        buttons,
      });
    }
  }
  return events;
}

const run = (state: BarState, events: BarEvent[]) =>
  events.reduce<BarState>((s, e) => stepBar(s, e), state);

const tick = (state: BarState, t: number) => stepBar(state, { type: "tick", t });

// Shown at t=0, hidden by the timer at t=DELAY.
const hidden = () => tick(initialBarState(0), DELAY);

const T = 10_000;

describe("thumbnailBarGesture", () => {
  it("starts shown and hides after the delay", () => {
    const s = initialBarState(0);
    expect(s.shown).toBe(true);
    expect(tick(s, DELAY - 1).shown).toBe(true);
    expect(tick(s, DELAY).shown).toBe(false);
  });

  describe.each([60, 144, 1000])("activation at %iHz", (hz) => {
    it("shows on a fast 240px downward flick", () => {
      const s = run(hidden(), track([[0, 0, T], [0, 240, T + 240]], hz));
      expect(s.shown).toBe(true);
    });

    it("ignores a slow downward movement however long", () => {
      const s = run(hidden(), track([[0, 0, T], [0, 600, T + 6000]], hz));
      expect(s.shown).toBe(false);
    });

    it("ignores a fast downward movement shorter than 150px", () => {
      const s = run(hidden(), track([[0, 0, T], [0, 100, T + 50]], hz));
      expect(s.shown).toBe(false);
    });

    it("ignores a flick tilted more than 45° from vertical", () => {
      const s = run(hidden(), track([[0, 0, T], [300, 200, T + 250]], hz));
      expect(s.shown).toBe(false);
    });

    it("accepts a diagonal flick within 45° of vertical", () => {
      const s = run(hidden(), track([[0, 0, T], [150, 240, T + 240]], hz));
      expect(s.shown).toBe(true);
    });

    it("ignores movement with a button held (pan drag)", () => {
      const s = run(hidden(), track([[0, 0, T], [0, 240, T + 240]], hz, 1));
      expect(s.shown).toBe(false);
    });

    it("breaks the stroke at a 120ms pause", () => {
      const first = track([[0, 0, T], [0, 100, T + 100]], hz);
      const second = track([[0, 100, T + 220], [0, 200, T + 320]], hz);
      expect(run(hidden(), [...first, ...second]).shown).toBe(false);
    });
  });

  it("tolerates a 3px step back within a stroke", () => {
    const s = run(
      hidden(),
      track(
        [
          [0, 0, T],
          [0, 120, T + 60],
          [0, 117, T + 61],
          [0, 177, T + 91],
        ],
        1000,
      ),
    );
    expect(s.shown).toBe(true);
  });

  describe("while shown", () => {
    it("stays shown while moving down slower than activation but above keep-alive", () => {
      const s = run(initialBarState(0), track([[0, 0, 1000], [0, 800, 5000]], 60));
      expect(tick(s, 5000 + DELAY - 1).shown).toBe(true);
      expect(tick(s, 5000 + DELAY).shown).toBe(false);
    });

    it("does not extend on downward movement below keep-alive speed", () => {
      const s = run(initialBarState(0), track([[0, 0, 1000], [0, 400, 5000]], 60));
      expect(tick(s, 5000).shown).toBe(false);
    });

    it("does not extend on slow upward movement", () => {
      const s = run(initialBarState(0), track([[0, 800, 1000], [0, 0, 5000]], 60));
      expect(tick(s, 5000).shown).toBe(false);
    });

    it.each([
      ["slow", 1000],
      ["fast", 4000],
    ])("does not extend on %s horizontal movement", (_, dx) => {
      const s = run(initialBarState(0), track([[0, 0, 500], [dx, 0, 2500]], 60));
      expect(tick(s, 2500).shown).toBe(false);
    });

    it("hides at once on a fast 200px upward flick", () => {
      const s = run(initialBarState(0), track([[0, 500, 100], [0, 300, 300]], 60));
      expect(s.shown).toBe(false);
    });

    it("stays shown on a fast upward flick shorter than 150px", () => {
      const s = run(initialBarState(0), track([[0, 500, 100], [0, 400, 200]], 60));
      expect(s.shown).toBe(true);
    });
  });

  describe("hover and keyboard focus", () => {
    it("shows the hidden bar and pauses the timer while held", () => {
      let s = stepBar(hidden(), { type: "hoverChange", held: true, t: T });
      expect(s.shown).toBe(true);
      expect(tick(s, T + 60_000).shown).toBe(true);

      s = stepBar(s, { type: "hoverChange", held: false, t: T + 60_000 });
      expect(tick(s, T + 60_000 + DELAY - 1).shown).toBe(true);
      expect(tick(s, T + 60_000 + DELAY).shown).toBe(false);
    });
  });

  it("forceShow shows the bar and restarts the delay", () => {
    const s = stepBar(hidden(), { type: "forceShow", t: T });
    expect(s.shown).toBe(true);
    expect(tick(s, T + DELAY - 1).shown).toBe(true);
    expect(tick(s, T + DELAY).shown).toBe(false);
  });

  it("does not mutate its input", () => {
    const s = hidden();
    const snapshot = structuredClone(s);
    run(s, track([[0, 0, T], [0, 240, T + 240]], 60));
    expect(s).toEqual(snapshot);
  });
});
```

- [ ] **Step 3: 失敗を確認**

Run: `npx vitest --run src/utils/__tests__/thumbnailBarGesture.test.ts`
Expected: FAIL（`../thumbnailBarGesture` が解決できない）。

- [ ] **Step 4: 状態機械を実装**

`src/utils/thumbnailBarGesture.ts`:

```ts
// Spec: docs/superpowers/specs/2026-09-23-thumbnail-bar-auto-hide-design.md
import { THUMBNAIL_BAR_HIDE_DELAY_MS } from "../constants/timing";

/** Starting values to be tuned by hand on the device (§4.5). Speeds are px/ms. */
export const THUMBNAIL_BAR_GESTURE = {
  strokeDistancePx: 150,
  activateSpeed: 0.8,
  keepAliveSpeed: 0.15,
  speedWindowMs: 60,
  pauseMs: 100,
  maxTiltDeg: 45,
  backtrackTolerancePx: 4,
} as const;

interface Sample {
  x: number;
  y: number;
  t: number;
}

interface Stroke {
  dir: 1 | -1;
  originY: number;
  extremeY: number;
}

export interface BarState {
  shown: boolean;
  /** Null while hidden or held; otherwise only ever moves later. */
  hideAt: number | null;
  /** Hovered or keyboard-focused (§4.1, D7). */
  held: boolean;
  samples: readonly Sample[];
  stroke: Stroke | null;
}

export type BarEvent =
  | { type: "move"; x: number; y: number; t: number; buttons: number }
  | { type: "tick"; t: number }
  | { type: "hoverChange"; held: boolean; t: number }
  | { type: "forceShow"; t: number };

const G = THUMBNAIL_BAR_GESTURE;
const TILT_RATIO = Math.tan((G.maxTiltDeg * Math.PI) / 180);

export const initialBarState = (t: number): BarState => ({
  shown: true,
  hideAt: t + THUMBNAIL_BAR_HIDE_DELAY_MS,
  held: false,
  samples: [],
  stroke: null,
});

const show = (s: BarState, t: number): BarState => ({
  ...s,
  shown: true,
  hideAt: s.held ? null : t + THUMBNAIL_BAR_HIDE_DELAY_MS,
});

const hide = (s: BarState): BarState => ({
  ...s,
  shown: false,
  hideAt: null,
  stroke: null,
});

export function stepBar(s: BarState, e: BarEvent): BarState {
  switch (e.type) {
    case "tick":
      return s.shown && s.hideAt !== null && e.t >= s.hideAt ? hide(s) : s;
    case "hoverChange":
      if (e.held) return { ...s, held: true, shown: true, hideAt: null };
      return {
        ...s,
        held: false,
        hideAt: s.shown ? e.t + THUMBNAIL_BAR_HIDE_DELAY_MS : null,
      };
    case "forceShow":
      return show(s, e.t);
    case "move":
      return move(s, e);
  }
}

function move(s: BarState, e: Extract<BarEvent, { type: "move" }>): BarState {
  // A held button is a pan drag, not a gesture (D6).
  if (e.buttons !== 0) return { ...s, samples: [], stroke: null };

  const sample = { x: e.x, y: e.y, t: e.t };
  const prev = s.samples.at(-1);
  if (!prev || e.t - prev.t >= G.pauseMs) {
    return { ...s, samples: [sample], stroke: null };
  }

  // Velocity over ~speedWindowMs rather than between two events, so 60Hz and
  // 1000Hz mice read the same (§4.3).
  const samples = [...s.samples, sample];
  while (samples.length > 2 && e.t - samples[1].t >= G.speedWindowMs) {
    samples.shift();
  }
  const base = samples[0];
  const dt = e.t - base.t;
  if (dt <= 0) return { ...s, samples };

  const vx = (e.x - base.x) / dt;
  const vy = (e.y - base.y) / dt;
  const vertical = Math.abs(vx) <= Math.abs(vy) * TILT_RATIO;
  const fast = vertical && Math.abs(vy) >= G.activateSpeed;
  const stroke = nextStroke(s.stroke, fast, vy > 0 ? 1 : -1, base.y, e.y);

  let next: BarState = { ...s, samples, stroke };
  if (next.shown && !next.held && vertical && vy >= G.keepAliveSpeed) {
    next = { ...next, hideAt: e.t + THUMBNAIL_BAR_HIDE_DELAY_MS };
  }
  if (stroke && stroke.dir * (stroke.extremeY - stroke.originY) >= G.strokeDistancePx) {
    if (stroke.dir === 1 && !next.shown) return show(next, e.t);
    if (stroke.dir === -1 && next.shown) return hide(next);
  }
  return next;
}

function nextStroke(
  stroke: Stroke | null,
  fast: boolean,
  dir: 1 | -1,
  baseY: number,
  y: number,
): Stroke | null {
  if (!fast) return null;
  if (!stroke || stroke.dir !== dir) return { dir, originY: baseY, extremeY: y };
  if (dir * (y - stroke.extremeY) >= 0) return { ...stroke, extremeY: y };
  return dir * (stroke.extremeY - y) > G.backtrackTolerancePx ? null : stroke;
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest --run src/utils/__tests__/thumbnailBarGesture.test.ts`
Expected: 全件 PASS。

失敗した場合、テスト側の期待値を実装に合わせて変えてはならない。スペック §4 の遷移表に照らしてどちらが誤りかを判断し、判断に迷う場合は報告する。浮動小数の境界（例: 16.67px × 9 = 150 ちょうど）に依存するテストは無いように設計してある（活性化テストは 240px、非活性化テストは 100px）。

- [ ] **Step 6: コミット**

```bash
npm run lint:fix && npm run format:fix && npm test
git add src/constants/timing.ts src/utils/thumbnailBarGesture.ts src/utils/__tests__/thumbnailBarGesture.test.ts
git commit -m "feat(thumbnail-bar): add auto-hide gesture state machine"
```

---

### Task 3: `useThumbnailBarVisibility` フック

**Files:**
- Create: `src/hooks/useThumbnailBarVisibility.ts`
- Test: `src/hooks/__tests__/useThumbnailBarVisibility.test.ts`

**Interfaces:**
- Consumes: `initialBarState`, `stepBar`, `BarState`, `BarEvent`（Task 2）、`THUMBNAIL_BAR_HIDE_DELAY_MS`（Task 2）
- Produces:
  - `useThumbnailBarVisibility(showKey: string): { shown: boolean; barProps: ThumbnailBarProps }`
  - `showKey` が変わるたび（マウント時を含む）に `forceShow`（D3）
  - `interface ThumbnailBarProps { onMouseEnter(): void; onMouseLeave(): void; onFocus(e: React.FocusEvent<HTMLElement>): void; onBlur(e: React.FocusEvent<HTMLElement>): void }` — `<nav>` にそのまま spread する

**時刻の扱い:** 移動は `event.timeStamp`（WebView2 では `performance.now()` と同じ時計）を使う。メインスレッドが画像デコードで詰まると複数の pointermove がまとめて配送されるため、ハンドラ実行時刻で速度を測ると過大になる。タイマーとホバーは `performance.now()`。テストでは `vi.useFakeTimers({ toFake: [..., "performance"] })` で `performance.now()` を進め、ディスパッチするイベントの `timeStamp` を `performance.now()` で上書きする。

- [ ] **Step 1: 失敗するテストを書く**

`src/hooks/__tests__/useThumbnailBarVisibility.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { THUMBNAIL_BAR_HIDE_DELAY_MS as DELAY } from "../../constants/timing";
import { useThumbnailBarVisibility } from "../useThumbnailBarVisibility";

// jsdom stamps events with Date.now(); the hook reads timeStamp on the
// performance.now() clock like WebView2 does.
function move(x: number, y: number, buttons = 0) {
  const ev = new MouseEvent("pointermove", { clientX: x, clientY: y, buttons });
  Object.defineProperty(ev, "timeStamp", { value: performance.now() });
  act(() => {
    window.dispatchEvent(ev);
  });
}

// 1px/ms straight down at 60Hz: a flick for the state machine.
function flickDown(distance: number) {
  for (let y = 0; y <= distance; y += 16) {
    move(0, y);
    act(() => vi.advanceTimersByTime(16));
  }
}

const focusEvent = (focusVisible: boolean) =>
  ({ target: { matches: () => focusVisible } }) as unknown as React.FocusEvent<HTMLElement>;

const blurEvent = () =>
  ({
    currentTarget: { contains: () => false },
    relatedTarget: null,
  }) as unknown as React.FocusEvent<HTMLElement>;

describe("useThumbnailBarVisibility", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts shown and hides after the delay", () => {
    const { result } = renderHook(() => useThumbnailBarVisibility("/a"));
    expect(result.current.shown).toBe(true);
    act(() => vi.advanceTimersByTime(DELAY));
    expect(result.current.shown).toBe(false);
  });

  it("shows again on a fast downward flick", () => {
    const { result } = renderHook(() => useThumbnailBarVisibility("/a"));
    act(() => vi.advanceTimersByTime(DELAY));
    flickDown(240);
    expect(result.current.shown).toBe(true);
  });

  it("re-renders only when shown flips", () => {
    let renders = 0;
    renderHook(() => {
      renders++;
      return useThumbnailBarVisibility("/a");
    });
    const before = renders;
    for (let i = 0; i < 100; i++) {
      move(i * 5, 300);
      act(() => vi.advanceTimersByTime(8));
    }
    expect(renders).toBe(before);
  });

  it("holds while hovered and hides after leaving", () => {
    const { result } = renderHook(() => useThumbnailBarVisibility("/a"));
    act(() => result.current.barProps.onMouseEnter());
    act(() => vi.advanceTimersByTime(DELAY * 5));
    expect(result.current.shown).toBe(true);

    act(() => result.current.barProps.onMouseLeave());
    act(() => vi.advanceTimersByTime(DELAY - 1));
    expect(result.current.shown).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.shown).toBe(false);
  });

  it("holds on keyboard focus but not on mouse focus (D7)", () => {
    const { result } = renderHook(() => useThumbnailBarVisibility("/a"));
    act(() => result.current.barProps.onFocus(focusEvent(false)));
    act(() => vi.advanceTimersByTime(DELAY));
    expect(result.current.shown).toBe(false);

    act(() => result.current.barProps.onFocus(focusEvent(true)));
    expect(result.current.shown).toBe(true);
    act(() => vi.advanceTimersByTime(DELAY * 5));
    expect(result.current.shown).toBe(true);

    act(() => result.current.barProps.onBlur(blurEvent()));
    act(() => vi.advanceTimersByTime(DELAY));
    expect(result.current.shown).toBe(false);
  });

  it("shows again when showKey changes (D3)", () => {
    const { result, rerender } = renderHook(
      ({ key }) => useThumbnailBarVisibility(key),
      { initialProps: { key: "/a" } },
    );
    act(() => vi.advanceTimersByTime(DELAY));
    expect(result.current.shown).toBe(false);

    rerender({ key: "/b" });
    expect(result.current.shown).toBe(true);
    act(() => vi.advanceTimersByTime(DELAY));
    expect(result.current.shown).toBe(false);
  });

  it("removes its listener and timer on unmount", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useThumbnailBarVisibility("/a"));
    unmount();
    expect(remove).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    remove.mockRestore();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest --run src/hooks/__tests__/useThumbnailBarVisibility.test.ts`
Expected: FAIL（モジュールが解決できない）。

- [ ] **Step 3: フックを実装**

`src/hooks/useThumbnailBarVisibility.ts`:

```ts
// Spec: docs/superpowers/specs/2026-09-23-thumbnail-bar-auto-hide-design.md
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type BarEvent,
  type BarState,
  initialBarState,
  stepBar,
} from "../utils/thumbnailBarGesture";

export interface ThumbnailBarProps {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: (e: React.FocusEvent<HTMLElement>) => void;
  onBlur: (e: React.FocusEvent<HTMLElement>) => void;
}

// jsdom's selector engine may reject :focus-visible; that counts as mouse focus.
function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/** Shown again whenever showKey changes, including on mount (D3). */
export function useThumbnailBarVisibility(showKey: string): {
  shown: boolean;
  barProps: ThumbnailBarProps;
} {
  const [initial] = useState(() => initialBarState(performance.now()));
  const stateRef = useRef<BarState>(initial);
  const [shown, setShown] = useState(initial.shown);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverRef = useRef(false);
  const focusRef = useRef(false);

  const dispatch = useCallback((event: BarEvent) => {
    const prev = stateRef.current;
    const next = stepBar(prev, event);
    stateRef.current = next;
    // Every pointermove goes through here; only a flip may re-render.
    if (next.shown !== prev.shown) setShown(next.shown);

    if (next.hideAt === null) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    } else if (timerRef.current === undefined) {
      // One pending timer at most: hideAt only moves later, so the timer
      // re-arms itself from the tick instead of being reset on every move.
      timerRef.current = setTimeout(
        () => {
          timerRef.current = undefined;
          dispatch({ type: "tick", t: performance.now() });
        },
        Math.max(0, next.hideAt - performance.now()),
      );
    }
  }, []);

  useEffect(() => {
    // timeStamp, not performance.now(): moves queued behind a long decode are
    // delivered together and would read as a huge velocity.
    const onMove = (e: PointerEvent) =>
      dispatch({ type: "move", x: e.clientX, y: e.clientY, t: e.timeStamp, buttons: e.buttons });
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    };
  }, [dispatch]);

  useEffect(() => {
    dispatch({ type: "forceShow", t: performance.now() });
  }, [showKey, dispatch]);

  const setHold = useCallback(
    (ref: { current: boolean }, value: boolean) => {
      ref.current = value;
      const held = hoverRef.current || focusRef.current;
      if (held !== stateRef.current.held) {
        dispatch({ type: "hoverChange", held, t: performance.now() });
      }
    },
    [dispatch],
  );

  const barProps: ThumbnailBarProps = {
    onMouseEnter: () => setHold(hoverRef, true),
    onMouseLeave: () => setHold(hoverRef, false),
    // Focus left on a thumbnail by a mouse click must not hold the bar (D7).
    onFocus: (e) => setHold(focusRef, isFocusVisible(e.target)),
    onBlur: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setHold(focusRef, false);
      }
    },
  };

  return { shown, barProps };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest --run src/hooks/__tests__/useThumbnailBarVisibility.test.ts`
Expected: 全件 PASS。

「starts shown and hides after the delay」だけが失敗し `shown` が true のままなら、`performance` が fake されていない（vitest 4 の `toFake` に `"performance"` が効いていない）。その場合は `vi.spyOn(performance, "now").mockImplementation(() => Date.now())` を `beforeEach` の `useFakeTimers` 直後に置き（`Date` はデフォルトで fake される。`toFake` に `"Date"` を追加する）、原因を報告に書く。

- [ ] **Step 5: コミット**

```bash
npm run lint:fix && npm run format:fix && npm test
git add src/hooks/useThumbnailBarVisibility.ts src/hooks/__tests__/useThumbnailBarVisibility.test.ts
git commit -m "feat(thumbnail-bar): add useThumbnailBarVisibility hook"
```

---

### Task 4: ThumbnailBar への組み込みと CSS

**Files:**
- Modify: `src/components/ThumbnailBar.tsx`（2 行の import、69 行の `isHovered`、85-113 行のハンドラ、210-218 行の `<nav>`）
- Modify: `src/App.css`（286-302 行の `.thumbnail-bar` / `.thumbnail-bar.hovered`）
- Test: `src/components/__tests__/ThumbnailBar.test.tsx`

**Interfaces:**
- Consumes: `useThumbnailBarVisibility(showKey: string)`（Task 3）、`THUMBNAIL_BAR_HIDE_DELAY_MS`（Task 2）
- Produces: `<nav class="thumbnail-bar shown">`（表示中）/ `<nav class="thumbnail-bar">`（非表示中）。クラス `hovered` は廃止。

- [ ] **Step 1: テストを更新（失敗させる）**

`src/components/__tests__/ThumbnailBar.test.tsx`:

(a) import に `THUMBNAIL_BAR_HIDE_DELAY_MS` を追加:

```ts
import {
  THUMBNAIL_BAR_HIDE_DELAY_MS,
  THUMBNAIL_SCROLL_DEBOUNCE_MS,
} from "../../constants/timing";
```

(b) `createDefaultMockStore` の `folder` に `path` を追加（フックの `showKey`）:

```ts
  folder: {
    path: "/test",
    images: [] as ImageInfo[],
  },
```

(c) `describe("hover state", ...)`（225-254 行）を次で置き換える:

```ts
  describe("auto-hide", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      mockStoreState.folder.images = [createMockImageInfo(0), createMockImageInfo(1)];
      mockStoreState.currentImage.index = 0;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const hideBar = () => act(() => vi.advanceTimersByTime(THUMBNAIL_BAR_HIDE_DELAY_MS));

    it("is shown at mount and hidden after the delay", () => {
      render(<ThumbnailBar />);
      const nav = screen.getByRole("navigation");
      expect(nav).toHaveClass("shown");

      hideBar();
      expect(nav).not.toHaveClass("shown");
    });

    it("shows while hovered and hides after leaving", () => {
      render(<ThumbnailBar />);
      const nav = screen.getByRole("navigation");
      hideBar();

      fireEvent.mouseEnter(nav);
      expect(nav).toHaveClass("shown");
      act(() => vi.advanceTimersByTime(THUMBNAIL_BAR_HIDE_DELAY_MS * 5));
      expect(nav).toHaveClass("shown");

      fireEvent.mouseLeave(nav);
      hideBar();
      expect(nav).not.toHaveClass("shown");
    });

    it("ignores thumbnail clicks while hidden (D4)", () => {
      render(<ThumbnailBar />);
      hideBar();

      fireEvent.click(screen.getByTitle("image1.jpg"));
      expect(mockStoreState.navigateToImage).not.toHaveBeenCalled();
    });

    it("ignores the wheel while hidden (D4)", () => {
      render(<ThumbnailBar />);
      hideBar();

      fireEvent.wheel(screen.getByRole("navigation"), { deltaY: 100 });
      expect(mockStoreState.navigateToImage).not.toHaveBeenCalled();
    });

    it("shows again when the folder changes (D3)", () => {
      const { rerender } = render(<ThumbnailBar />);
      const nav = screen.getByRole("navigation");
      hideBar();
      expect(nav).not.toHaveClass("shown");

      mockStoreState = {
        ...mockStoreState,
        folder: { ...mockStoreState.folder, path: "/other" },
      };
      rerender(<ThumbnailBar />);
      expect(nav).toHaveClass("shown");
    });
  });
```

`afterEach` がファイル先頭の vitest import に含まれていることを確認する（1-2 行目。含まれていなければ追加）。`getByTitle("image1.jpg")` は `ThumbnailItem` の `title={image.filename}` を使う。

- [ ] **Step 2: 失敗を確認**

Run: `npx vitest --run src/components/__tests__/ThumbnailBar.test.tsx`
Expected: `auto-hide` の 5 件が FAIL（`shown` クラスが無い、非表示中にクリックが通る）。他の既存テストは PASS のまま。

- [ ] **Step 3: ThumbnailBar を変更**

`src/components/ThumbnailBar.tsx`:

(a) import（2 行目）から `useState` を外し、フックを追加:

```ts
import { useEffect, useRef, useCallback, useMemo, memo } from "react";

import {
  THUMBNAIL_ITEM_PITCH_PX,
  THUMBNAIL_RENDER_MARGIN,
} from "../constants/memory";
import { THUMBNAIL_SCROLL_DEBOUNCE_MS } from "../constants/timing";
import { useThumbnailBarVisibility } from "../hooks/useThumbnailBarVisibility";
import { useAppStore } from "../store";
```

(b) 69 行の `const [isHovered, setIsHovered] = useState(false);` を置き換え:

```ts
  const { shown, barProps } = useThumbnailBarVisibility(folder.path);
```

(c) クリックとホイールで非表示中を無視する（D4。CSS の `pointer-events: none` と二重にするのは、移動を伴わないクリックが CSS の切替と同じフレームに届く場合と、ホイールが `<nav>` 自体に届く場合を塞ぐため）:

```ts
  const handleThumbnailClick = useCallback(
    (index: number) => {
      if (shown && folder.images[index]) {
        navigateToImage(index);
      }
    },
    [shown, folder.images, navigateToImage],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      if (!shown) return;
      if (e.deltaY > 0) {
```

`handleWheel` の依存配列を `[shown, currentImage.index, folder.images.length, navigateToImage]` にする。

(d) `<nav>`（210-218 行）:

```tsx
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- hover reveal and wheel scrolling apply to the whole strip; each thumbnail inside is its own button
    <nav
      ref={thumbnailBarRef}
      aria-label="Thumbnail navigation"
      className={shown ? "thumbnail-bar shown" : "thumbnail-bar"}
      {...barProps}
      onWheel={handleWheel}
    >
```

oxlint-disable の行は機能を持つコメントなので残す（CLAUDE.md）。`lint` が「未使用の disable」と報告した場合のみ、報告どおりに対処する。

- [ ] **Step 4: CSS を変更**

`src/App.css` の `.thumbnail-bar` と `.thumbnail-bar.hovered` を置き換え:

```css
/* Thumbnail Bar
   Auto-hides like Picasa (docs/superpowers/specs/2026-09-23-thumbnail-bar-auto-hide-design.md).
   Hidden with opacity only: scrollToActiveItem needs a laid-out bar (§4.6). */
.thumbnail-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(0, 0, 0, 0.9);
  height: 80px;
  display: flex;
  flex-direction: column;
  transition: opacity 500ms ease;
  opacity: 0;
  z-index: 100;
}

.thumbnail-bar.shown {
  opacity: 1;
}

/* The <nav> itself still takes the hover that reveals the bar (D4). */
.thumbnail-bar:not(.shown) .thumbnail-container {
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .thumbnail-bar {
    transition: none;
  }
}
```

起動時にフェードしないための修飾子は不要: バーは画像が揃った時点で `shown` 付きでマウントされ、CSS トランジションは初回スタイルを補間しない（Task 5 でスペック §4.6 / §5 を訂正する）。

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest --run src/components/__tests__/ThumbnailBar.test.tsx`
Expected: 全件 PASS（既存のクリック・ホイールのテストは、マウント直後の表示中に実行されるので変更なしで通る）。

- [ ] **Step 6: 全体チェックとコミット**

```bash
npm run lint:fix && npm run format:fix
npm run type-check && npm run type-check:test && npm test
git add src/components/ThumbnailBar.tsx src/components/__tests__/ThumbnailBar.test.tsx src/App.css
git commit -m "feat(thumbnail-bar): auto-hide the bar like Picasa"
```

---

### Task 5: ドキュメント更新と最終検証

**Files:**
- Modify: `PROJECT_SPEC.md`（110-123 行、154 行、384 行）
- Modify: `docs/superpowers/specs/2026-09-23-thumbnail-bar-auto-hide-design.md`（§4.6 と §5）

**Interfaces:**
- Consumes: Task 1-4 の実装
- Produces: なし

- [ ] **Step 1: PROJECT_SPEC.md の Thumbnail Bar を書き換え**

110-116 行（`- **Thumbnail Bar** (10% of window, bottom):` から `- Current image always centered` の直前まで）を次で置き換える。`Current image always centered` 以降の 3 行は残す:

```markdown
- **Thumbnail Bar** (bottom, 80px, over the image area; auto-hides like Picasa Photo Viewer — see `docs/superpowers/specs/2026-09-23-thumbnail-bar-auto-hide-design.md`):

  - Height: 80px (30px thumbnails, then the filename line)
  - Hidden (opacity 0) when inactive; shows and hides with a 500ms fade (none with reduced motion)
  - Shown by hovering it, or by a quick downward mouse flick (≥150px at ≥800px/s); slow movement never shows it however far it goes, and a short flick does not either
  - Stays shown while hovered, keyboard-focused, or while the mouse keeps moving down at ≥150px/s; hides 2000ms after that stops, or at once on a quick upward flick (≥150px at ≥800px/s)
  - Movement with a mouse button held (panning) is ignored
  - Shown at startup and on folder change, then hides after 2000ms
  - While hidden, thumbnail clicks and the mouse wheel are ignored (hovering still shows the bar)
  - Showing or hiding never moves the image: maximized and fullscreen layouts reserve the bar's band either way
```

120-123 行の Image Info Overlay の `- Same opacity behavior as thumbnail bar` を次に置き換える:

```markdown
  - Part of the thumbnail bar: shown and hidden with it
```

- [ ] **Step 2: PROJECT_SPEC.md の残り 2 箇所**

- 154 行: `In this windowed mode the image is laid out over the whole client area with the thumbnail bar over its bottom;` → `In this windowed mode the image is laid out over the whole client area, and the auto-hiding thumbnail bar shows over its bottom;`（以降はそのまま）。
- 384 行の `    thumbnailOpacity: number; // 0.5 or 1.0` を削除。

- [ ] **Step 3: スペックを実装に合わせて訂正**

`docs/superpowers/specs/2026-09-23-thumbnail-bar-auto-hide-design.md`:
- §4.6 の箇条書き末尾に追加: `- 起動時にフェードしないための修飾子は不要。バーは画像が揃った時点で shown 付きでマウントされ、CSS トランジションは初回スタイルを補間しない。フォルダ切替時の再表示は 500ms でフェードインする。`
- §5 の表: `src/App.css` の行から「、起動時の即時表示用の no-transition 修飾子」を削除。`src/constants/timing.ts` の行を `THUMBNAIL_BAR_HIDE_DELAY_MS = 2000`（フェード 500ms は CSS にのみ書く。TS から参照されない定数は置かない）に変更。
- 冒頭の状態行を `- 状態: 実装済み` に変更。

- [ ] **Step 4: コミット**

```bash
git add PROJECT_SPEC.md docs/superpowers/specs/2026-09-23-thumbnail-bar-auto-hide-design.md
git commit -m "docs: describe the auto-hiding thumbnail bar"
```

- [ ] **Step 5: 単体テスト・型・lint・format・Rust**

Run:
```bash
npm test
npm run type-check && npm run type-check:test
npm run lint && npm run format
cd src-tauri && cargo test --lib
```
Expected: すべて成功（Rust は無変更だが CLAUDE.md の必須条件）。

- [ ] **Step 6: E2E**

Run（順に。`bench:build` は数分かかるので background 実行し、完了通知を待つ）:
```bash
npm run bench:corpus
npm run bench:build
npm run test:e2e
```
Expected: 全 spec green。`bench:build` 直後の初回 e2e は timing flake が出ることがあるため、失敗したら 2 回連続で再実行し、2 回とも green なら合格とする。`centering` / `preview-display` / `window-fit` はバーの rect（opacity に依存しない）を、`visual` は `.thumbnail-item` の計算スタイルを読むだけなので、変更なしで通る想定。落ちた場合は spec 名とアサーションを報告する（テスト側を弱めない）。

- [ ] **Step 7: 手動確認チェックリストを報告に含める**

実機（`npm run tauri dev`）でユーザーが確認する項目として、完了報告に次を列挙する:
1. 起動直後にバーが見え、2 秒後にフェードアウトする。
2. ゆっくり下へ動かしてもどれだけ進んでも出ない。素早く短く（150px 未満）振っても出ない。素早く 150px 以上振ると 500ms で出る。
3. 表示中、ゆっくりでも下へ動かし続ける限り消えない。止めると 2 秒で消える。横に動かしても 2 秒で消える。
4. 表示中に上へ素早く振ると即座に消える。
5. バーにホバーすると出て、ホバー中は消えない。離れて 2 秒で消える。
6. 非表示中にバーの位置を（動かさずに）クリックしてもナビゲーションしない。
7. 画像をドラッグでパンしながら下へ素早く動かしても出ない。
8. 最大化・全画面・ウインドウ化モード（画像外クリック）のそれぞれで、表示切替で画像が動かない。
9. DPI 150% と、あればトラックパッドで閾値の体感が妥当か（調整は `THUMBNAIL_BAR_GESTURE` の値のみで行う）。
