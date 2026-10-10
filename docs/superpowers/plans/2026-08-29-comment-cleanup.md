# コメント整理・簡素化 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `src/` と `src-tauri/src/` の What コメントを削除し Why コメントを圧縮する。設計知見は失わず、コードに残った孤児ラベルを解消する。

**Architecture:** Phase 0（根拠の移設・検証スクリプト・規約）を先行させ、続く Phase 1〜3 をコメントのみの変更として機械検証する。TS/TSX は esbuild でコメント除去後のコード一致を検証し、Rust は差分の行検査で代替する。ロジックに触れるヘルパ抽出だけを Phase 4 として別 PR に隔離する。

**Tech Stack:** Node 22（`node:test` 組み込みランナー）、esbuild 0.28.2（`node_modules` に既存、transform API）、git、Biome、vitest、cargo。

**Spec:** `docs/superpowers/specs/2026-08-29-comment-cleanup-design.md`

**Worktree:** `.claude/worktrees/comment-cleanup`（ブランチ `chore/comment-cleanup`、基点 main = f374d55 = origin/main）。以下のコマンドはすべてこの worktree のルートで実行する。

## Global Constraints

- **コメントのみ**: Task 4〜10 ではロジックを 1 行も変更しない。変数名・空白・import 順も変えない。書式は Biome に任せる。
- **判断基準**: スペック §6.1 の DEL / CMP / KEEP / MOVE。KEEP1〜KEEP5 に該当する内容は削除も要約もしない。
- **機能を持つコメントは絶対に削除しない**: `biome-ignore`、`@ts-expect-error`、`@ts-ignore`、`/// <reference ... />`（`src/vite-env.d.ts` の 1 行は TypeScript のディレクティブでありコメントではない）、`// @vitest-environment`、`/* @__PURE__ */`。Rust の `#[...]` / `#![...]` は属性でありコメントではない。
- **参照記法**: ファイル先頭に 1 回だけ `Spec: docs/superpowers/specs/<file>.md`。以降のインラインは `§6.6` / `(I2)` のみ。
- **コメントは英語で書く**（既存コードの慣習。日本語コメントは現在 1 行のみ）。
- **各タスクの完了条件**: `npm run verify:comments -- <base>` が exit 0（または exit 2 を目視確認して受理）、かつ**そのタスクが触れた側のスイートが green**。TS を触ったら `npm test` / `npm run type-check` / `npm run lint`、Rust を触ったら `cd src-tauri && cargo test --lib`。どちらも触っていないタスク（Task 2 / Task 3）はスイート実行不要。各タスクの Step に書かれたコマンドが正であり、この行はその要約である。
- **lint/format**: 編集後は hook が Biome を走らせる。hook が走らなかった場合に備え、コミット前に `npm run lint` と `npm run format` で差分が出ないことを確認する。
- **ベンチ**: Task 12 のみ `npm run bench:build && npm run bench`。Task 1〜11 では不要（生成物に影響しない）。

---

## 事前準備: worktree の初期化

Task 1 を始める前に一度だけ実行する。

```bash
cd .claude/worktrees/comment-cleanup
npm install
```

`npm install` が `package-lock.json` の行末（EOL）差分を作ることがある。その場合は `git checkout package-lock.json` で戻す。

corpus 生成と `bench:build` は Task 12 でのみ必要なので、この時点では実行しない。

---

## Task 1: コメントのみ変更を検証するスクリプト

**Files:**
- Create: `scripts/verify-comment-only.mjs`
- Create: `scripts/__tests__/verify-comment-only.test.mjs`
- Modify: `package.json`（`scripts` に `verify:comments` を追加）
- Modify: `vitest.config.ts`（`test.exclude` に `scripts/**` を追加）

**`vitest.config.ts` を触る理由:** vitest の既定の include グロブは `*.test.mjs` にマッチするため、新しい `node:test` のテストファイルを vitest が拾い、`node:test` のバンドルに失敗して `npm test` が落ちる。`exclude: [...configDefaults.exclude, 'scripts/**']` として既定値を展開した上で追加すること（既定値を置き換えると `node_modules` などの除外が消える）。

**Interfaces:**
- Consumes: なし
- Produces:
  - `tsCodeEquivalent(before: string, after: string, loader: "ts" | "tsx"): boolean`
  - `isCommentOrBlank(line: string): boolean`
  - `classifyRustDiff(diff: string): { hard: string[]; manual: string[] }`
  - CLI: `node scripts/verify-comment-only.mjs [baseRef]` — exit 0 = コメントのみ、1 = コード変更あり、2 = 行末コメント行があり目視確認が必要

**背景（実測済みの制約。設計を変えないこと）:**
- esbuild は vitest の `jsdom` 環境では動かない（jsdom の `TextEncoder` が別レルムの `Uint8Array` を返し、esbuild が invariant 違反で落ちる）。`// @vitest-environment node` を付けても `src/__tests__/setup.ts` が DOM 前提のため失敗する。よって**このテストは vitest ではなく Node 組み込みの `node:test` で書く**。
- `node --test <ディレクトリ>` は Windows で `MODULE_NOT_FOUND` になる。**必ずファイルパスを明示する。**
- `transformSync(src, { loader, legalComments: "none" }).code` は実測で、コメントのみの書き換えでは出力が一致し、`50` → `51` の 1 文字変更では一致しない。`@license` / `//!` も除去される。

- [ ] **Step 1: 失敗するテストを書く**

`scripts/__tests__/verify-comment-only.test.mjs`:

```javascript
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
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test scripts/__tests__/verify-comment-only.test.mjs`
Expected: FAIL — `Cannot find module '../verify-comment-only.mjs'`

- [ ] **Step 3: スクリプトを実装する**

`scripts/verify-comment-only.mjs`:

```javascript
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
  // NOT `t.startsWith("*")`: that classifies Rust's dereference operator as a
  // comment, so a changed `*s.get_mut("x").unwrap() += 1;` line would be
  // dropped from both hard and manual and the gate would exit 0 on a real
  // logic change. `cache.rs` and `perf.rs` already contain 5 such lines.
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
```

> **この Step 3 のコードは実装後のレビューで 4 件の欠陥が見つかり、修正コミット `d28fe27` で置き換えられている。** 現行の正は `scripts/verify-comment-only.mjs` そのものであり、上のブロックは初版の記録である。修正内容: (1) 上記 `isCommentOrBlank` の間接参照バグ、(2) `git show` の失敗を握り潰さず追加ファイルは manual・その他のエラーは hard に振り分ける（`classifyTsFileChange()` に抽出）、(3) exit 2 の見出しが `//` を含む行を断定的にコメントと呼ばない文言に変更、(4) `--- `/`+++ ` を `a/` `b/` `/dev/null` が続く場合のみヘッダとみなす。

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test scripts/__tests__/verify-comment-only.test.mjs`
Expected: PASS — `# fail 0`（初版は 12 件、レビュー修正後は 22 件）

- [ ] **Step 5: package.json に script を追加する**

`package.json` の `"scripts"` に以下の 2 行を追加する。**`package.json` は CRLF なので `sed` を使わず Edit ツールで編集する。**

```json
    "verify:comments": "node scripts/verify-comment-only.mjs",
    "verify:comments:test": "node --test scripts/__tests__/verify-comment-only.test.mjs",
```

- [ ] **Step 6: CLI が動くことを確認する**

Run: `npm run verify:comments -- HEAD`
Expected: exit 0、`verify-comment-only: OK — 0 file(s) vs HEAD, comments only`（この時点で `src` に変更はない）

- [ ] **Step 7: コミット**

```bash
git add scripts/verify-comment-only.mjs scripts/__tests__/verify-comment-only.test.mjs package.json
git commit -m "chore(comments): add comment-only change verification script"
```

---

## Task 2: 孤児ラベルの根拠を docs へ移設

**Files:**
- Create: `docs/code-rationale.md`
- Modify: なし（**このタスクではコードに一切触れない**。N1）

**Interfaces:**
- Consumes: なし
- Produces: `docs/code-rationale.md` のアンカー `#x1` `#x2` `#m1` `#build-time`。Task 7 がこれらを参照する。

**スペック §6.1 MOVE からの修正（意図的な逸脱。理由を含めて記載する）:**

スペックは孤児ラベル 13 箇所を「全文移設」と書いているが、実際に中身を読むと 2 種類ある。計画ではラベルごとに扱いを分ける。どちらも N3（ラベルに定義がある）を満たす。

| ラベル | 参照箇所 | 根拠の長さ | 扱い |
|---|---|---|---|
| X1 | preview.rs 6 箇所 | 12 行 | **移設**。複数箇所から参照される |
| X2 | preview.rs 2 箇所 | 4 行 | **移設**。2 箇所から参照される |
| M1 | preview.rs 1 箇所 | 5 行 | **移設**。ビルド時間の知見と対で読む価値がある |
| BUILD-TIME（無ラベル） | preview.rs 1 箇所 | 7 行 | **移設**。`resize_rgb8` の doc 内、2026-08-23 の計測値を含む |
| M3 / M4 / M5 / M6 | 各 1 箇所 | 各 2〜4 行 | **ラベル接頭辞のみ削除し本文はその場に残す**。単一箇所から参照される自己完結した 2〜4 行で、doc に出すと参照の往復が増えるだけで読み手の利益にならない |

- [ ] **Step 1: `docs/code-rationale.md` を作成する**

冒頭に以下の導入を置く。

```markdown
# コード根拠集（code rationale）

`docs/superpowers/specs/` 配下の設計ドキュメントが日付付きの設計記録であるのに対し、
このファイルは実装に張り付いた根拠を蓄積する生きたドキュメントである。
コードのコメントから 1 行で参照される。

各節はコードから `— docs/code-rationale.md#<anchor>` の形で参照される。
節を削除・改名するときは参照元も同時に直すこと。
```

続けて以下の 4 節を作る。**本文は現在のコードのコメントから一字一句そのまま移す**（要約しない。KEEP2 / KEEP3 に該当する内容である）。

**見出しはラベルだけにする。** `## X1: CMYK でのICC破棄` のように説明を付けると GitHub のアンカーが `#x1-cmyk-でのicc破棄` になり、コードから参照する `#x1` と一致しなくなる。見出しは `## X1` とし、説明は見出しの次の行に書く。

```markdown
## X1

**CMYK/YCCK ソースでは ICC プロファイルを落とす**

（根拠の本文）

参照元: `src-tauri/src/utils/preview.rs`
```

この形式で以下の 4 節を作る。

- `## X1` — 出典 `src-tauri/src/utils/preview.rs:144-155` の doc コメント全文。加えて `preview.rs:91-93`（`original_color` フィールドの説明）、`:109`（`from_decoder` が decoder を消費する前に読む必要）、`:252`、`:346`、`:437`（`image` 0.25 の JPEG decoder が CMYK/YCCK を `Rgb8` と報告する）の各補足も同じ節にまとめる。
- `## X2` — 出典 `preview.rs:218` と `:456`。エンコーダが拒否する ICC プロファイル長について。
- `## M1` — 出典 `preview.rs:123-127`。`into_rgb8()` による無コピー変換。24 MP 写真で約 72 MB という数値を必ず残す（KEEP2）。
- `## BUILD-TIME` — 出典 `preview.rs:177-183`。「動的 `Resizer::resize` は 13 ピクセル型 × 全 SIMD パスを単相化し、このクレートの LLVM パスを約 80 秒延ばした（2026-08-23 計測）。`TypedImageRef<U8x3>` / `resize_typed` は RGB8 パスだけを単相化する」という内容と数値を必ず残す。

- [ ] **Step 2: 移設漏れがないことを確認する**

Run:
```bash
grep -c '^## ' docs/code-rationale.md
grep -oE '80 s|72 MB|2026-08-23|254' docs/code-rationale.md | sort | uniq -c
```
Expected: 節が 4 つ。`80 s`（または `80 秒`）、`72 MB`、`2026-08-23` が各 1 回以上出る。数値が落ちていれば KEEP2 違反なので Step 1 に戻る。

- [ ] **Step 3: コードが未変更であることを確認する**

Run: `git status --short`
Expected: `?? docs/code-rationale.md` のみ。`src/` と `src-tauri/` に変更がないこと（N1）。

- [ ] **Step 4: コミット**

```bash
git add docs/code-rationale.md
git commit -m "docs(comments): migrate orphaned code rationale (X1/X2/M1/build-time) out of preview.rs"
```

---

## Task 3: CLAUDE.md にコメント方針を追記

**Files:**
- Modify: `CLAUDE.md`（`## Testing` の直後、`## Project Specs` の直前に新しい節を挿入）

**Interfaces:**
- Consumes: Task 1 の `npm run verify:comments`、Task 2 の `docs/code-rationale.md`
- Produces: なし

- [ ] **Step 1: `## Comments` 節を追記する**

```markdown
## Comments

- コメントは Why を書く。What（コードを読めば判ること）は書かない。詳細は [コメント整理の設計](./docs/superpowers/specs/2026-08-29-comment-cleanup-design.md) §6.1。
- **DEL（書かない・消す）**: 直後のコードの言い換え / 名前を言い換えただけの JSDoc 1 行目 / テストの手続き実況 / コメントアウトされたコード / 型やシグネチャが既に述べていること。
- **CMP（圧縮する）**: 「What 行 + Why 行」は Why 1 行に統合する。スペックに定義がある内容は再説明せず `§6.6` / `(I2)` で参照する。
- **KEEP（必ず残す）**: なぜこの実装でないと壊れるか / 数値の根拠 / 外部ライブラリ・OS の落とし穴 / 意図的な非採用 / 不変条件の表明。
- **孤児ラベルを作らない**: 新しい根拠に `X1` のようなラベルを付けるなら、定義を [docs/code-rationale.md](./docs/code-rationale.md) に置き、コードからは 1 行で参照する。コードのコメントだけが唯一の記録という状態にしない。
- **スペック参照**: ファイル先頭に 1 回だけ `Spec: docs/superpowers/specs/<file>.md` を書き、以降のインラインは `§6.6` / `(I2)` のみ。日付とパスを繰り返さない。
- **機能を持つコメントは削除しない**: `biome-ignore` / `@ts-expect-error` / `/// <reference ... />` / `// @vitest-environment` / `/* @__PURE__ */`。
- コメントのみの変更は `npm run verify:comments -- <base-ref>` で検証する（TS/TSX は esbuild でコード一致を機械確認、Rust は差分の行検査）。exit 2 は行末コメント行の目視確認を求めるもので、確認できれば受理してよい。
```

- [ ] **Step 2: リンク先が存在することを確認する**

Run:
```bash
ls docs/superpowers/specs/2026-08-29-comment-cleanup-design.md docs/code-rationale.md
```
Expected: 両方存在する

- [ ] **Step 3: コミット**

```bash
git add CLAUDE.md
git commit -m "docs(comments): add comment policy to CLAUDE.md"
```

---

## Task 4: Phase 1 — TypeScript 非テストの DEL 適用

**Files（すべて Modify）:**

| ファイル | コメント/総行 | 主な対象 |
|---|---|---|
| `src/App.tsx` | 3/70 | DEL4（10 行目のコメントアウト import） |
| `src/components/DropZone.tsx` | 1/91 | DEL1 |
| `src/components/ThumbnailBar.tsx` | 10/201 | DEL1 |
| `src/constants/memory.ts` | 22/37 | DEL2 |
| `src/constants/timing.ts` | 53/77 | DEL2（各 JSDoc の 1 行目が定数名の言い換え） |
| `src/hooks/useWindowState.ts` | 5/84 | DEL1 |
| `src/store/index.ts` | 60/951 | DEL1 |
| `src/types/index.ts` | 2/157 | DEL5 |
| `src/utils/canvasDraw.ts` | 6/17 | DEL1 |
| `src/utils/imageSrc.ts` | 8/22 | DEL1 / DEL5 |
| `src/utils/path.ts` | 8/25 | DEL1 / DEL5 |
| `src/utils/perf.ts` | 10/57 | DEL1 |
| `src/utils/previewBox.ts` | 7/45 | DEL1 |
| `src/utils/protocolLoader.ts` | 7/38 | DEL1 |
| `src/utils/testFactories.ts` | 4/176 | DEL1 |

**触らないファイル:** `src/vite-env.d.ts`（唯一の行 `/// <reference types="vite/client" />` は TypeScript のディレクティブ。削除すると型が壊れる）。B 群の 7 ファイルは Task 6 で扱う。

**Interfaces:**
- Consumes: Task 1 の `npm run verify:comments`
- Produces: なし

**このタスクの基準線:** 直前のコミット（Task 3 のコミット）。以下 `BASE` と書く。

- [ ] **Step 1: 基準線を記録する**

```bash
git rev-parse --short HEAD
```
この値を控える。以降の `npm run verify:comments -- <BASE>` で使う。

- [ ] **Step 2: `src/constants/timing.ts` を書き換える**

各定数の JSDoc から名前を言い換えた 1 行目を落とし、Why の行だけを 1 行の JSDoc に畳む。例:

```typescript
/**
 * Debounce delay for image loading in ImageViewer
 * Prevents loading intermediate images during rapid navigation
 */
export const IMAGE_LOAD_DEBOUNCE_MS = 50;
```

を

```typescript
/** Prevents loading intermediate images during rapid navigation. */
export const IMAGE_LOAD_DEBOUNCE_MS = 50;
```

にする。ファイル冒頭の `All values are in milliseconds` は KEEP（`PRELOAD_RANGE` や `THUMBNAIL_SIZE` のように ms でない定数が混ざっているので、単位の但し書きとして残しつつ「一部は個数・ピクセル」と正しく直す）。`THUMBNAIL_GENERATION_EXPANDED_RANGE` の `900+ images` という数値は KEEP2 なので残す。

- [ ] **Step 3: 残りの 14 ファイルに DEL を適用する**

各ファイルについて、直後のコードを言い換えただけの行（DEL1）、名前の言い換え JSDoc 1 行目（DEL2）、コメントアウトされたコード（DEL4）、型が既に述べている記述（DEL5）を削除する。Why を含む行、数値を含む行、意図的な非採用を述べる行は残す。

具体例:

```typescript
// src/App.tsx:10 — DEL4。使われていない import のコメントアウト
// import { useFileDrop } from './hooks/useFileDrop';
```

```typescript
// src/constants/memory.ts — DEL2。定数名が既に述べている
/**
 * Budget for decoded bitmaps
 */
export const BITMAP_CACHE_BUDGET_BYTES = ...;
```
は Why 行があればそれだけを 1 行 JSDoc に残し、Why 行がなければ JSDoc ごと削除する。

```typescript
// src/store/index.ts — DEL1。直後のコードが同じことを言っている
// Reset the view state
set({ zoom: 1, pan: { x: 0, y: 0 } });
```

判断に迷う行は消さずに残す。Task 6 で B 群として再評価する機会がある（このタスクの対象ファイルは B 群ではないので、迷う行はそもそも少ないはずである）。

- [ ] **Step 4: コメントのみの変更であることを検証する**

Run: `npm run verify:comments -- <BASE>`
Expected: exit 0、`verify-comment-only: OK — N file(s) vs <BASE>, comments only`（N ≤ 15。コメントがすべて KEEP だったファイルは変更されないので 15 未満になりうる）

exit 1 が出た場合、そのファイルでコードを壊している。指摘されたファイルを `git diff <BASE> -- <path>` で確認し、コード部分を元に戻す。

- [ ] **Step 5: テストと型検査を通す**

```bash
npm test
npm run type-check
npm run lint
npm run format
```
Expected: すべて green、`npm run format` が差分を報告しない

- [ ] **Step 6: コミット**

```bash
git add src
git commit -m "refactor(comments): drop what-comments from non-test TypeScript"
```

---

## Task 5: Phase 1 — Rust 非テストの DEL 適用

**Files（すべて Modify、`#[cfg(test)]` より前の領域のみ）:**

| ファイル | コメント/総行 | `#[cfg(test)]` 開始行 |
|---|---|---|
| `src-tauri/src/lib.rs` | 9/114 | 5 |
| `src-tauri/src/main.rs` | 1/6 | なし |
| `src-tauri/src/commands/window.rs` | 2/129 | なし |
| `src-tauri/src/protocol.rs` | 26/276 | 152 |
| `src-tauri/src/utils/image.rs` | 3/115 | 31 |
| `src-tauri/src/utils/perf.rs` | 5/69 | 50 |
| `src-tauri/src/utils/natural_sort.rs` | 28/126 | 72 |

**触らないファイル:** `commands/mod.rs` と `utils/mod.rs`（コメント 0 行）。B 群の 4 ファイル（`preview.rs` / `explorer_sort.rs` / `file.rs` / `cache.rs`）は Task 7。`#[cfg(test)]` 以降は Task 10。

**Interfaces:**
- Consumes: Task 1 の `npm run verify:comments`
- Produces: なし

- [ ] **Step 1: 各ファイルの非テスト領域に DEL を適用する**

`natural_sort.rs` の `StrCmpLogicalW` の挙動に関する記述は KEEP3（外部 API の落とし穴）なので残す。`protocol.rs` のルーティングに関する記述のうち、スペックに定義がある内容は Task 7 の CMP2 ではなくここでは触らず、明らかな What 行のみ削除する。

**行末コメントは編集しない。** 行末コメントを直したい場合はその行を飛ばし、Task 7 の目視確認付き変更にまとめる（検証スクリプトの exit 2 を無用に増やさない）。

- [ ] **Step 2: コメントのみの変更であることを検証する**

Run: `npm run verify:comments -- <BASE>`（`<BASE>` は Task 4 のコミット）
Expected: exit 0

exit 2 が出た場合は、報告された行末コメント行を目視し、コメント部分しか変わっていないことを確認する。確認できなければ元に戻す。

- [ ] **Step 3: Rust のテストを通す**

```bash
cd src-tauri && cargo test --lib && cd ..
```
Expected: 全件 pass

- [ ] **Step 4: コミット**

```bash
git add src-tauri/src
git commit -m "refactor(comments): drop what-comments from non-test Rust"
```

---

## Task 6: Phase 2 — TypeScript の CMP 圧縮と参照統一

**Files（すべて Modify）:**

| ファイル | コメント/総行 | 内容 |
|---|---|---|
| `src/hooks/useImagePreloader.ts` | 133/321 | 不変条件 I2 / I3、スケジューラの 2 相分割の理由、`design spec 2026-08-21 §6.6` |
| `src/components/ImageViewer.tsx` | 131/859 | tier 判定、`§6.4` / `§7.1` / `Phase 2 invariant I1`、DEL1 の手続きコメントも多数 |
| `src/hooks/useThumbnailGenerator.ts` | 65/338 | `(I1)` |
| `src/utils/bitmapLoader.ts` | 35/112 | ヘッダによる natural size 判定、`src:set` を出さない理由 |
| `src/utils/bitmapCache.ts` | 28/137 | `design spec 2026-08-21 §6.4` |
| `src/utils/preloadWindow.ts` | 21/52 | `design spec 2026-08-21 §7.2` |
| `src/utils/displayTier.ts` | 8/20 | `design spec 2026-08-21 §6.4` |

**Interfaces:**
- Consumes: Task 2 の `docs/code-rationale.md`（TS 側に孤児ラベルはないので参照は発生しない）
- Produces: 統一された `Spec:` ヘッダ行。Task 8 が全ファイルを走査して検証する。

- [ ] **Step 1: ファイル先頭に `Spec:` 行を置く**

上表の 7 ファイルすべてについて、ファイル冒頭の JSDoc に 1 行追加する。

```typescript
/**
 * Spec: docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md
 *
 * ...既存の説明...
 */
```

- [ ] **Step 2: インライン参照を短縮する**

`design spec 2026-08-21 §6.6` → `§6.6`、`Phase 2 invariant I1` → `(I1)` に統一する。日付とパスはファイル先頭の 1 行にしかない状態にする。

- [ ] **Step 3: CMP1〜CMP3 を適用する**

各ファイルを 1 つずつ処理する（並列に処理しない。判断の一貫性がこのタスクの品質そのもの）。

- CMP1: 「What 行 + Why 行」を Why 1 行に統合する。
- CMP2: スペック §5 / §6.x に定義がある内容の再説明を、参照 + 1 行要約に置換する。例えば `useImagePreloader.ts` の I2 / I3 の説明本文はスペック §5 にあるので、`- I2 (window = visible range): §5 のとおり。` + その場で効く補足 1 行、という形にできる。
- CMP3: 長い散文ブロックを短文に直す。

**KEEP に該当するものは圧縮しない。** 具体的に以下は原文の情報量を維持する:
- `useImagePreloader.ts` の「20MP RGBA decode は約 80MB、screen-box preview は約 8MB」（KEEP2）
- `useImagePreloader.ts` の pump() 2 相分割の理由（「これがないとサムネイル生成中の閲覧で無制限に bitmap を保持する」）（KEEP1）
- `bitmapLoader.ts` の「`HTMLImageElement` を意図的に経由しない / `src:set` を出さない」（KEEP4）と、`"full"` を返す条件（両ヘッダが有効かつデコード結果が natural size と一致）（KEEP1）
- `ImageViewer.tsx` の「preview ルート由来の pixels は常に preview TIER にする。full にするとスケジューラの sweep が落とす」（KEEP1）と 2% ヘッドルーム（KEEP2）

- [ ] **Step 4: コメントのみの変更であることを検証する**

Run: `npm run verify:comments -- <BASE>`（`<BASE>` は Task 5 のコミット）
Expected: exit 0、7 file(s)

- [ ] **Step 5: 圧縮後の diff を 1 ファイルずつ読み直す**

```bash
git diff <BASE> -- src/hooks/useImagePreloader.ts
git diff <BASE> -- src/components/ImageViewer.tsx
git diff <BASE> -- src/hooks/useThumbnailGenerator.ts
git diff <BASE> -- src/utils/bitmapLoader.ts
git diff <BASE> -- src/utils/bitmapCache.ts
git diff <BASE> -- src/utils/preloadWindow.ts
git diff <BASE> -- src/utils/displayTier.ts
```

削除された行を 1 つずつ見て、KEEP1〜KEEP5 に該当する情報が失われていないか確認する。失われていれば戻す。これが R1 に対する唯一の歯止めである。

- [ ] **Step 6: テストと型検査を通す**

```bash
npm test
npm run type-check
npm run lint
npm run format
```
Expected: すべて green

- [ ] **Step 7: コミット**

```bash
git add src
git commit -m "refactor(comments): compress why-blocks and unify spec references in TypeScript"
```

---

## Task 7: Phase 2 — Rust の CMP 圧縮・孤児参照化・参照統一

**Files（すべて Modify、`#[cfg(test)]` より前の領域のみ）:**

| ファイル | コメント/総行 | `#[cfg(test)]` | 孤児ラベル |
|---|---|---|---|
| `src-tauri/src/utils/preview.rs` | 96/564 | 290 | X1 ×6、X2 ×2、M1 ×1、BUILD-TIME ×1 |
| `src-tauri/src/commands/explorer_sort.rs` | 87/448 | 325 | なし |
| `src-tauri/src/commands/file.rs` | 92/1065 | 416 | M5 ×1 |
| `src-tauri/src/commands/cache.rs` | 66/732 | 472 | M3、M4、M6 各 1 |

**Interfaces:**
- Consumes: Task 2 の `docs/code-rationale.md` のアンカー `#x1` `#x2` `#m1` `#build-time-fast_image_resize-の単相化`
- Produces: 孤児ラベル 0 件の状態。Task 8 が検証する。

- [ ] **Step 1: ファイル先頭の `//!` に `Spec:` 行を置く**

```rust
//! Spec: docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md
//!
//! ...既存の説明...
```

`explorer_sort.rs` と `file.rs` のソート関連は `2026-08-28-explorer-folder-sort-order-design.md` を指す。`file.rs` は両方のスペックに関係するため 2 行書く。

- [ ] **Step 2: X1 / X2 / M1 / BUILD-TIME を 1 行参照に置き換える**

`preview.rs` の該当ブロックを、根拠本文の代わりに 1 行の参照にする。

```rust
/// X1: ICC is carried only when the source was encoded as RGB/RGBA.
/// Why, and why the decoded type is not enough — docs/code-rationale.md#x1
fn icc_applies(original: ExtendedColorType) -> bool {
```

`:91-93`、`:109`、`:252`、`:346`、`:437` の X1 補足も同様に `(X1 → code-rationale.md)` を含む 1 行にする。ただし `:109` の「`from_decoder` が decoder を消費する前に読まなければならない」は**その場で守るべき順序制約**なので KEEP1 として 1 行その場に残す。

- [ ] **Step 3: M3 / M4 / M5 / M6 のラベル接頭辞を落とす**

本文（2〜4 行）はその場に残し、意味を持たない `M3:` などの接頭辞だけを消す。

```rust
// pid+nanos alone can collide when the command path and the protocol path
// race to write the same preview within one tick; a process-wide counter
// makes every temp name unique regardless of timer resolution.
```

- [ ] **Step 4: 残りに CMP1〜CMP3 を適用する**

`explorer_sort.rs` の COM 検出まわりは KEEP の塊である。以下は圧縮しない:
- 300ms 予算と「join() は残り時間だけ待つ」（KEEP2 / KEEP1）
- `OnceLock` で foreground window を凍結する理由（KEEP4）
- 「実行中のプローブがあれば COM を丸ごと飛ばす」= ハングした shell でも滞留スレッドは高々 1 本（KEEP1）
- パニックしてもデクリメントされるので検出が恒久停止しない（KEEP1）

`file.rs` の `// Process metadata in parallel using rayon` + `// This dramatically speeds up folder scanning for large folders (900+ images)` は CMP1 の例そのもので、`// Parallel: 900+ image folders are dominated by per-file metadata reads.` に統合する（900+ の数値は KEEP2 なので残す）。`// Windows API constants` は DEL1。

**行末コメントを編集した場合は exit 2 になる。** 報告された行を目視して受理する。

- [ ] **Step 5: 検証する**

Run: `npm run verify:comments -- <BASE>`（`<BASE>` は Task 6 のコミット）
Expected: exit 0、または exit 2（報告された行末コメント行をすべて目視確認できた場合のみ受理）

- [ ] **Step 6: 圧縮後の diff を 1 ファイルずつ読み直す**

```bash
git diff <BASE> -- src-tauri/src/utils/preview.rs
git diff <BASE> -- src-tauri/src/commands/explorer_sort.rs
git diff <BASE> -- src-tauri/src/commands/file.rs
git diff <BASE> -- src-tauri/src/commands/cache.rs
```

削除行に KEEP1〜KEEP5 の情報が含まれていないか確認する。含まれていて `code-rationale.md` にも無ければ戻す。

- [ ] **Step 7: Rust のテストを通す**

```bash
cd src-tauri && cargo test --lib && cd ..
```
Expected: 全件 pass

- [ ] **Step 8: コミット**

```bash
git add src-tauri/src
git commit -m "refactor(comments): compress why-blocks and reference migrated rationale in Rust"
```

---

## Task 8: ラベル参照の健全性検査（N3）

**Files:**
- Modify: なし（検査のみ。不整合が見つかった場合のみ該当ファイルを直す）

**Interfaces:**
- Consumes: Task 6 / Task 7 の結果、`docs/code-rationale.md`
- Produces: 孤児 0 件の確認

- [ ] **Step 1: コード内のラベルを列挙する**

```bash
grep -rhoE '\b([RMDIXN][0-9])\b' src src-tauri/src --include='*.ts' --include='*.tsx' --include='*.rs' | sort -u
```

- [ ] **Step 2: 定義側のラベルを列挙する**

```bash
grep -rhoE '\b([RMDIXN][0-9])\b' docs/superpowers/specs docs/code-rationale.md | sort -u
```

- [ ] **Step 3: 差分を取って孤児が 0 件であることを確認する**

```bash
comm -23 \
  <(grep -rhoE '\b([RMDIXN][0-9])\b' src src-tauri/src --include='*.ts' --include='*.tsx' --include='*.rs' | sort -u) \
  <(grep -rhoE '\b([RMDIXN][0-9])\b' docs/superpowers/specs docs/code-rationale.md | sort -u)
```
Expected: 出力なし（開始時点では `M1 M3 M4 M5 M6 X1 X2` が出ていた）

出力がある場合、そのラベルは定義のない参照である。Task 7 Step 2/3 の処理漏れなので該当箇所を直す。

- [ ] **Step 4: `code-rationale.md` へのリンクが切れていないことを確認する**

```bash
grep -rhoE 'code-rationale\.md#[a-z0-9-]+' src src-tauri/src | sort -u
grep -oE '^## [^ ]+' docs/code-rationale.md
```
コードが参照するアンカーが、`code-rationale.md` の見出しから生成されるアンカーと一致することを目視で確認する。

- [ ] **Step 5: 直した場合のみコミット**

```bash
git add -A src src-tauri/src docs
git commit -m "fix(comments): resolve dangling label references"
```

何も直さなかった場合はコミット不要。

---

## Task 9: Phase 3 — TypeScript テストの DEL 適用

**Files（すべて Modify）:**

| ファイル | コメント/総行 |
|---|---|
| `src/store/__tests__/index.test.ts` | 113/2001 |
| `src/components/__tests__/ImageViewer.test.tsx` | 109/1560 |
| `src/hooks/__tests__/useImagePreloader.test.ts` | 68/640 |
| `src/hooks/__tests__/useThumbnailGenerator.test.ts` | 49/796 |
| `src/utils/testHooks.ts` | 21/89 |
| `src/utils/testUtils.tsx` | 17/270 |
| `src/components/__tests__/ThumbnailBar.test.tsx` | 13/386 |
| `src/components/__tests__/AboutDialog.test.tsx` | 10/215 |
| `src/hooks/__tests__/useKeyboard.test.ts` | 7/314 |
| `src/__tests__/setup.ts` | 5/53 |
| `src/utils/__tests__/previewBox.test.ts` | 5/80 |
| `src/components/__tests__/FileOpenButton.test.tsx` | 3/63 |
| `src/utils/__tests__/bitmapLoader.test.ts` | 2/205 |
| `src/utils/__tests__/bitmapCache.test.ts` | 1/200 |

**Interfaces:**
- Consumes: Task 1 の `npm run verify:comments`
- Produces: なし

- [ ] **Step 1: DEL3 を適用する**

`// Set an error first`、`// Setting new image should clear error`、`// Reset store to initial state before each test`、`// Set current image` のような手続き実況を削除する。**テスト名がその意図を語っている場合に限る**。テスト名が `it("clears the error when a new image is set")` なら `// Setting new image should clear error` は冗長なので消す。テスト名が曖昧で、コメントが唯一の説明になっている場合は残すか、テスト名を直すのではなくコメントを残す（テスト名の変更はコード変更にあたり、このタスクの範囲外）。

- [ ] **Step 2: テスト特有の KEEP を残す**

以下は残す。
- `src/store/__tests__/index.test.ts:8` の `// jsdom has no ImageBitmap; the bitmap cache only touches width/height/close.`（KEEP3）
- `src/store/__tests__/index.test.ts:22-23` のファクトリ再利用の理由（KEEP1）
- `src/hooks/__tests__/useImagePreloader.test.ts:256` の「プロトコルに自己修復させると二重デコードになる」（KEEP1）
- `(I3)` を参照している行（KEEP5）
- モックの形状がなぜそうなっているかを説明する行（KEEP3）

- [ ] **Step 3: 検証する**

Run: `npm run verify:comments -- <BASE>`（`<BASE>` は Task 8 時点の HEAD）
Expected: exit 0（対象は最大 14 file。テスト名が意図を語らずコメントを残したファイルは変更されない）

- [ ] **Step 4: テストを通す**

```bash
npm test
npm run type-check:test
npm run lint
npm run format
```
Expected: すべて green。テスト件数が変更前と同じであること（コメント削除でテストが消えていないこと）

- [ ] **Step 5: コミット**

```bash
git add src
git commit -m "refactor(comments): drop procedural comments from TypeScript tests"
```

---

## Task 10: Phase 3 — Rust テストの DEL 適用

**Files（すべて Modify、`#[cfg(test)]` 以降の領域および `test_utils.rs` 全体）:**

| ファイル | `#[cfg(test)]` 開始行 |
|---|---|
| `src-tauri/src/test_utils.rs` | ファイル全体（20/170） |
| `src-tauri/src/commands/file.rs` | 416 以降 |
| `src-tauri/src/commands/cache.rs` | 472 以降 |
| `src-tauri/src/commands/explorer_sort.rs` | 325 以降 |
| `src-tauri/src/protocol.rs` | 152 以降 |
| `src-tauri/src/utils/preview.rs` | 290 以降 |
| `src-tauri/src/utils/natural_sort.rs` | 72 以降 |
| `src-tauri/src/utils/image.rs` | 31 以降 |
| `src-tauri/src/utils/perf.rs` | 50 以降 |
| `src-tauri/src/lib.rs` | 5 以降 |

**Interfaces:**
- Consumes: Task 1 の `npm run verify:comments`
- Produces: なし

- [ ] **Step 1: DEL3 を適用する**

テスト関数名が意図を語っている場合の手続き実況を削除する。`file.rs:800` の `assert_eq!(images.len(), 2); // Only valid images` と `:937` の `// Directory should not be valid` は行末コメントなので、削除すると exit 2 になる。削除自体は妥当なので実行し、Step 3 で目視確認する。

- [ ] **Step 2: test_utils.rs の KEEP を残す**

`test_utils.rs:122-124` の `// byte order + magic 42`、`// IFD0 offset`、`// one entry` は TIFF/EXIF のバイト列を組み立てている箇所で、数値の意味を説明している（KEEP3）。これらは残す。

- [ ] **Step 3: 検証する**

Run: `npm run verify:comments -- <BASE>`（`<BASE>` は Task 9 のコミット）
Expected: exit 0、または exit 2（`file.rs:800` / `:937` の行末コメント削除が報告される。目視して受理する）

- [ ] **Step 4: Rust のテストを通す**

```bash
cd src-tauri && cargo test --lib && cd ..
```
Expected: 全件 pass、テスト件数が変更前と同じ

- [ ] **Step 5: コミット**

```bash
git add src-tauri/src
git commit -m "refactor(comments): drop procedural comments from Rust tests"
```

---

## Task 11: PR1 を作成する

**Files:**
- Modify: なし

**Interfaces:**
- Consumes: Task 1〜10 のコミット
- Produces: PR1。Task 12 はこの PR がマージされた main を基点にする。

- [ ] **Step 1: 全体を通しで検証する**

```bash
npm run verify:comments -- main
npm run verify:comments:test
npm test
cd src-tauri && cargo test --lib && cd ..
npm run type-check
npm run type-check:test
npm run lint
npm run format
```
Expected: `verify:comments` は exit 0 または目視確認済みの exit 2。他はすべて green。

- [ ] **Step 2: 削減量を記録する**

```bash
echo "TS comments : $(find src -type f \( -name '*.ts' -o -name '*.tsx' \) -exec grep -hE '^\s*(//|/\*|\*)' {} \; | wc -l)  (before: 1051)"
echo "Rust comments: $(find src-tauri/src -name '*.rs' -exec grep -hE '^\s*(//|/\*|\*)' {} \; | wc -l)  (before: 435)"
```
この 2 行を PR 本文に載せる。

- [ ] **Step 3: push して PR を作る**

**この環境では `origin` が `git@github.com:` の SSH URL で、`git fetch` / `git push` が `Please make sure you have the correct access rights` で失敗する。** gh の credential helper 経由の HTTPS で行う。

```bash
gh auth setup-git
git push -u https://github.com/hiz8/spica-photo-viewer.git chore/comment-cleanup
gh pr create --head chore/comment-cleanup --base main \
  --title "refactor(comments): 全体のコメント整理と簡素化（Phase 0-3）"
```

`gh pr create` は `--head` が必須（省略すると現在のブランチを検出できずに失敗する）。

PR 本文には以下を含める。
- Phase 0〜3 の内容と、Phase 4（ヘルパ抽出）が別 PR であること
- `npm run verify:comments -- main` が通っており、**ロジックは 1 行も変わっていない**こと。TS/TSX は esbuild でコメント除去後のコード一致を機械確認したこと。Rust は行検査であり TS より弱いこと
- exit 2 で目視確認した行末コメント行の一覧（あれば）
- Step 2 の削減量
- 新規 `docs/code-rationale.md` と、孤児ラベルが 0 件になったこと（Task 8 の検査結果）

---

## Task 12: Phase 4 — ImageViewer.tsx のヘルパ抽出（別 PR）

**Files:**
- Modify: `src/components/ImageViewer.tsx`
- Test: `src/components/__tests__/ImageViewer.test.tsx`（既存テストが回帰検出を担う。新規テストは追加しない）

**Interfaces:**
- Consumes: PR1 がマージされた main
- Produces: なし

**このタスクだけロジックに触れる。** `npm run verify:comments` は適用しない（N4）。

- [ ] **Step 1: PR1 マージ後の main から新しいブランチを切る**

SSH の `git fetch origin` は失敗するので HTTPS で取得する。

```bash
cd ../../..                          # メインの作業ディレクトリへ
git fetch https://github.com/hiz8/spica-photo-viewer.git main:refs/remotes/origin/main
git rev-parse --short HEAD refs/heads/main refs/remotes/origin/main
```

3 つの ref を個別に比較し、GitHub 側と一致しているもの（ローカル `main` が古いこともある）を基点にする。

```bash
git worktree add .claude/worktrees/image-viewer-helpers -b refactor/image-viewer-helpers refs/remotes/origin/main
```

以降はこの新しい worktree で作業する。`npm install` を実行する。

- [ ] **Step 2: 抽出前のベンチを取る**

```bash
npm run bench:corpus   # 未生成の場合のみ
npm run bench:build
npm run bench
```

`bench-results/` の最新 JSON を控える。`bench:build` は release ビルドを伴い時間がかかるので background で実行する。

- [ ] **Step 3: 手続きコメントの区間をヘルパに抽出する**

`ImageViewer.tsx` の `// Mark this path as actively loading` / `// Check if this image has saved view state` / `// Load full resolution directly` / `// Update with full resolution` / `// Add to preload cache` / `// Clear thumbnail flag` が並ぶ区間を、名前付きのローカル関数に切り出す。関数名がコメントの内容を担うので、抽出後にこれらのコメントを削除する。

**振る舞いは変えない。** 実行順序、依存配列、abort 判定、tier の設定は 1 つも変えない。抽出は純粋に「連続した文をローカル関数にまとめて呼ぶ」だけにとどめる。

- [ ] **Step 4: テストを通す**

```bash
npm test
npm run type-check
npm run lint
npm run format
```
Expected: すべて green。`src/components/__tests__/ImageViewer.test.tsx` の 109 件のコメントが示す既存の振る舞いが維持されていること

- [ ] **Step 5: ベンチを取り直して回帰していないことを確認する**

```bash
npm run bench:build
npm run bench
```

`bench-results/baseline.json` と比較し、以下を確認する。**性能改善が目的ではないので 10% 改善は要求しない。**
- NAV_visible 中央値が p95 の揺れを超えて悪化していない（n = 84、hit_rate = 1.0）
- PLACEHOLDER_dur_visible p95 が悪化していない
- NAV_rapid 中央値が悪化していない（n = 84）

いずれかの `n` が `runs` を下回った run は無効なので取り直す。悪化していれば `git revert` してこのタスクを破棄する（PR1 の成果は残る）。

- [ ] **Step 6: e2e を通す**

```bash
npm run test:e2e
npm run test:e2e
```
Expected: 2 回連続で green（`bench:build` 直後の初回は timing flake が既知のため 1 回では判定しない）

- [ ] **Step 7: コミットして PR を作る**

```bash
git add src/components/ImageViewer.tsx
git commit -m "refactor(viewer): extract named helpers from the image load effect"
git push -u https://github.com/hiz8/spica-photo-viewer.git refactor/image-viewer-helpers
gh pr create --head refactor/image-viewer-helpers --base main \
  --title "refactor(viewer): ImageViewer の読み込み処理を名前付きヘルパに抽出"
```

PR 本文にベンチの数値（NAV_visible 中央値、PLACEHOLDER_dur_visible p95、NAV_rapid 中央値の before/after）を載せる。`baseline.json` は更新しない（性能改善を採用したわけではないため）。

---

## 完了条件

- [ ] PR1（Task 1〜11）がマージされている
- [ ] PR2（Task 12）がマージされている、または回帰を理由に破棄されたことが記録されている
- [ ] `comm` によるラベル検査で孤児が 0 件
- [ ] `CLAUDE.md` に `## Comments` 節がある
- [ ] `docs/code-rationale.md` が存在し、コードから参照されている
