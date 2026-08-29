// Verifies that the working tree differs from a base ref by comments only.
//
// TS/TSX is checked semantically: esbuild strips the comments out of both
// revisions and the results must match, whitespace differences aside, so any
// code change at all is caught. The comparison is whitespace-insensitive
// (`minifyWhitespace: true`) because plain `legalComments: "none"` does not
// actually strip every comment: esbuild's printer retains comments attached
// to object-literal properties (leading or trailing) even when asked to drop
// them, so deleting a legitimate what-comment on a `{ foo: 1 /* note */ }`
// style property would otherwise make an equivalent revision compare
// unequal. `minifyWhitespace` collapses that away while still doing full
// semantic parsing/printing (no regex post-processing of the output), so a
// real code change — a changed value, a changed string literal, including
// one containing `//` — still fails the comparison. One side effect: a pure
// reindentation would now also pass this check; that's acceptable because
// `npm run format` is checked separately and reindentation is not a logic
// change. Rust has no equivalent tool available here, so it is checked
// line-wise instead: every added or removed line must be a whole-line comment
// or blank. A changed line that mixes code with `//` cannot be judged that
// way — it may be a trailing comment or a `//` inside a string — so it is
// reported for manual review (exit 2) rather than silently accepted. Added
// files (no base-ref revision to diff against) land in the same manual-review
// bucket.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { transformSync } from "esbuild";

const strip = (source, loader) =>
  transformSync(source, {
    loader,
    legalComments: "none",
    minifyWhitespace: true,
  }).code;

export const tsCodeEquivalent = (before, after, loader) =>
  strip(before, loader) === strip(after, loader);

export const isCommentOrBlank = (line) => {
  const t = line.trim();
  return (
    t === "" ||
    t.startsWith("//") ||
    t.startsWith("/*") ||
    t === "*" ||
    t === "*/" ||
    t.startsWith("* ")
  );
};

const DIFF_HEADER =
  /^(diff |index |new file|deleted file|similarity |rename |old mode|new mode|Binary files)/;

// `--- `/`+++ ` are diff file-markers only when followed by a/, b/, or
// /dev/null. A removed/added content line that happens to start with those
// three characters (e.g. a line reading "-- keep sorted by mtime" inside a
// string) must not be mistaken for one.
const DIFF_FILE_MARKER = /^(?:--- |\+\+\+ )(?:a\/|b\/|\/dev\/null)/;

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
      line.startsWith("@@") ||
      DIFF_FILE_MARKER.test(line) ||
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

// Classifies one changed TS/TSX path given its git status and the pieces
// already fetched for it. Pure and IO-free so it is directly unit-testable:
// - status "A" (added in this range): nothing to diff against, so it is
//   routed to manual review instead of being silently skipped.
// - `before` an Error (git show failed for any other reason, e.g. a
//   transient git error): routed to hard with the error text, instead of
//   being swallowed as if the file were merely added.
// - otherwise, deleted / code-changed / equivalent as before.
export const classifyTsFileChange = ({
  path,
  status,
  before,
  after,
  loader,
  fileExists,
}) => {
  if (status === "A") {
    return {
      hard: null,
      manual: `${path}: added in this range — not verifiable by comparison, review by eye`,
    };
  }
  if (before instanceof Error) {
    return { hard: `${path}: git show failed — ${before.message}`, manual: null };
  }
  if (!fileExists) {
    return { hard: `${path}: file deleted`, manual: null };
  }
  if (!tsCodeEquivalent(before, after, loader)) {
    return { hard: `${path}: code changed (esbuild output differs)`, manual: null };
  }
  return { hard: null, manual: null };
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

  const statuses = git([
    "diff",
    "--name-status",
    baseRef,
    "--",
    "src",
    "src-tauri/src",
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const cols = line.split("\t");
      return { status: cols[0], path: cols[cols.length - 1] };
    });

  for (const { status, path } of statuses) {
    if (!/\.tsx?$/.test(path)) continue;

    let before = null;
    if (status !== "A") {
      try {
        before = git(["show", `${baseRef}:${path}`]);
      } catch (err) {
        before = err instanceof Error ? err : new Error(String(err));
      }
    }

    const fileExists = existsSync(path);
    const result = classifyTsFileChange({
      path,
      status,
      before,
      after: fileExists ? readFileSync(path, "utf8") : null,
      loader: path.endsWith(".tsx") ? "tsx" : "ts",
      fileExists,
    });
    if (result.hard) hard.push(result.hard);
    if (result.manual) manual.push(result.manual);
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
    console.error("MANUAL REVIEW REQUIRED — could not be judged automatically, confirm by eye:");
    console.error("  (a line containing // may be a trailing comment or a // inside a string;");
    console.error("   an added file has no prior revision to diff against)");
    for (const l of manual) console.error(`  ${l}`);
    process.exit(2);
  }
  console.log(
    `verify-comment-only: OK — ${statuses.length} file(s) vs ${baseRef}, comments only`,
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
