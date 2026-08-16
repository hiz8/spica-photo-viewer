// Canonizes the newest bench result as bench-results/baseline.json.
// Intentionally does NOT re-run the bench: the JSON that passed the
// adoption gate must itself become the baseline (a re-run under tight
// thresholds can land on the other side of the gate by noise alone).
import { copyFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "../../bench-results");
const newest = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && f !== "baseline.json")
  .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0];

if (!newest) throw new Error("no bench results found");

// Refuse to canonize a degenerate run (e.g. all cold samples failed).
const data = JSON.parse(readFileSync(join(dir, newest.f), "utf8"));
for (const key of ["TTFI_cold", "NAV_warm", "NAV_cold"]) {
  const m = data.metrics?.[key];
  if (!m || m.median_ms === null || m.n < data.runs) {
    throw new Error(
      `${newest.f}: ${key} is degenerate (median_ms=${m?.median_ms}, n=${m?.n}, runs=${data.runs}) - refusing to save as baseline`,
    );
  }
}

// NAV_rapid / PLACEHOLDER_dur pool steps x runs samples with no exclusion
// rule, so anything short of a full pool means steps failed to paint.
// median_ms === 0 is legitimate for PLACEHOLDER_dur (no placeholder shown).
const rapid = data.metrics?.NAV_rapid;
const expectedRapidN = data.runs * (rapid?.steps ?? 0);
for (const [key, m] of [
  ["NAV_rapid", rapid],
  ["PLACEHOLDER_dur", data.metrics?.PLACEHOLDER_dur],
]) {
  if (
    !m ||
    m.median_ms === null ||
    m.n !== expectedRapidN ||
    expectedRapidN === 0
  ) {
    throw new Error(
      `${newest.f}: ${key} is degenerate (median_ms=${m?.median_ms}, n=${m?.n}, expected n=${expectedRapidN}) - refusing to save as baseline`,
    );
  }
}

copyFileSync(join(dir, newest.f), join(dir, "baseline.json"));
console.log(`baseline.json <- ${newest.f}`);
