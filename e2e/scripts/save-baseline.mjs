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
