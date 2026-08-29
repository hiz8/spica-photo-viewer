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
// way in isolation — it may be a trailing comment or a `//` inside a string —
// so a removed line is first paired against an added line in the same file
// whose text is IDENTICAL once a trailing `// ...` is stripped from
// whichever side has one; a matched pair differs only in its comment (added,
// removed, or reworded) and is reported for manual review (exit 2) rather
// than silently accepted. A removed line with no such match — including one
// that carried a trailing comment — is a real deleted statement and is
// always hard (exit 1): pairing must never be the thing that excuses a
// deleted assertion just because it happened to have a `// comment` on the
// end. Added files (no base-ref revision to diff against) land in the same
// manual-review bucket.
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

// The code portion of a diff line body, with a trailing `// ...` comment (if
// any) stripped and trailing whitespace trimmed. Two lines with the same
// code portion differ only in their comment — this is what pairing matches
// on. Matches on the FIRST `//`, same ambiguity the single-line check always
// had (a `//` inside a string literal cannot be told apart from a comment
// marker here); that ambiguity is exactly why a match is still routed to
// manual rather than accepted outright.
const codePortion = (body) => {
  const idx = body.indexOf("//");
  return (idx === -1 ? body : body.slice(0, idx)).trimEnd();
};

export const classifyRustDiff = (diff) => {
  const hard = [];
  const manual = [];
  let file = "?";
  // Collect candidate +/- lines per file first; pairing needs to see both
  // sides of the diff before it can classify either one.
  const byFile = new Map();
  const bucketFor = (f) => {
    if (!byFile.has(f)) byFile.set(f, { removed: [], added: [] });
    return byFile.get(f);
  };

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
    const entry = { raw: line, body, code: codePortion(body) };
    (line.startsWith("-")
      ? bucketFor(file).removed
      : bucketFor(file).added
    ).push(entry);
  }

  for (const [f, { removed, added }] of byFile) {
    // Exact-text pairing, scoped to this file: an added line whose code
    // portion equals a removed line's code portion is the same statement
    // with only its comment touched. Each added line pairs at most once, so
    // duplicate statements (two removed lines with the same code) each need
    // their own distinct added counterpart, not one shared match.
    const addedByCode = new Map();
    for (const a of added) {
      if (!addedByCode.has(a.code)) addedByCode.set(a.code, []);
      addedByCode.get(a.code).push(a);
    }
    const usedAdded = new Set();
    for (const r of removed) {
      const match = addedByCode.get(r.code)?.find((a) => !usedAdded.has(a));
      if (match) {
        usedAdded.add(match);
        manual.push(`${f}: ${r.raw}`);
        manual.push(`${f}: ${match.raw}`);
      } else {
        // No code-identical counterpart was added: a real deleted statement.
        // It must never read as "manual" just because it carried a trailing
        // comment — that is precisely the loophole this pairing closes.
        hard.push(`${f}: ${r.raw}`);
      }
    }
    for (const a of added) {
      if (usedAdded.has(a)) continue;
      (a.body.includes("//") ? manual : hard).push(`${f}: ${a.raw}`);
    }
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

// A bad base ref makes `git()` throw; left uncaught that exits 1 with a raw
// Node stack trace and no banner — indistinguishable from the exit 1 that
// means "code change detected". This wrapper turns it into a labeled failure
// instead.
const diffAgainstBase = (baseRef, args) => {
  try {
    return git(args);
  } catch (err) {
    console.error(
      `BASE REF ERROR — could not diff against '${baseRef}': ${err.message.trim()}`,
    );
    process.exit(1);
  }
};

const main = () => {
  const baseRef = process.argv[2] ?? "HEAD";
  const hard = [];
  const manual = [];

  const statuses = diffAgainstBase(baseRef, [
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
    diffAgainstBase(baseRef, ["diff", "-U0", baseRef, "--", "src-tauri/src"]),
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
  const tsChecked = statuses.filter(({ path }) => /\.tsx?$/.test(path));
  const rustChecked = statuses.filter(({ path }) => /\.rs$/.test(path));
  const uncovered = statuses.filter(
    ({ path }) => !/\.tsx?$/.test(path) && !/\.rs$/.test(path),
  );

  console.log(
    `verify-comment-only: OK — ${tsChecked.length} TS/TSX file(s) checked via esbuild, ` +
      `${rustChecked.length} Rust file(s) checked via line diff, vs ${baseRef}`,
  );
  if (uncovered.length > 0) {
    console.log(
      `verify-comment-only: NOT CHECKED by either path (review by eye): ${uncovered
        .map(({ path }) => path)
        .join(", ")}`,
    );
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
