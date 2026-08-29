import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyRustDiff,
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
