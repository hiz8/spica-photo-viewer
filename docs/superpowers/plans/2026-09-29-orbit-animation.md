# 伴星周回アニメーション SVG 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `public/icon.svg` から「伴星が主星を周回する」アニメーション SVG（`public/spica-orbit.svg`）を生成するスクリプトを作り、About ダイアログと README 冒頭に組み込む。

**Architecture:** 生成スクリプト `scripts/build-orbit-svg.mjs` は、アイコン SVG の文字列を受け取ってアニメーション SVG の文字列を返す純粋関数 `buildOrbitSvg` と、幾何の検算用関数（`companionCentre` / `gapToPrimary` / `fitTransform` / `toCanvas`）を export する。CLI として実行すると、ファイルを読んで書き出す。生成物はコミットし、`node:test` のテストで「コミット済みファイルが最新であること」とスペックの不変条件（O3・O5・O7）を確かめる。About ダイアログは `<img src="/spica-orbit.svg">` を 112px で表示し、README は同じファイルを相対パスで参照する。

**Tech Stack:** Node.js 22（ESM、`node:test`）/ SVG + CSS keyframes / React 19 + vitest 4 + @testing-library/react（About ダイアログ）/ oxlint・oxfmt。

**Spec:** `docs/superpowers/specs/2026-09-29-orbit-animation-design.md`（以下「スペック」。§ と O 番号はスペックのもの）

## Global Constraints

- 周期は 4.01 秒。一定の速さで、表示中はずっと回り続ける（スペック §2）
- 回り始めは θ = 150°（手前の左下）。止まって表示されるときもこの配置（O5）
- 主星は `public/icon.svg` を 80% に縮小し、中心を (512, 492) に置く（1024 キャンバス上の値。以下同じ）
- 軌道: 中心 (544, 573)、横半径 500、縦半径 143、傾き -18°、太さ 51。手前は `#6CC4FF`（輪郭なし）、奥は `#0F4C9E`（不透明）
- 伴星: 青い丸 `#1667D6`（半径 68）＋ 白い縁 9（外径 77）
- 全体はキャンバスの内側 16 に収まるよう縮小して中央に置く（縮小率 ≈ 0.894）
- SVG にスクリプト・外部ファイルの参照・`foreignObject` を入れない（O7）
- `package.json` は CRLF。`sed` で編集せず、Edit ツールで編集する
- コードのコメントは CLAUDE.md の規約に従う。ファイル先頭に `Spec: docs/superpowers/specs/2026-09-29-orbit-animation-design.md` を 1 回だけ書き、以降は `(O2)` や `§2` の形で参照する
- コミット前に `npm test` が green であること。lint / format は hook が処理する

## Review Focus

1. **`public/icon.svg` を後で書き出し直した場合**（Figma などから、XML 宣言やコメント付き、CRLF で保存される）: 生成スクリプトが `<svg>` の中身を正しく取り出し、同期テストも改行コードの違いで誤って落ちないこと → Task 1 の「XML 宣言とコメントを許容する」テストと、同期テストでの CRLF の正規化
2. **アイコンの輪郭が変わった場合**（菱形 41〜983 でなくなる）: 主星を切り抜く形と O3 の隙間計算は、この菱形を前提にしている。黙って崩れずに、テストで気付けること → Task 1 の「主星の輪郭が前提の菱形である」テスト
3. **アイコン側に `id` が入った場合**: 生成スクリプトの `clipPath` の id と衝突しないこと → id に `orbit-` の接頭辞を付け、「出力の id が重複しない」テストで確かめる（Task 1）
4. **アニメーションを再生しない環境・アニメーションを減らす設定**: 止まった絵が回り始めの構図（θ = 150°、手前）になること → Task 1 の O5 テスト（初期値の transform と `prefers-reduced-motion` の規則）
5. **ウインドウが低いときの About ダイアログ**: ロゴを 112px に広げても、本文がダイアログ内でスクロールでき、閉じるボタンが隠れないこと → jsdom では検証できないので、Task 3 の目視確認に入れる

---

### Task 1: 生成スクリプト・テスト・生成物

**Files:**
- Create: `scripts/build-orbit-svg.mjs`
- Create: `scripts/__tests__/build-orbit-svg.test.mjs`
- Create: `public/spica-orbit.svg`（生成物）
- Modify: `package.json`（`scripts` に 2 行追加。CRLF なので Edit ツールで編集する）

**Interfaces:**
- Consumes: `public/icon.svg`（1024×1024。最初の `<path>` が菱形 `M512 41L983 512L512 983L41 512`）
- Produces:
  - `buildOrbitSvg(iconSvg: string): string` — アニメーション SVG の全文。改行は `\n`、末尾に改行 1 つ
  - `iconBody(svg: string): string` — `<svg ...>` と `</svg>` の間を trim して返す。`<svg>` が無ければ throw
  - `companionCentre(deg: number): { x: number, y: number }` — 軌道上の角度 θ（スペック §2 の定義）での伴星の中心。縮小前の 1024 座標
  - `gapToPrimary(deg: number): number` — 伴星の円と主星の菱形の距離の下限。負なら重なっている（O3）
  - `fitTransform(): { scale: number, cx: number, cy: number }` — 全体を収める縮小率と、縮小の中心
  - `toCanvas(p: { x: number, y: number }): { x: number, y: number }` — 縮小前の座標をキャンバス座標に変換する
  - 定数 `CANVAS`（1024）、`MARGIN`（16）、`START_DEG`（150）、`COMPANION`（`{ body: 68, rim: 9, ... }`）
  - npm scripts `build:orbit` / `build:orbit:test`

- [ ] **Step 1: テストを書く**

`scripts/__tests__/build-orbit-svg.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildOrbitSvg,
  CANVAS,
  COMPANION,
  companionCentre,
  fitTransform,
  gapToPrimary,
  iconBody,
  MARGIN,
  toCanvas,
} from "../build-orbit-svg.mjs";

const root = new URL("../../", import.meta.url);
// Files saved on Windows may carry CRLF; the generator always writes LF.
const read = (path) =>
  readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");
const ICON = read("public/icon.svg");

test("public/spica-orbit.svg is up to date with public/icon.svg", () => {
  assert.equal(
    read("public/spica-orbit.svg"),
    buildOrbitSvg(ICON),
    "run `npm run build:orbit` and commit the result",
  );
});

test("the primary's silhouette is the diamond the clip and clearance assume", () => {
  assert.match(iconBody(ICON), /M512 41L983 512L512 983L41 512/);
});

test("the companion clears the primary where it switches between behind and in front (O3)", () => {
  for (const deg of [0, 180]) {
    assert.ok(gapToPrimary(deg) > 0, `overlaps the primary at ${deg}°`);
  }
});

test("the companion stays inside the canvas margin at every angle", () => {
  const r = (COMPANION.body + COMPANION.rim) * fitTransform().scale;
  for (let deg = 0; deg < 360; deg++) {
    const { x, y } = toCanvas(companionCentre(deg));
    assert.ok(x - r >= MARGIN - 1e-6, `left edge at ${deg}°`);
    assert.ok(x + r <= CANVAS - MARGIN + 1e-6, `right edge at ${deg}°`);
    assert.ok(y - r >= MARGIN - 1e-6, `top edge at ${deg}°`);
    assert.ok(y + r <= CANVAS - MARGIN + 1e-6, `bottom edge at ${deg}°`);
  }
});

test("the output uses only what GitHub renders inside an <img> (O7)", () => {
  const svg = buildOrbitSvg(ICON);
  assert.doesNotMatch(svg, /<script|foreignObject|@import|href="(?!#)|url\((?!#)/);
});

test("without animation the companion rests at the start angle, in front (O5)", () => {
  const svg = buildOrbitSvg(ICON);
  assert.match(svg, /\.orbit-spin\{[^}]*transform:rotate\(150deg\)/);
  assert.match(svg, /\.orbit-counter\{[^}]*transform:rotate\(-150deg\)/);
  assert.match(
    svg,
    /@media \(prefers-reduced-motion: reduce\)\{\.orbit-spin,\.orbit-counter,\.orbit-front\{animation:none\}\}/,
  );
});

test("element ids are unique", () => {
  const ids = [...buildOrbitSvg(ICON).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, [...new Set(ids)]);
});

test("iconBody accepts an XML prolog and comments", () => {
  const body = iconBody(
    '<?xml version="1.0"?>\n<!-- exported -->\n<svg viewBox="0 0 1024 1024"><path d="M0 0"/></svg>\n',
  );
  assert.equal(body, '<path d="M0 0"/>');
});

test("iconBody rejects input without an <svg> element", () => {
  assert.throws(() => iconBody("<g/>"), /no <svg> element/);
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test scripts/__tests__/build-orbit-svg.test.mjs`
Expected: FAIL（`Cannot find module '.../scripts/build-orbit-svg.mjs'`）

- [ ] **Step 3: 生成スクリプトを書く**

`scripts/build-orbit-svg.mjs`:

```js
// Spec: docs/superpowers/specs/2026-09-29-orbit-animation-design.md
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const CANVAS = 1024;
export const MARGIN = 16;
export const START_DEG = 150;
const PERIOD_S = 4.01;

// The icon's diamond spans 41..983 on the 1024 grid; the clip and gapToPrimary() assume it.
const PRIMARY = { cx: 512, cy: 492, scale: 0.8, halfDiagonal: 471 };
const PRIMARY_T = `translate(${PRIMARY.cx} ${PRIMARY.cy}) scale(${PRIMARY.scale}) translate(-512 -512)`;
// RX 500 keeps the companion clear of the primary at the 0°/180° switch (O3).
const ORBIT = {
  cx: 544,
  cy: 573,
  rx: 500,
  ry: 143,
  tiltDeg: -18,
  width: 51,
  front: "#6CC4FF",
  back: "#0F4C9E",
};
export const COMPANION = { body: 68, rim: 9, bodyColor: "#1667D6", rimColor: "#FFFFFF" };

const rad = (deg) => (deg * Math.PI) / 180;
const fmt = (n) => String(+n.toFixed(4));
const outerRadius = COMPANION.body + COMPANION.rim;

export function companionCentre(deg) {
  const a = rad(deg);
  const t = rad(ORBIT.tiltDeg);
  const lx = ORBIT.rx * Math.cos(a);
  const ly = ORBIT.ry * Math.sin(a);
  return {
    x: ORBIT.cx + lx * Math.cos(t) - ly * Math.sin(t),
    y: ORBIT.cy + lx * Math.sin(t) + ly * Math.cos(t),
  };
}

// (L1 distance − half-diagonal) / √2 never exceeds the true Euclidean distance to the
// diamond, so a positive result is a safe clearance even near a vertex.
export function gapToPrimary(deg) {
  const { x, y } = companionCentre(deg);
  const l1 = Math.abs(x - PRIMARY.cx) + Math.abs(y - PRIMARY.cy);
  return (l1 - PRIMARY.halfDiagonal * PRIMARY.scale) / Math.SQRT2 - outerRadius;
}

export function fitTransform() {
  const t = rad(ORBIT.tiltDeg);
  const reach = Math.max(outerRadius, ORBIT.width / 2);
  const halfW = Math.hypot(ORBIT.rx * Math.cos(t), ORBIT.ry * Math.sin(t)) + reach;
  const halfH = Math.hypot(ORBIT.rx * Math.sin(t), ORBIT.ry * Math.cos(t)) + reach;
  const d = PRIMARY.halfDiagonal * PRIMARY.scale;
  const left = Math.min(PRIMARY.cx - d, ORBIT.cx - halfW);
  const right = Math.max(PRIMARY.cx + d, ORBIT.cx + halfW);
  const top = Math.min(PRIMARY.cy - d, ORBIT.cy - halfH);
  const bottom = Math.max(PRIMARY.cy + d, ORBIT.cy + halfH);
  const room = CANVAS - 2 * MARGIN;
  return {
    scale: Math.min(room / (right - left), room / (bottom - top)),
    cx: (left + right) / 2,
    cy: (top + bottom) / 2,
  };
}

export function toCanvas({ x, y }) {
  const { scale, cx, cy } = fitTransform();
  return { x: CANVAS / 2 + scale * (x - cx), y: CANVAS / 2 + scale * (y - cy) };
}

export function iconBody(svg) {
  const match = svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/);
  if (!match) throw new Error("icon SVG has no <svg> element");
  return match[1].trim();
}

const ellipse = (stroke) =>
  `<ellipse cx="${ORBIT.cx}" cy="${ORBIT.cy}" rx="${ORBIT.rx}" ry="${ORBIT.ry}" transform="rotate(${ORBIT.tiltDeg} ${ORBIT.cx} ${ORBIT.cy})" stroke="${stroke}" stroke-width="${ORBIT.width}"/>`;

// The orbit is a circle squashed by K, so rotating inside it traces the ellipse; the counter-rotation
// and the inverse squash keep the companion itself a true circle (O1).
function companion(className) {
  const k = ORBIT.ry / ORBIT.rx;
  const cls = className ? ` class="${className}"` : "";
  return `<g transform="translate(${ORBIT.cx} ${ORBIT.cy}) rotate(${ORBIT.tiltDeg}) scale(1 ${fmt(k)})"><g class="orbit-spin"><g transform="translate(${ORBIT.rx} 0)"><g class="orbit-counter"><g transform="scale(1 ${fmt(1 / k)})"${cls}><circle r="${outerRadius}" fill="${COMPANION.rimColor}"/><circle r="${COMPANION.body}" fill="${COMPANION.bodyColor}"/></g></g></g></g></g>`;
}

// Keyframe offset of angle θ, measured from the start angle.
const at = (deg) => fmt(((deg - START_DEG) / 360) * 100);

function style() {
  const end = START_DEG + 360;
  return [
    ".orbit-spin,.orbit-counter{transform-box:view-box;transform-origin:0 0}",
    // The resting transforms are the start angle, so a still frame is the start composition (O5).
    `.orbit-spin{transform:rotate(${START_DEG}deg);animation:orbit-spin ${PERIOD_S}s linear infinite}`,
    `.orbit-counter{transform:rotate(${-START_DEG}deg);animation:orbit-counter ${PERIOD_S}s linear infinite}`,
    `.orbit-front{animation:orbit-front ${PERIOD_S}s step-end infinite}`,
    `@keyframes orbit-spin{from{transform:rotate(${START_DEG}deg)}to{transform:rotate(${end}deg)}}`,
    `@keyframes orbit-counter{from{transform:rotate(${-START_DEG}deg)}to{transform:rotate(${-end}deg)}}`,
    // The in-front copy shows only for 0° < θ < 180°, switching whole at the orbit's ends (O2).
    `@keyframes orbit-front{0%{opacity:1}${at(180)}%{opacity:0}${at(360)}%{opacity:1}100%{opacity:1}}`,
    "@media (prefers-reduced-motion: reduce){.orbit-spin,.orbit-counter,.orbit-front{animation:none}}",
  ].join("\n");
}

// The front orbit is drawn twice, under both companions and again over the primary only,
// clipped by a 1%-larger diamond (O4).
export function buildOrbitSvg(iconSvg) {
  const { scale, cx, cy } = fitTransform();
  const fit = `translate(${CANVAS / 2} ${CANVAS / 2}) scale(${fmt(scale)}) translate(${fmt(-cx)} ${fmt(-cy)})`;
  return `<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" fill="none" xmlns="http://www.w3.org/2000/svg">
<style>
${style()}
</style>
<defs>
<clipPath id="orbit-front-half" clipPathUnits="userSpaceOnUse">
<rect x="-700" y="0" width="1400" height="400" transform="translate(${ORBIT.cx} ${ORBIT.cy}) rotate(${ORBIT.tiltDeg})"/>
</clipPath>
<clipPath id="orbit-over-primary" clipPathUnits="userSpaceOnUse">
<path d="M512 41L983 512L512 983L41 512Z" transform="${PRIMARY_T} translate(512 512) scale(1.01) translate(-512 -512)"/>
</clipPath>
</defs>
<g transform="${fit}">
${ellipse(ORBIT.back)}
<g clip-path="url(#orbit-front-half)">${ellipse(ORBIT.front)}</g>
${companion()}
<g transform="${PRIMARY_T}">
${iconBody(iconSvg)}
</g>
<g clip-path="url(#orbit-front-half)"><g clip-path="url(#orbit-over-primary)">${ellipse(ORBIT.front)}</g></g>
${companion("orbit-front")}
</g>
</svg>
`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: node scripts/build-orbit-svg.mjs <icon.svg> <output.svg>");
    process.exit(1);
  }
  const svg = buildOrbitSvg(await readFile(input, "utf8"));
  await writeFile(output, svg);
  console.log(`wrote ${output} (${Buffer.byteLength(svg)}B)`);
}
```

- [ ] **Step 4: npm scripts を追加する**

`package.json` の `"build:file-icon:test"` の行の直後に、次の 2 行を Edit ツールで追加する（CRLF を保つため `sed` は使わない）。

```json
    "build:orbit": "node scripts/build-orbit-svg.mjs public/icon.svg public/spica-orbit.svg",
    "build:orbit:test": "node --test scripts/__tests__/build-orbit-svg.test.mjs",
```

- [ ] **Step 5: 生成物を作る**

Run: `npm run build:orbit`
Expected: `wrote public/spica-orbit.svg (約 4000B)`

- [ ] **Step 6: テストが通ることを確認する**

Run: `npm run build:orbit:test`
Expected: 9 件すべて PASS

- [ ] **Step 7: 生成物を目で確かめる**

`public/spica-orbit.svg` を Chrome か Edge で直接開き、次を確かめる。
- 伴星が 4.01 秒で 1 周する
- 軌道の左右の端で見切れない
- 右端で奥から手前へ回り込むとき、縁が主星に食い込まない

試作（比較ページの「確定版」）と比べて、全体が約 1.6% 大きいことは想定どおり（スペック §4）。

- [ ] **Step 8: lint・format・全テスト**

Run: `npm run lint && npm run format && npm test`
Expected: エラーなし。vitest は `scripts/**` を対象外にしているので、件数は変わらない。format で落ちたら `npm run format:fix` を実行してから Step 6 のテストを再実行する（整形でスクリプトの出力は変わらない）

- [ ] **Step 9: コミット**

```bash
git add scripts/build-orbit-svg.mjs scripts/__tests__/build-orbit-svg.test.mjs public/spica-orbit.svg package.json
git commit -m "feat(icon): generate the orbiting-companion animation from icon.svg"
```

---

### Task 2: About ダイアログのロゴを差し替える

**Files:**
- Modify: `src/components/AboutDialog.tsx`（`<img src="/icon.svg" alt="Spica Logo" width={60} height={60} />` の 1 行）
- Modify: `src/App.css`（`.logo-icon` の規則）
- Test: `src/components/__tests__/AboutDialog.test.tsx`

**Interfaces:**
- Consumes: Task 1 の `public/spica-orbit.svg`（Vite が `/spica-orbit.svg` として配信する）
- Produces: なし

- [ ] **Step 1: テストを書く**

`src/components/__tests__/AboutDialog.test.tsx` の `describe("AboutDialog", ...)` の中、`"should render when showAbout is true"` の直後に追加する:

```tsx
  it("shows the animated orbit logo", async () => {
    mockStore.ui.showAbout = true;

    await act(async () => {
      render(<AboutDialog />);
    });

    const logo = screen.getByAltText("Spica Logo");
    expect(logo).toHaveAttribute("src", "/spica-orbit.svg");
    expect(logo).toHaveAttribute("width", "112");
    expect(logo).toHaveAttribute("height", "112");
  });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `npx vitest --run src/components/__tests__/AboutDialog.test.tsx`
Expected: FAIL（`src` が `/icon.svg`）

- [ ] **Step 3: ロゴを差し替える**

`src/components/AboutDialog.tsx`:

```tsx
              <img
                src="/spica-orbit.svg"
                alt="Spica Logo"
                width={112}
                height={112}
              />
```

`src/App.css` の `.logo-icon` を次に置き換える（`font-size: 48px` はアイコン文字だった頃の名残で、画像の下に余計な行の高さを作る）:

```css
.logo-icon {
  margin-bottom: 8px;
}

.logo-icon img {
  display: block;
  margin: 0 auto;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `npx vitest --run src/components/__tests__/AboutDialog.test.tsx`
Expected: PASS

- [ ] **Step 5: 全体の確認**

Run: `npm test && npm run type-check && npm run lint && npm run format`
Expected: すべて green

- [ ] **Step 6: コミット**

```bash
git add src/components/AboutDialog.tsx src/App.css src/components/__tests__/AboutDialog.test.tsx
git commit -m "feat(about): show the orbiting-companion logo in the About dialog"
```

---

### Task 3: README への組み込みと目視確認

**Files:**
- Modify: `README.md`（1 行目の `# Spica Photo Viewer` の直前）

**Interfaces:**
- Consumes: Task 1 の `public/spica-orbit.svg`
- Produces: なし

- [ ] **Step 1: README の冒頭にロゴを追加する**

`README.md` の先頭を次のようにする（見出しと本文は変えない）:

```markdown
<p align="center"><img src="public/spica-orbit.svg" width="200" height="200" alt="Spica Photo Viewer logo"></p>

# Spica Photo Viewer
```

- [ ] **Step 2: コミット**

```bash
git add README.md
git commit -m "docs(readme): add the orbiting-companion logo to the header"
```

- [ ] **Step 3: About ダイアログを目で確かめる**

Run: `npm run tauri dev`（長時間動くので、バックグラウンドで実行する）
確認:
- F1 で開いた About ダイアログで、ロゴが 112px で回っている
- ダイアログを閉じて開き直すと、回り始めの位置から回る
- ウインドウの高さを低くしても、本文がダイアログ内でスクロールでき、閉じるボタンが隠れない（Review Focus 5）

- [ ] **Step 4: アニメーションを減らす設定で確かめる**

Windows の「設定 → アクセシビリティ → 視覚効果 → アニメーション効果」をオフにして About ダイアログを開き、伴星が手前の左下で止まっていることを確かめる（O5）。確認後は設定を元に戻す。

- [ ] **Step 5: GitHub で確かめる**

ブランチを push する（SSH は使えないので HTTPS で。メモリの session-env-quirks を参照）:

```bash
git -c credential.helper="!gh auth git-credential" push https://github.com/hiz8/spica-photo-viewer.git feat/orbit-animation
```

`https://github.com/hiz8/spica-photo-viewer/tree/feat/orbit-animation` を開き、次を確かめる。
- README 冒頭のロゴが、ライトとダークの両テーマで動いている
- GitHub が再生しない場合でも、止まった絵として崩れていない（スペック §8）

Step 3〜5 の目視確認は、ユーザーと一緒に行う。
