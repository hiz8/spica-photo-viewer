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
  assert.doesNotMatch(
    svg,
    /<script|foreignObject|@import|href="(?!#)|url\((?!#)/,
  );
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
  const ids = [...buildOrbitSvg(ICON).matchAll(/\bid="([^"]+)"/g)].map(
    (m) => m[1],
  );
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
