import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyRustDiff,
  classifyTsFileChange,
  isCommentOrBlank,
  tsCodeEquivalent,
} from "../verify-comment-only.mjs";

test("a comment-only rewrite is equivalent", () => {
  const before = "/**\n * Debounce delay for image loading\n * Prevents intermediate loads\n */\nexport const N = 50;\n";
  const after = "/** Prevents intermediate loads during rapid navigation. */\nexport const N = 50;\n";
  assert.equal(tsCodeEquivalent(before, after, "ts"), true);
});

test("a one-character value change is not equivalent", () => {
  assert.equal(
    tsCodeEquivalent("export const N = 50;\n", "export const N = 51;\n", "ts"),
    false,
  );
});

test("a removed trailing comment is equivalent", () => {
  assert.equal(
    tsCodeEquivalent("const a = 1; // note\n", "const a = 1;\n", "ts"),
    true,
  );
});

test("a legal comment is stripped rather than preserved", () => {
  assert.equal(
    tsCodeEquivalent("/** @license MIT */\nconst a = 1;\n", "const a = 1;\n", "ts"),
    true,
  );
});

test("tsx is handled", () => {
  assert.equal(
    tsCodeEquivalent("// c\nexport const C = () => <div />;\n", "export const C = () => <div />;\n", "tsx"),
    true,
  );
});

test("deleting an object-literal property comment is equivalent (esbuild retains these otherwise)", () => {
  const before = "const o = {\n  // Initial state\n  gamma: 3,\n};\n";
  const after = "const o = {\n  gamma: 3,\n};\n";
  assert.equal(tsCodeEquivalent(before, after, "ts"), true);
});

test("an object-literal property VALUE change is not equivalent, even with the same comment removed", () => {
  const before = "const o = {\n  // Initial state\n  gamma: 3,\n};\n";
  const after = "const o = {\n  gamma: 4,\n};\n";
  assert.equal(tsCodeEquivalent(before, after, "ts"), false);
});

test("a changed string literal containing // is not equivalent (not mistaken for a comment)", () => {
  const before = 'const url = "http://a//b";\n';
  const after = 'const url = "http://a//c";\n';
  assert.equal(tsCodeEquivalent(before, after, "ts"), false);
});

test("a renamed identifier is not equivalent", () => {
  assert.equal(
    tsCodeEquivalent("const a = 1;\nexport { a };\n", "const b = 1;\nexport { b as a };\n", "ts"),
    false,
  );
});

test("isCommentOrBlank accepts comment and blank lines", () => {
  for (const line of ["", "   ", "// x", "  /// doc", "//! module", "/* open", "  * cont", "  */"]) {
    assert.equal(isCommentOrBlank(line), true, line);
  }
});

test("isCommentOrBlank rejects code, with or without a trailing comment", () => {
  for (const line of ["let x = 1;", "let x = 1; // note", "}"]) {
    assert.equal(isCommentOrBlank(line), false, line);
  }
});

test("isCommentOrBlank rejects a Rust dereference that starts with an asterisk", () => {
  for (const line of [
    '*s.get_mut("preview_files").unwrap() += 1;',
    "*count += 1;",
  ]) {
    assert.equal(isCommentOrBlank(line), false, line);
  }
});

test("isCommentOrBlank still accepts bare and closing asterisk comment lines", () => {
  for (const line of ["*", "*/", "  * doc continuation"]) {
    assert.equal(isCommentOrBlank(line), true, line);
  }
});

test("classifyRustDiff passes a comment-only hunk", () => {
  const diff = [
    "diff --git a/src-tauri/src/a.rs b/src-tauri/src/a.rs",
    "index 111..222 100644",
    "--- a/src-tauri/src/a.rs",
    "+++ b/src-tauri/src/a.rs",
    "@@ -1,2 +1,1 @@",
    "-// What this does",
    "-// Why it must be so",
    "+// Why it must be so",
  ].join("\n");
  const { hard, manual } = classifyRustDiff(diff);
  assert.deepEqual(hard, []);
  assert.deepEqual(manual, []);
});

test("classifyRustDiff flags a changed code line", () => {
  const diff = [
    "--- a/src-tauri/src/a.rs",
    "+++ b/src-tauri/src/a.rs",
    "@@ -1 +1 @@",
    "-let x = 1;",
    "+let x = 2;",
  ].join("\n");
  const { hard } = classifyRustDiff(diff);
  assert.equal(hard.length, 2);
  assert.ok(hard[0].includes("src-tauri/src/a.rs"));
});

test("classifyRustDiff routes a trailing-comment line to manual review", () => {
  const diff = [
    "--- a/src-tauri/src/a.rs",
    "+++ b/src-tauri/src/a.rs",
    "@@ -1 +1 @@",
    "-previews.sort_by_key(|p| p.1); // oldest first",
    "+previews.sort_by_key(|p| p.1); // oldest first, so the sweep drops the stalest",
  ].join("\n");
  const { hard, manual } = classifyRustDiff(diff);
  assert.deepEqual(hard, []);
  assert.equal(manual.length, 2);
});

test("classifyRustDiff ignores rename and mode headers", () => {
  const diff = [
    "diff --git a/src-tauri/src/a.rs b/src-tauri/src/b.rs",
    "similarity index 100%",
    "rename from src-tauri/src/a.rs",
    "rename to src-tauri/src/b.rs",
    "old mode 100644",
    "new mode 100755",
  ].join("\n");
  const { hard, manual } = classifyRustDiff(diff);
  assert.deepEqual(hard, []);
  assert.deepEqual(manual, []);
});

test("classifyRustDiff routes a changed dereference line to hard, not dropped", () => {
  const diff = [
    "--- a/src-tauri/src/a.rs",
    "+++ b/src-tauri/src/a.rs",
    "@@ -1 +1 @@",
    '-*s.get_mut("preview_files").unwrap() += 1;',
    '+*s.get_mut("preview_files").unwrap() += 2;',
  ].join("\n");
  const { hard, manual } = classifyRustDiff(diff);
  assert.equal(hard.length, 2);
  assert.deepEqual(manual, []);
  assert.ok(hard[0].includes("src-tauri/src/a.rs"));
});

test("classifyRustDiff does not swallow a removed content line that starts with --- ", () => {
  const diff = [
    "--- a/src-tauri/src/a.rs",
    "+++ b/src-tauri/src/a.rs",
    "@@ -1 +0,0 @@",
    "--- keep sorted by mtime",
  ].join("\n");
  const { hard, manual } = classifyRustDiff(diff);
  assert.equal(hard.length, 1);
  assert.deepEqual(manual, []);
  assert.ok(hard[0].includes("--- keep sorted by mtime"));
});

test("classifyRustDiff does not swallow an added content line that starts with +++ ", () => {
  const diff = [
    "--- a/src-tauri/src/a.rs",
    "+++ b/src-tauri/src/a.rs",
    "@@ -0,0 +1 @@",
    "+++ keep sorted by mtime",
  ].join("\n");
  const { hard, manual } = classifyRustDiff(diff);
  assert.equal(hard.length, 1);
  assert.deepEqual(manual, []);
  assert.ok(hard[0].includes("+++ keep sorted by mtime"));
});

test("classifyTsFileChange routes an added file to manual instead of skipping it", () => {
  const result = classifyTsFileChange({
    path: "src/new-module.ts",
    status: "A",
    before: null,
    after: "export const x = 1;\n",
    loader: "ts",
    fileExists: true,
  });
  assert.equal(result.hard, null);
  assert.equal(
    result.manual,
    "src/new-module.ts: added in this range — not verifiable by comparison, review by eye",
  );
});

test("classifyTsFileChange routes a git-show failure to hard with the error text, not skipped", () => {
  const result = classifyTsFileChange({
    path: "src/broken.ts",
    status: "M",
    before: new Error("fatal: path does not exist in <ref>"),
    after: "export const x = 1;\n",
    loader: "ts",
    fileExists: true,
  });
  assert.equal(result.manual, null);
  assert.ok(result.hard.includes("src/broken.ts"));
  assert.ok(result.hard.includes("fatal: path does not exist in <ref>"));
});

test("classifyTsFileChange still flags a real code change as hard", () => {
  const result = classifyTsFileChange({
    path: "src/const.ts",
    status: "M",
    before: "export const N = 50;\n",
    after: "export const N = 51;\n",
    loader: "ts",
    fileExists: true,
  });
  assert.equal(result.manual, null);
  assert.ok(result.hard.includes("code changed"));
});

test("classifyTsFileChange passes a comment-only modification", () => {
  const result = classifyTsFileChange({
    path: "src/const.ts",
    status: "M",
    before: "// old note\nexport const N = 50;\n",
    after: "// new note\nexport const N = 50;\n",
    loader: "ts",
    fileExists: true,
  });
  assert.equal(result.hard, null);
  assert.equal(result.manual, null);
});

test("classifyTsFileChange flags a deleted file as hard", () => {
  const result = classifyTsFileChange({
    path: "src/gone.ts",
    status: "M",
    before: "export const N = 50;\n",
    after: null,
    loader: "ts",
    fileExists: false,
  });
  assert.equal(result.manual, null);
  assert.ok(result.hard.includes("file deleted"));
});
