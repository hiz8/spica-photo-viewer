// Side-by-side table of profile-startup.mjs outputs.
//   node e2e/scripts/summarize-startup.mjs <label> [<label> ...]
// Each cell: median over runs [per-run values], ms from process spawn unless
// the metric name ends in _ms (a duration) or is a count/flag.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const labels = process.argv.slice(2);
if (!labels.length) throw new Error("usage: summarize-startup.mjs <label>...");

const KEYS = [
  "rust_run_start",
  "rust_setup",
  "rust_window_created",
  "js_timeOrigin",
  "js_script_start",
  "js_script_innerWidth",
  "rust_prefetch_start",
  "rust_prefetch_thumb_done",
  "prefetch_thumb_ms",
  "rust_prefetch_folder_done",
  "js_open_request",
  "rust_get_startup_file_end",
  "js_startup_thumb",
  "rust_maximize_end",
  "rust_folder_scan_start",
  "rust_folder_scan_end",
  "rust_folder_scan_prefetched",
  "scan_walk_ms",
  "scan_meta_ms",
  "scan_probe_wait_ms",
  "js_folder_scanned",
  "js_thumbbar_committed",
  "js_thumbbar_painted",
  "js_src_set",
  "js_decode_done",
  "js_first_full_paint",
  "cache_sweep_ms",
  "cache_stats_ms",
  "js_thumbgen_start",
  "thumb_first",
  "thumb_5th",
  "thumb_21st",
  "thumb_count",
  "thumb_lookup_ms_median",
  "thumb_preview_ms_median",
];

const median = (arr) => {
  const a = arr.filter((v) => typeof v === "number").sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : null;
};
const pad = (s, n) => String(s ?? "-").padEnd(n);

const data = {};
for (const l of labels) {
  const file = join(here, `../.tmp/profile-startup-${l}.json`);
  data[l] = JSON.parse(readFileSync(file, "utf8")).runs.map((r) => r.summary);
}

console.log(pad("metric", 28) + labels.map((l) => pad(l, 28)).join(""));
for (const k of KEYS) {
  const row = labels.map((l) => {
    const vals = data[l].map((r) => r[k]);
    const m = median(vals);
    const shown =
      m === null
        ? String(vals[0])
        : String(Math.round(m * 10) / 10);
    const list = vals
      .map((v) =>
        v === null || v === undefined
          ? "-"
          : typeof v === "number"
            ? String(Math.round(v))
            : String(v),
      )
      .join(",");
    return pad(`${shown} [${list}]`, 28);
  });
  console.log(pad(k, 28) + row.join(""));
}
for (const l of labels) {
  console.log(
    `${l} paints(tier@ms):`,
    data[l]
      .map((r) => r.paints.map((p) => `${p.tier}@${p.t}`).join(" "))
      .join(" | "),
  );
}
