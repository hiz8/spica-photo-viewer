// Verifies that the working tree differs from a base ref by comments only.
//
// TS/TSX is checked semantically: esbuild strips the comments out of both
// revisions and the results must match byte for byte, so any code change at
// all is caught. Rust has no equivalent tool available here, so it is checked
// line-wise instead: every added or removed line must be a whole-line comment
// or blank. A changed line that mixes code with a trailing comment cannot be
// judged that way, so it is reported for manual review (exit 2) rather than
// silently accepted.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { transformSync } from "esbuild";

const strip = (source, loader) =>
  transformSync(source, { loader, legalComments: "none" }).code;

export const tsCodeEquivalent = (before, after, loader) =>
  strip(before, loader) === strip(after, loader);

export const isCommentOrBlank = (line) => {
  const t = line.trim();
  return (
    t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")
  );
};

const DIFF_HEADER =
  /^(diff |index |new file|deleted file|similarity |rename |old mode|new mode|Binary files)/;

export const classifyRustDiff = (diff) => {
  const hard = [];
  const manual = [];
  let file = "?";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      continue;
    }
    if (
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@") ||
      DIFF_HEADER.test(line)
    ) {
      continue;
    }
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    const body = line.slice(1);
    if (isCommentOrBlank(body)) continue;
    (body.includes("//") ? manual : hard).push(`${file}: ${line}`);
  }
  return { hard, manual };
};

const git = (args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });

const main = () => {
  const baseRef = process.argv[2] ?? "HEAD";
  const hard = [];
  const manual = [];

  const changed = git([
    "diff",
    "--name-only",
    baseRef,
    "--",
    "src",
    "src-tauri/src",
  ])
    .split("\n")
    .filter(Boolean);

  for (const path of changed) {
    if (!/\.tsx?$/.test(path)) continue;
    let before;
    try {
      before = git(["show", `${baseRef}:${path}`]);
    } catch {
      continue; // added in this range: there is nothing to preserve
    }
    if (!existsSync(path)) {
      hard.push(`${path}: file deleted`);
      continue;
    }
    const loader = path.endsWith(".tsx") ? "tsx" : "ts";
    if (!tsCodeEquivalent(before, readFileSync(path, "utf8"), loader)) {
      hard.push(`${path}: code changed (esbuild output differs)`);
    }
  }

  const rust = classifyRustDiff(
    git(["diff", "-U0", baseRef, "--", "src-tauri/src"]),
  );
  hard.push(...rust.hard);
  manual.push(...rust.manual);

  if (hard.length > 0) {
    console.error("NON-COMMENT CHANGE — revert it or move it to a logic commit:");
    for (const l of hard) console.error(`  ${l}`);
    process.exit(1);
  }
  if (manual.length > 0) {
    console.error("TRAILING-COMMENT LINE — confirm by eye that only the comment changed:");
    for (const l of manual) console.error(`  ${l}`);
    process.exit(2);
  }
  console.log(
    `verify-comment-only: OK — ${changed.length} file(s) vs ${baseRef}, comments only`,
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
