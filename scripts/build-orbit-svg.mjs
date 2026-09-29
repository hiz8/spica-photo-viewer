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
export const COMPANION = {
  body: 68,
  rim: 9,
  bodyColor: "#1667D6",
  rimColor: "#FFFFFF",
};

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
  const halfW =
    Math.hypot(ORBIT.rx * Math.cos(t), ORBIT.ry * Math.sin(t)) + reach;
  const halfH =
    Math.hypot(ORBIT.rx * Math.sin(t), ORBIT.ry * Math.cos(t)) + reach;
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
  return {
    x: CANVAS / 2 + scale * (x - cx),
    y: CANVAS / 2 + scale * (y - cy),
  };
}

export function iconBody(svg) {
  const match = svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg>/);
  if (!match) throw new Error("icon SVG has no <svg> element");
  return match[1].trim().replace(/\r\n?/g, "\n");
}

// The icon's root element is replaced by ours, so anything on it the body depends on must be carried
// over (namespace declarations such as xmlns:xlink) or refused (presentation attributes like
// fill-rule), otherwise a re-exported icon yields an SVG that renders wrong or not at all.
const ROOT_ATTRS_WE_REPLACE = new Set([
  "width",
  "height",
  "viewBox",
  "xmlns",
  "version",
]);

function iconNamespaces(svg) {
  const root = svg.match(/<svg\b([^>]*)>/)?.[1] ?? "";
  const namespaces = [];
  for (const [, name, value] of root.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
    if (name.startsWith("xmlns:")) namespaces.push(`${name}="${value}"`);
    else if (
      !ROOT_ATTRS_WE_REPLACE.has(name) &&
      !(name === "fill" && value === "none")
    ) {
      throw new Error(
        `icon <svg> root attribute ${name}="${value}" would be lost`,
      );
    }
  }
  return namespaces;
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
  const namespaces = iconNamespaces(iconSvg)
    .map((ns) => ` ${ns}`)
    .join("");
  return `<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" fill="none" xmlns="http://www.w3.org/2000/svg"${namespaces}>
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
    console.error(
      "usage: node scripts/build-orbit-svg.mjs <icon.svg> <output.svg>",
    );
    process.exit(1);
  }
  const svg = buildOrbitSvg(await readFile(input, "utf8"));
  await writeFile(output, svg);
  console.log(`wrote ${output} (${Buffer.byteLength(svg)}B)`);
}
