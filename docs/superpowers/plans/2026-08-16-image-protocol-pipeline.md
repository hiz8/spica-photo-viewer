# Image Protocol Pipeline (base64 IPC 撤廃) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PERFORMANCE_AUTONOMY_PLAN.md の Phase 4（profiling 確定）→ Phase 5 第一候補「base64 over IPC の撤廃」→ Phase 6 採否ゲートを 1 仮説として実行し、TTFI_cold（baseline 1771ms）を改善する。

**Architecture:** 現行の「Rust でフルデコード→再エンコード→base64→JSON IPC→data URL」を、独自 URI スキーム `spica-img`（`register_asynchronous_uri_scheme_protocol`、拡張子検証付き）で原本バイトを直接 WebView に配信する方式へ置換する。寸法は `Image.decode()` 後の `naturalWidth/Height`（ブラウザ由来）を使い、ホットパスから IPC を完全に排除。preload はデコード済み `HTMLImageElement` の保持に変わる。移行は「型を src ベースに変える（挙動不変）」→「ローダを差し替える」の 2 段階で行い、各段階でツリーを green に保つ。

**Tech Stack:** Tauri v2 custom URI scheme protocol（Rust: `percent-encoding` crate 追加）、ブラウザ `Image.decode()`、既存の bench ハーネス（WebdriverIO + `@wdio/tauri-service`）。

**Spec:** `docs/PERFORMANCE_AUTONOMY_PLAN.md`（Phase 4〜6、§2 指標定義、§7 リスク）。運用ゲートは `CLAUDE.md` の「Performance changes」節。

## 前提条件（実行開始前に確認）

- **PR #266（計測ハーネス）が main にマージ済みであること。** 未マージの場合は `worktree-perf-measurement-harness` ブランチの HEAD から積む（stacked branch）。ハーネス（`npm run bench` / `bench:build` / `bench:corpus` / `test:e2e`、`bench-results/baseline.json`）が存在しない状態でこのプランを開始してはならない。
- baseline（`bench-results/baseline.json`, gitSha 08caaee, TTFI_cold median 1771.4ms / NAV_warm 162.0ms / NAV_cold 515.6ms / ipc_cold 1266.5ms / decode_cold 266.3ms、全て n=7）は同一マシンで計測済み。ゲート比較も同一マシンで行うこと。
- この plan ファイル自体は未追跡である。Task 1 の最初のコミットに含めて永続化すること（前プランでスペック文書が未追跡のまま消失した事故の再発防止）。

## Global Constraints

- 対象プラットフォームは **Windows のみ**（URL 形式は `http://spica-img.localhost/...` 固定でよい）。
- **採否ゲート（CLAUDE.md「Performance changes」より逐語）**: 対象指標の中央値が baseline 比 **10% 以上改善** / 他の指標が p95 の揺れを超えて悪化していない / `npm test` と `cd src-tauri && cargo test --lib` が全件 green / `npm run test:e2e`（視覚ゲート含む）が green — をすべて満たす場合のみ採用。満たさなければ revert（本プランでは「ブランチを破棄し main に戻す」がそれに相当）。
- **本プランの対象指標は TTFI_cold**（P1）。NAV_warm / NAV_cold は回帰ゲート側（悪化不可）。
- **1 コミット 1 仮説の解釈**: 本ブランチ全体が 1 仮説（base64 IPC 撤廃）。ゲートはブランチ HEAD で判定する。表示解像度デコード等の別仮説をこのブランチに混ぜない。
- **計測契約を壊さない**: mark `open:request` / `paint:done`(detail.thumbnail) / event `preload`(detail.hit) / `preload:done`、`window.__SPICA_TEST__` の 6 メソッド、gated 3 指標（TTFI_cold / NAV_warm / NAV_cold = open:request→paint:done ペアリング）は名前・意味とも不変。`ipc:sent`/`ipc:received` は撤廃され、`src:set` が新設される（Task 4/6 で docs も更新）。
- 計測は必ず release ビルド（`npm run bench:build` 後に `npm run bench`）。N=7、p95 は参考値（median 主判定）。
- Zustand ストアは `.claude/rules/zustand-store.md` に従う（イミュータブル更新、アクション変更時は testUtils/テスト更新）。
- lint/format は hook に任せる（手動で `lint:fix` / `format:fix` を回す手順を入れない）。
- 各コミット前に `npm test`・`cd src-tauri && cargo test --lib` が green。
- `import.meta.env` 系の perf ゲート（`VITE_PERF_LOG`）と Rust の `SPICA_PERF` ゲートの仕組みは変更しない。

## ファイル構成（このプランで確定する分割）

| ファイル | 責務 |
|---|---|
| Create: `e2e/scripts/profile-rust.mjs` | Phase 4: release exe を SPICA_PERF=1 で起動し Rust 側内訳（decode/encode/base64/load_image）を集計表示 |
| Create: `src-tauri/src/protocol.rs` | URI パス→検証済み PathBuf 解決・mime 判定・エラーレスポンス（純関数、単体テスト対象） |
| Modify: `src-tauri/src/lib.rs` | `spica-img` 非同期プロトコルハンドラ登録 |
| Create: `src/utils/imageSrc.ts` | パス→`spica-img` URL、パス→format 文字列（純関数、単体テスト対象） |
| Create: `src/utils/protocolLoader.ts` | URL 設定→`Image.decode()`→ImageData+element 返却（ImageViewer/preloader 共用、単体テストでは vi.mock される境界） |
| Create: `src/utils/imageData.ts`（Task 3 で新設、Task 4 で削除） | 旧 IPC 応答→src ベース ImageData 変換（移行期のみ） |
| Modify: `src/types/index.ts` | `ImageData.base64: string` → `ImageData.src: string` |
| Modify: `src/store/index.ts` / `src/components/ImageViewer.tsx` / `src/hooks/useImagePreloader.ts` | src ベース化・ローダ差し替え・preload の element 保持 |
| Modify: `e2e/specs/smoke.e2e.ts` / `e2e/specs/visual.e2e.ts` / `e2e/lib/bench-helpers.ts` / `e2e/specs/bench.perf.ts` / `e2e/scripts/generate-corpus.mjs` | プロトコル配信テスト・mark 変更追随・EXIF 検証・breakdown 差し替え |
| Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md` / `CLAUDE.md`(なし) / `PROJECT_SPEC.md` | Phase 4 記録・§2/§4/§8 更新・既知の制限の更新 |

---

### Task 1: プランのコミットと Phase 4 プロファイリング（原因確定）

**Files:**
- Create: `docs/superpowers/plans/2026-08-16-image-protocol-pipeline.md`（このファイル。未追跡→コミット）
- Create: `e2e/scripts/profile-rust.mjs`
- Modify: `package.json`（scripts に `profile:rust`）
- Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md`（Phase 4 チェックボックスと実測記録）

**Interfaces:**
- Consumes: `src-tauri/target/release/spica-photo-viewer.exe`（`npm run bench:build` の成果物）、`e2e/fixtures/corpus/large/`（`npm run bench:corpus`）、Rust の `SPICA_PERF=1` JSON 行ログ（op: `load_image`/`decode`/`encode`/`base64`）
- Produces: Phase 4 の完了（支配区間の文書化）。以降のタスクはこの結論（IPC 経路支配）を前提とする

- [ ] **Step 1: プロファイリングスクリプトを書く**

`e2e/scripts/profile-rust.mjs`:

```javascript
// Phase 4 profiling: launch the release exe with SPICA_PERF=1 and a large
// corpus image as the startup file (App.tsx auto-opens it), capture the
// Rust perf JSON lines from stderr, and print per-op medians.
// The wdio service cannot capture app stderr (known limitation), so this
// script spawns the exe directly with a pipe.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const exe = join(here, "../../src-tauri/target/release/spica-photo-viewer.exe");
const largeDir = join(here, "../fixtures/corpus/large");

if (!existsSync(exe)) throw new Error(`release binary missing: ${exe} — run: npm run bench:build`);
if (!existsSync(largeDir)) throw new Error(`corpus missing: ${largeDir} — run: npm run bench:corpus`);

const image = join(
  largeDir,
  readdirSync(largeDir).filter((f) => f.endsWith(".jpg")).sort()[0],
);

const CAPTURE_MS = 15000;
console.log(`profiling ${exe}\n  image: ${image}\n  capturing stderr for ${CAPTURE_MS}ms...`);

const child = spawn(exe, [image], { env: { ...process.env, SPICA_PERF: "1" } });
const samples = [];
let buffer = "";
child.stderr.on("data", (chunk) => {
  buffer += chunk.toString();
  let idx = buffer.indexOf("\n");
  while (idx >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.startsWith('{"perf"')) {
      try {
        samples.push(JSON.parse(line));
      } catch {
        console.warn(`torn perf line skipped: ${line.slice(0, 60)}`);
      }
    }
    idx = buffer.indexOf("\n");
  }
});

setTimeout(() => {
  child.kill();
  const byOp = new Map();
  for (const s of samples) {
    if (!byOp.has(s.op)) byOp.set(s.op, []);
    byOp.get(s.op).push(s.ms);
  }
  console.log(`\ncaptured ${samples.length} samples:`);
  for (const [op, list] of byOp) {
    const sorted = [...list].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(
      `  ${op.padEnd(12)} n=${String(list.length).padStart(3)} median=${median.toFixed(1)}ms max=${Math.max(...list).toFixed(1)}ms`,
    );
  }
  if (samples.length === 0) {
    console.error("no perf samples captured — did the app open the image?");
    process.exitCode = 1;
  }
}, CAPTURE_MS);
```

`package.json` の scripts に追加（`bench:corpus` の隣）:

```jsonc
"profile:rust": "node e2e/scripts/profile-rust.mjs"
```

- [ ] **Step 2: 実行して支配区間を確認**

Run: `npm run bench:build`（バイナリが古い場合）→ `npm run profile:rust`
Expected: `decode` / `encode` / `base64` / `load_image` の median が表示される（起動時に開く 1 枚 + preload される近傍画像のサンプルが乗る）。20MP JPEG では `decode`+`encode` が `load_image` の大半を占めるはず。

- [ ] **Step 3: Phase 4 の結論をスペックに記録**

`docs/PERFORMANCE_AUTONOMY_PLAN.md` の Phase 4 セクションで:
- 3 つのチェックボックスを `[x]` にする
- セクション末尾（`---` の前）に実測を追記:

```markdown
**Phase 4 実測記録（2026-08-16, gitSha <このコミットの直前の HEAD>）**:
- フロント内訳（baseline より）: TTFI_cold median 1771ms のうち ipc（ipc:sent→ipc:received）1266ms / decode（ブラウザ）266ms — IPC 経路が 71% を占め支配的
- Rust 内訳（`npm run profile:rust`, large 20MP JPEG）: decode=<実測>ms / encode=<実測>ms / base64=<実測>ms / load_image 合計=<実測>ms
- 結論: 支配区間は「Rust フルデコード→再エンコード→base64→JSON IPC→data URL パース」の転送パイプライン全体。Phase 5 は候補 1（base64 over IPC の撤廃）に着手する
```

`<実測>` はすべて Step 2 の実出力の数値で置換すること（プレースホルダを残したままコミットしない）。

- [ ] **Step 4: 全テスト確認と Commit**

Run: `npm test`（246 green）/ `cd src-tauri && cargo test --lib`（64 green）

```bash
git add docs/superpowers/plans/2026-08-16-image-protocol-pipeline.md e2e/scripts/profile-rust.mjs package.json docs/PERFORMANCE_AUTONOMY_PLAN.md
git commit -m "feat(perf): add rust-side profiler and record phase 4 findings"
```

---

### Task 2: Rust `spica-img` プロトコルと frontend URL ビルダ

**Files:**
- Create: `src-tauri/src/protocol.rs`
- Modify: `src-tauri/src/lib.rs`（`mod protocol;` とハンドラ登録）
- Modify: `src-tauri/Cargo.toml`（`percent-encoding = "2"` 追加）
- Create: `src/utils/imageSrc.ts`
- Test: `src/utils/__tests__/imageSrc.test.ts`、`protocol.rs` 内 `#[cfg(test)]`
- Modify: `e2e/specs/smoke.e2e.ts`（プロトコル配信の実機テスト追加）

**Interfaces:**
- Consumes: `crate::utils::image::is_supported_image`、`crate::utils::perf::PerfTimer`、既存 smoke の一時 PNG 生成パターン
- Produces:
  - Rust: `protocol::resolve_image_path(uri_path: &str) -> Result<PathBuf, String>`、`protocol::mime_for(path: &Path) -> &'static str`、`protocol::error_response(status: u16, msg: &str) -> tauri::http::Response<Vec<u8>>`、URI スキーム `spica-img`（GET `http://spica-img.localhost/<encodeURIComponent(絶対パス)>` → 200 + 画像バイト / 404）
  - TS: `imageSrc(path: string): string`、`imageFormat(path: string): string`（拡張子小文字、無ければ `"unknown"`）

**実装前の API 確認（必須）**: Tauri 2.11 の `Builder::register_asynchronous_uri_scheme_protocol` の正確なシグネチャ（ctx/request/responder の型、`tauri::http::Response` の組み立て方）を context7 か https://docs.rs/tauri/2/ で確認し、以下のコードを現物に合わせて調整すること（調整はレポートに記録）。

- [ ] **Step 1: Rust 側の失敗するテストを書く**

`src-tauri/src/protocol.rs` を作成し、まずテストから（実装は未定義のままで良い）:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::*;
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

    fn encode(path: &std::path::Path) -> String {
        // encodeURIComponent 相当（英数字以外すべてエンコード）
        format!("/{}", utf8_percent_encode(&path.to_string_lossy(), NON_ALPHANUMERIC))
    }

    #[test]
    fn test_resolve_roundtrips_windows_path_with_spaces_and_japanese() {
        let temp_dir = create_temp_dir();
        let img = create_test_jpeg(temp_dir.path(), "テスト 画像 (1).jpg");
        let resolved = resolve_image_path(&encode(&img)).unwrap();
        assert_eq!(resolved, img);
    }

    #[test]
    fn test_resolve_rejects_unsupported_extension() {
        let temp_dir = create_temp_dir();
        let txt = temp_dir.path().join("note.txt");
        std::fs::write(&txt, "x").unwrap();
        let err = resolve_image_path(&encode(&txt)).unwrap_err();
        assert!(err.contains("unsupported"));
    }

    #[test]
    fn test_resolve_rejects_missing_file() {
        let err = resolve_image_path("/C%3A%5Cnope%5Cmissing.jpg").unwrap_err();
        assert!(err.contains("not found"));
    }

    #[test]
    fn test_mime_for_known_formats() {
        use std::path::Path;
        assert_eq!(mime_for(Path::new("a.jpg")), "image/jpeg");
        assert_eq!(mime_for(Path::new("a.JPEG")), "image/jpeg");
        assert_eq!(mime_for(Path::new("a.png")), "image/png");
        assert_eq!(mime_for(Path::new("a.webp")), "image/webp");
        assert_eq!(mime_for(Path::new("a.gif")), "image/gif");
    }
}
```

`percent-encoding` は dev だけでなく本体依存（ハンドラで decode に使う）: `src-tauri/Cargo.toml` の `[dependencies]` に `percent-encoding = "2"` を追加。`src-tauri/src/lib.rs` 冒頭に `mod protocol;` を追加。

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd src-tauri && cargo test --lib protocol`
Expected: コンパイルエラー（`resolve_image_path` 未定義）

- [ ] **Step 3: 実装**

`src-tauri/src/protocol.rs` 本体:

```rust
//! Custom `spica-img` URI scheme.
//! Serves validated local image files to the WebView as raw bytes,
//! replacing the decode→re-encode→base64→IPC pipeline. Windows WebView2
//! exposes the scheme as http://spica-img.localhost/<percent-encoded path>.

use crate::utils::image::is_supported_image;
use percent_encoding::percent_decode_str;
use std::path::{Path, PathBuf};

pub fn resolve_image_path(uri_path: &str) -> Result<PathBuf, String> {
    let trimmed = uri_path.trim_start_matches('/');
    let decoded = percent_decode_str(trimmed)
        .decode_utf8()
        .map_err(|e| format!("invalid encoding: {}", e))?;
    let path = PathBuf::from(decoded.as_ref());
    if !is_supported_image(&path) {
        return Err("unsupported file type".to_string());
    }
    if !path.is_file() {
        return Err("file not found".to_string());
    }
    Ok(path)
}

pub fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    }
}

pub fn error_response(status: u16, msg: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain")
        .body(msg.as_bytes().to_vec())
        .expect("static error response must build")
}
```

`src-tauri/src/lib.rs` の `run()` 内、`.plugin(tauri_plugin_dialog::init())` の直後（`#[cfg(feature = "e2e")]` ブロックの前）にハンドラを登録:

```rust
let builder = builder.register_asynchronous_uri_scheme_protocol("spica-img", |_ctx, request, responder| {
    let uri_path = request.uri().path().to_string();
    // File reads are blocking; keep them off the async runtime's core threads.
    tauri::async_runtime::spawn_blocking(move || {
        let _t = crate::utils::perf::PerfTimer::start("serve", &uri_path);
        let response = match crate::protocol::resolve_image_path(&uri_path) {
            Ok(path) => match std::fs::read(&path) {
                Ok(bytes) => tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", crate::protocol::mime_for(&path))
                    .body(bytes)
                    .unwrap_or_else(|_| {
                        crate::protocol::error_response(500, "response build failed")
                    }),
                Err(e) => crate::protocol::error_response(500, &e.to_string()),
            },
            Err(msg) => crate::protocol::error_response(404, &msg),
        };
        responder.respond(response);
    });
});
```

- [ ] **Step 4: Rust テストが通ることを確認**

Run: `cd src-tauri && cargo test --lib protocol` → PASS（4 tests）
Run: `cd src-tauri && cargo test --lib` → 全件 PASS / `cargo check` も通ること

- [ ] **Step 5: frontend URL ビルダの失敗するテストを書く**

`src/utils/__tests__/imageSrc.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { imageFormat, imageSrc } from "../imageSrc";

describe("imageSrc", () => {
  it("builds a spica-img URL with the path fully encoded", () => {
    const url = imageSrc("C:\\photos\\テスト 画像.jpg");
    expect(url.startsWith("http://spica-img.localhost/")).toBe(true);
    expect(url).not.toContain("\\");
    expect(url).not.toContain(" ");
    expect(decodeURIComponent(url.slice("http://spica-img.localhost/".length))).toBe(
      "C:\\photos\\テスト 画像.jpg",
    );
  });

  it("imageFormat returns the lowercase extension", () => {
    expect(imageFormat("C:\\a\\b.JPG")).toBe("jpg");
    expect(imageFormat("C:\\a\\b.jpeg")).toBe("jpeg");
    expect(imageFormat("C:\\a\\noext")).toBe("unknown");
  });
});
```

Run: `npx vitest --run src/utils/__tests__/imageSrc.test.ts` → FAIL（モジュール未作成）

- [ ] **Step 6: 実装**

`src/utils/imageSrc.ts`:

```typescript
/**
 * URL builder for the custom `spica-img` protocol (Windows/WebView2 form).
 * The Rust handler validates the extension and existence before serving.
 */
export const IMAGE_PROTOCOL_ORIGIN = "http://spica-img.localhost";

export const imageSrc = (path: string): string =>
  `${IMAGE_PROTOCOL_ORIGIN}/${encodeURIComponent(path)}`;

export const imageFormat = (path: string): string => {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "unknown";
  return name.slice(dot + 1).toLowerCase();
};
```

Run: `npx vitest --run src/utils/__tests__/imageSrc.test.ts` → PASS

- [ ] **Step 7: 実機（release WebView2）でプロトコル配信を検証する smoke テストを追加**

`e2e/specs/smoke.e2e.ts` に 3 本目のテストを追加（既存の一時 PNG 生成を再利用。URL 構築は spec 内にインライン — e2e は src/ を import しない方針）:

```typescript
it("serves image bytes over the spica-img protocol", async () => {
  // tempPngPath: 既存テストが e2e/.tmp/ に生成している 1x1 PNG のパスを再利用する
  const src = `http://spica-img.localhost/${encodeURIComponent(tempPngPath)}`;
  const result = await browser.executeAsync(
    (url: string, done: (r: { ok: boolean; status: number; size: number; type: string }) => void) => {
      fetch(url)
        .then((r) => r.blob().then((b) => done({ ok: r.ok, status: r.status, size: b.size, type: b.type })))
        .catch(() => done({ ok: false, status: -1, size: 0, type: "fetch-error" }));
    },
    src,
  );
  expect(result.ok).toBe(true);
  expect(result.status).toBe(200);
  expect(result.size).toBeGreaterThan(0);
  expect(result.type).toBe("image/png");

  const missing = await browser.executeAsync(
    (url: string, done: (status: number) => void) => {
      fetch(url).then((r) => done(r.status)).catch(() => done(-1));
    },
    `http://spica-img.localhost/${encodeURIComponent("C:\\nope\\missing.jpg")}`,
  );
  expect(missing).toBe(404);
});
```

（既存 smoke の一時 PNG 変数がテストローカルなら、describe スコープへ引き上げて共有する。）

- [ ] **Step 8: ビルドして smoke を実行**

Run: `npm run bench:build` → `npm run test:e2e`
Expected: smoke 3 本 + visual 2 本 = 5 passing。プロトコル経由で 200/image/png と 404 が返ることが実機で確認される。

- [ ] **Step 9: 全テスト確認と Commit**

Run: `npm test` / `cd src-tauri && cargo test --lib` → green

```bash
git add src-tauri/src/protocol.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock src/utils/imageSrc.ts src/utils/__tests__/imageSrc.test.ts e2e/specs/smoke.e2e.ts
git commit -m "feat(perf): add spica-img protocol serving validated image bytes"
```

---

### Task 3: ImageData を src ベースへ移行（挙動不変のリファクタ）

**Files:**
- Modify: `src/types/index.ts`（`ImageData.base64` → `ImageData.src`）
- Create: `src/utils/imageData.ts`（移行期の変換ヘルパ。Task 4 で削除される）
- Modify: `src/store/index.ts`（`thumbnailToImageData`）
- Modify: `src/components/ImageViewer.tsx`（`invokeLoadImage` 内で変換、`<img src>`）
- Modify: `src/hooks/useImagePreloader.ts`（invoke 受信箇所とエラーエントリ）
- Modify: `src/utils/testFactories.ts`・既存テスト（`base64` フィールド参照を全て `src` へ）
- Test: `src/utils/__tests__/imageData.test.ts`

**Interfaces:**
- Consumes: 既存 IPC 応答 `RawImageData { path; base64; width; height; format }`（Rust `load_image` の返り値、この時点では現役）
- Produces: `ImageData { path: string; src: string; width: number; height: number; format: string }`（以降の全タスクの前提型）、`rawToImageData(raw: RawImageData): ImageData`、`thumbnailToImageData` は `src: "data:jpeg;base64,..."` を返す

このタスクの終了時点で**表示挙動は完全に不変**（src には従来と同一の data URL 文字列が入る）。差分は型と参照フィールド名のみ。

- [ ] **Step 1: 変換ヘルパの失敗するテストを書く**

`src/utils/__tests__/imageData.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { rawToImageData } from "../imageData";

describe("rawToImageData", () => {
  it("converts an IPC payload to a data-URL ImageData preserving the current format string", () => {
    const result = rawToImageData({
      path: "C:\\p\\a.jpg",
      base64: "QUJD",
      width: 100,
      height: 50,
      format: "jpg",
    });
    // NOTE: `data:jpg;...` は厳密な MIME ではないが、現行実装と同一文字列を
    // 意図的に維持する（このタスクは挙動不変が要件。Task 4 でパイプラインごと消える）
    expect(result).toEqual({
      path: "C:\\p\\a.jpg",
      src: "data:jpg;base64,QUJD",
      width: 100,
      height: 50,
      format: "jpg",
    });
  });
});
```

Run: `npx vitest --run src/utils/__tests__/imageData.test.ts` → FAIL

- [ ] **Step 2: 型とヘルパを実装**

`src/types/index.ts`: `ImageData` を以下に変更（他の型は不変）:

```typescript
export interface ImageData {
  path: string;
  /** Renderable URL: a data: URL (thumbnails / legacy pipeline) or a spica-img protocol URL */
  src: string;
  width: number;
  height: number;
  format: string;
}
```

`src/utils/imageData.ts`:

```typescript
import type { ImageData } from "../types";

/** Shape returned by the Rust `load_image` command (transitional; removed with it). */
export interface RawImageData {
  path: string;
  base64: string;
  width: number;
  height: number;
  format: string;
}

export const rawToImageData = (raw: RawImageData): ImageData => ({
  path: raw.path,
  src: `data:${raw.format};base64,${raw.base64}`,
  width: raw.width,
  height: raw.height,
  format: raw.format,
});
```

- [ ] **Step 3: 参照箇所を一括更新**

`git grep -n "base64" -- src/` で ImageData 経由の参照を洗い出し、以下を適用（`cache.thumbnails` の `{ base64, width, height }` は**別の型**なので変更しない）:

1. `src/store/index.ts` `thumbnailToImageData`:

```typescript
export const thumbnailToImageData = (
  path: string,
  thumbnailCache: { base64: string; width: number; height: number },
): ImageData => ({
  path,
  src: `data:jpeg;base64,${thumbnailCache.base64}`,
  width: thumbnailCache.width,
  height: thumbnailCache.height,
  format: "jpeg",
});
```

2. `src/components/ImageViewer.tsx`:
   - `invokeLoadImage` を変換込みに: `const raw = await invoke<RawImageData>("load_image", { path }); ... return rawToImageData(raw);`（`perfMark("ipc:received")` は raw 受信直後のまま）。import に `rawToImageData` / `RawImageData` を追加、`AppImageData` の invoke 型引数を置換。
   - `<img src={...}>` を `src={currentImage.data.src}` に変更。
3. `src/hooks/useImagePreloader.ts`: invoke 受信を `rawToImageData` 経由に、エラーエントリを `{ path: imagePath, src: "", width: 0, height: 0, format: "error" }` に。
4. `src/utils/testFactories.ts` と全テスト: ImageData を作っている箇所の `base64: "..."` を `src: "data:jpeg;base64,..."` に（factory があれば factory だけ直せば済むはず）。store テストの `setPreloadedImage` 呼び出しも同様。

- [ ] **Step 4: 型チェックを通す（漏れ検出）**

Run: `npm run type-check`
Expected: エラーゼロ。エラーが出る箇所 = 更新漏れなので全て直す。

- [ ] **Step 5: 全テスト確認と Commit**

Run: `npx vitest --run src/utils/__tests__/imageData.test.ts` → PASS
Run: `npm test` → 全件 PASS（件数は +1）
Run: `cd src-tauri && cargo test --lib` → 64 green（Rust は未変更）

```bash
git add src/ 
git commit -m "refactor(perf): migrate ImageData from base64 field to renderable src URL"
```

---

### Task 4: ImageViewer のロードをプロトコル URL 化（仮説の本体・前半）

**Files:**
- Create: `src/utils/protocolLoader.ts`
- Modify: `src/components/ImageViewer.tsx`（`invokeLoadImage` 削除 → `loadImageViaProtocol`、4 呼び出し置換、`src:set` mark）
- Delete: `src/utils/imageData.ts` + `src/utils/__tests__/imageData.test.ts`（Task 5 で preloader も置換後に削除 — 本タスクでは preloader がまだ使うため**残す**。削除は Task 5 で）
- Modify: `src/components/__tests__/ImageViewer.test.tsx`（invoke モック依存のフローを protocolLoader モックへ）
- Modify: `e2e/specs/smoke.e2e.ts`（mark アサーション: `ipc:sent`/`ipc:received` → `src:set`）

**Interfaces:**
- Consumes: Task 2 の `imageSrc(path)` / `imageFormat(path)`、Task 3 の `ImageData`
- Produces: `loadImageViaProtocol(path: string): Promise<{ data: ImageData; element: HTMLImageElement }>`（`src/utils/protocolLoader.ts`。Task 5 の preloader も同関数を使う）。新 mark: `src:set`（detail `{ path }`、URL 設定・fetch 開始直前）。`ipc:sent`/`ipc:received` は ImageViewer から消える

- [ ] **Step 1: protocolLoader を実装（単体テストは境界のみ）**

`src/utils/protocolLoader.ts`:

```typescript
/**
 * Loads an image through the spica-img protocol with an off-DOM Image and
 * resolves after decode, so callers get dimensions (browser-derived, EXIF
 * orientation applied) and a warm decode cache before touching the DOM.
 * Network behavior is exercised by E2E (jsdom never loads resources);
 * unit tests mock this module at the import boundary.
 */
import type { ImageData } from "../types";
import { imageFormat, imageSrc } from "./imageSrc";
import { perfMark } from "./perf";

export const loadImageViaProtocol = async (
  path: string,
): Promise<{ data: ImageData; element: HTMLImageElement }> => {
  const src = imageSrc(path);
  perfMark("src:set", { path });
  const element = new Image();
  element.src = src;
  if (typeof element.decode === "function") {
    await element.decode();
  } else {
    await new Promise<void>((resolve, reject) => {
      element.onload = () => resolve();
      element.onerror = () => reject(new Error(`Failed to load image: ${path}`));
    });
  }
  return {
    data: {
      path,
      src,
      width: element.naturalWidth,
      height: element.naturalHeight,
      format: imageFormat(path),
    },
    element,
  };
};
```

（`element.decode()` の reject（破損ファイル・404）は呼び出し側の既存 catch 経路に乗る。）

- [ ] **Step 2: ImageViewer を差し替え**

`src/components/ImageViewer.tsx`:
- `invokeLoadImage` の useCallback を削除し、4 箇所の `await invokeLoadImage(path)` を全て `(await loadImageViaProtocol(path)).data` に置換（GIF 分岐も同じ呼び出し。URL 直接参照なのでアニメーションは DOM 側 `<img>` が再生する）。
- `loadImage` の useCallback 依存配列から `invokeLoadImage` を外す（`loadImageViaProtocol` はモジュール関数なので依存不要）。
- 不要になった import（`invoke`、`rawToImageData`）を整理（`invoke` は `resizeToImage` 等で store 側が使うのみ。ImageViewer 内に他の invoke が無ければ import 削除）。
- 既存の paint/decode 計測 effect と `open:request`/`preload` の店側 mark は**一切変更しない**。

- [ ] **Step 3: ImageViewer テストを protocolLoader モックへ書き換え**

`src/components/__tests__/ImageViewer.test.tsx` の、`invoke`（`load_image`）をモックしてロード完了を検証しているテストを次の方針で書き換える:

```typescript
vi.mock("../../utils/protocolLoader", () => ({
  loadImageViaProtocol: vi.fn(async (path: string) => ({
    data: {
      path,
      src: `http://spica-img.localhost/${encodeURIComponent(path)}`,
      width: 800,
      height: 600,
      format: "jpg",
    },
    element: new Image(),
  })),
}));
```

- ロード成功フロー: パス設定 → デバウンス経過 → `loadImageViaProtocol` が呼ばれ `<img>` の `src` が返却 URL になること
- 失敗フロー: モックを `vi.mocked(loadImageViaProtocol).mockRejectedValueOnce(new Error("boom"))` にし、エラーメッセージ表示を assert
- preload ヒット・サムネイル表示のフローは store 駆動のまま（protocolLoader は呼ばれないことを assert できるとなお良い）
既存アサーションの意図（loading 表示、fit 動作、abort）を消さないこと。`data:` URL 前提のアサーションは新 URL に合わせて更新。

- [ ] **Step 4: smoke の mark アサーションを更新**

`e2e/specs/smoke.e2e.ts` の計測検証テストで、期待 mark 集合を `open:request` / `src:set` / `paint:done` に変更（`ipc:sent`/`ipc:received` の assert を削除。`decode:done` の扱いは現状維持 = 未 assert）。

- [ ] **Step 5: ユニット確認 → 実機確認**

Run: `npm run type-check` → clean、`npm test` → 全件 PASS
Run: `npm run bench:build` → `npm run test:e2e` → smoke 3 + visual 2 = 5 passing（実機で: プロトコル経由の初回表示・ナビゲーション・視覚ゲートが全て通る = 「まず 1 枚表示できることを確認してから計測へ」という §7 の注意を満たす）

- [ ] **Step 6: Commit**

```bash
git add src/ e2e/specs/smoke.e2e.ts
git commit -m "feat(perf): load viewer images via spica-img protocol instead of base64 IPC"
```

---

### Task 5: preloader のプロトコル化とデコード済み要素の保持（仮説の本体・後半）

**Files:**
- Modify: `src/hooks/useImagePreloader.ts`
- Delete: `src/utils/imageData.ts`、`src/utils/__tests__/imageData.test.ts`（最後の利用者が消えるため）
- Modify: `src/hooks/__tests__/useImagePreloader.test.ts`

**Interfaces:**
- Consumes: Task 4 の `loadImageViaProtocol(path) -> Promise<{data, element}>`
- Produces: preload 完了時 `cache.preloaded` に src ベース ImageData（挙動契約は不変: `preload:done` event、エラー時 `format: "error"` エントリ）。モジュールスコープ `retainedImages: Map<string, HTMLImageElement>`（デコード済みビットマップをブラウザキャッシュに留めるための参照保持）

- [ ] **Step 1: preloader テストを書き換え（先に RED）**

`src/hooks/__tests__/useImagePreloader.test.ts` の invoke モックを protocolLoader モックへ:

```typescript
vi.mock("../../utils/protocolLoader", () => ({
  loadImageViaProtocol: vi.fn(async (path: string) => ({
    data: { path, src: `http://spica-img.localhost/x`, width: 10, height: 10, format: "jpg" },
    element: new Image(),
  })),
}));
```

- 成功時: `setPreloadedImage` に src ベースの ImageData が渡ること、`preload:done` event（既存 assert があれば維持）
- 失敗時（mockRejectedValueOnce）: `format: "error"`・`src: ""` のエラーエントリが入ること
- 同時実行制限・キュー順の既存テストの意図は維持

Run: `npx vitest --run src/hooks/__tests__/useImagePreloader.test.ts`
Expected: FAIL（hook がまだ invoke を使っている）

- [ ] **Step 2: 実装**

`src/hooks/useImagePreloader.ts`:
- `invoke` / `rawToImageData` の import を `loadImageViaProtocol` に置換。
- モジュールスコープ（コンポーネント外）に:

```typescript
// Holding the decoded elements keeps the encoded resources (and usually the
// decoded bitmaps) alive in the browser cache, so a preload-hit navigation
// repaints without refetching. Mirrors cache.preloaded: entries are dropped
// together in cleanupCache and cleared on folder change.
const retainedImages = new Map<string, HTMLImageElement>();
```

- `preloadImage` 内:

```typescript
const { data, element } = await loadImageViaProtocol(imagePath);
retainedImages.set(imagePath, element);
setPreloadedImage(imagePath, data);
perfEvent("preload:done", { path: imagePath });
```

（catch 節は現行どおりエラーエントリ格納。`retainedImages` には入れない。）
- `cleanupCache` の `keysToRemove.forEach` 内で `retainedImages.delete(path);` も行う。
- フォルダ変更でクリア: hook 内に

```typescript
useEffect(() => {
  retainedImages.clear();
}, [folder.path]);
```

- `src/utils/imageData.ts` と対応テストを削除（`git grep rawToImageData -- src/` がゼロ件であること）。

- [ ] **Step 3: 確認と Commit**

Run: `npx vitest --run src/hooks/__tests__/useImagePreloader.test.ts` → PASS
Run: `npm test` → 全件 PASS / `npm run type-check` → clean / `cd src-tauri && cargo test --lib` → green

```bash
git add src/
git commit -m "feat(perf): preload via spica-img protocol retaining decoded elements"
```

---

### Task 6: bench 内訳・docs・EXIF 検証の追随

**Files:**
- Modify: `e2e/lib/bench-helpers.ts`（`extractTimings`: ipc/decode → fetchDecode）
- Modify: `e2e/lib/bench-helpers.test.ts`
- Modify: `e2e/specs/bench.perf.ts`（breakdown 出力）
- Modify: `e2e/scripts/generate-corpus.mjs`（EXIF orientation 付き画像）
- Modify: `e2e/specs/visual.e2e.ts`（EXIF 回転の実機検証）
- Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md`（§2 mark 表・§4 breakdown・§7 注意の追記）

**Interfaces:**
- Consumes: Task 4 の `src:set` mark、既存の `decode:done`(thumbnail===false) / `paint:done`
- Produces: `extractTimings` の返り値 `{ firstPaint, fullPaint, fetchDecode: number | null }`（`ipc` フィールドは削除）。bench JSON の breakdown は `{ fetch_decode_cold: {median_ms, p95_ms, n} }`。コーパスに `e2e/fixtures/corpus/exif/img-000.jpg`（orientation 6、原寸 1200×800 → 表示 800×1200）

- [ ] **Step 1: bench-helpers テストを新契約に書き換え（先に RED）**

`e2e/lib/bench-helpers.test.ts` の合成 mark 配列を更新: `ipc:sent`/`ipc:received` を `src:set`（ts=100）に置き換え、`decode:done`(thumbnail:true, ts=120) → `decode:done`(thumbnail:false, ts=160) を残し、`fetchDecode === 60`（160−100）を assert。旧 `ipc`/`decode` フィールドの assert は削除。

Run: `npx vitest --run e2e/lib/bench-helpers.test.ts` → FAIL

- [ ] **Step 2: 実装**

`e2e/lib/bench-helpers.ts` の `extractTimings`: `sent`/`received` の検索を削除し、

```typescript
const srcSet = entries.find(
  (e) => e.name === "src:set" && e.detail?.path === path,
);
const fullDecode = entries.find(
  (e) =>
    e.name === "decode:done" &&
    e.detail?.path === path &&
    e.detail?.thumbnail === false,
);
```

を用いて `fetchDecode: srcSet && fullDecode ? fullDecode.ts - srcSet.ts : null` を返す。`e2e/specs/bench.perf.ts` の結果収集・`after()` を `breakdown: { fetch_decode_cold: summarize(...) }` に変更（`ipc_cold`/`decode_cold` の収集配列・出力は削除）。

Run: `npx vitest --run e2e/lib/bench-helpers.test.ts` → PASS

- [ ] **Step 3: EXIF コーパスと視覚検証**

`e2e/scripts/generate-corpus.mjs` の `SETS` の後に単発生成を追加:

```javascript
// EXIF orientation fixture: encoded 1200x800, orientation=6 (rotate 90 CW).
// The protocol pipeline hands original bytes to the browser, which applies
// EXIF orientation — displayed size must be 800x1200.
{
  const dir = join(OUT, "exif");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "img-000.jpg");
  if (!existsSync(file)) {
    const width = 1200;
    const height = 800;
    const rand = mulberry32(99001);
    const raw = Buffer.alloc(width * height * 3);
    for (let p = 0; p < raw.length; p += 3) {
      const x = (p / 3) % width;
      const y = Math.floor(p / 3 / width);
      raw[p] = (x * 255) / width + rand() * 40;
      raw[p + 1] = (y * 255) / height + rand() * 40;
      raw[p + 2] = ((x + y) * 128) / (width + height) + rand() * 40;
    }
    await sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 88 })
      .withMetadata({ orientation: 6 })
      .toFile(file);
    console.log(`generated ${file}`);
  }
}
```

`e2e/specs/visual.e2e.ts` に 3 本目のテストを追加:

```typescript
it("applies EXIF orientation from original bytes", async () => {
  const exifPath = join(CORPUS, "exif", "img-000.jpg");
  await browser.execute(
    (p: string) => void window.__SPICA_TEST__?.openImage(p),
    exifPath,
  );
  await browser.waitUntil(
    async () =>
      browser.execute(() => {
        const img = document.querySelector(".image-viewer img");
        return img instanceof HTMLImageElement && img.naturalWidth > 0;
      }),
    { timeout: 60000, timeoutMsg: "exif image never rendered" },
  );
  const dims = await browser.execute(() => {
    const img = document.querySelector(".image-viewer img") as HTMLImageElement;
    return { w: img.naturalWidth, h: img.naturalHeight };
  });
  // encoded 1200x800 + orientation 6 → browser reports oriented 800x1200
  expect(dims.w).toBe(800);
  expect(dims.h).toBe(1200);
});
```

（`assertCorpusFits`/bench は `exif/` を参照しないため影響なし。）

- [ ] **Step 4: docs を新パイプラインに追随**

`docs/PERFORMANCE_AUTONOMY_PLAN.md`:
- §2 の mark 表: `ipc:sent`/`ipc:received` の 2 行を `src:set`（「画像 URL 設定・fetch 開始直前」）1 行に置換。`measure: ipc` 行を `measure: fetch_decode`（`src:set` → `decode:done`）に、`measure: decode` 行を削除。表直下の実装注記に 1 行追記: 「2026-08 のプロトコル化以降、IPC 区間はホットパスに存在しない。旧 baseline の `ipc_cold`/`decode_cold` と新 `fetch_decode_cold` は比較不能（パイプライン相違）。」
- §4 スキーマの breakdown を `"breakdown": { "fetch_decode_cold": { "median_ms": 0, "p95_ms": 0, "n": 0 } }` に更新。
- §7 に追記: 「EXIF orientation はプロトコル化で原本バイトがブラウザに渡るため自動適用される（旧パイプラインは再エンコードで EXIF が落ち、回転付き JPEG は未回転表示だった）。視覚ゲートに exif コーパス検証あり。」

- [ ] **Step 5: 実機確認と Commit**

Run: `npm run bench:corpus`（exif 画像が生成される）→ `npm run test:e2e` → smoke 3 + visual 3 = 6 passing
Run: `npm test` → 全件 PASS

```bash
git add e2e/ docs/PERFORMANCE_AUTONOMY_PLAN.md
git commit -m "feat(bench): track fetch_decode breakdown and verify EXIF orientation"
```

---

### Task 7: Phase 6 採否ゲート実行と baseline 更新

**Files:**
- Modify: `bench-results/baseline.json`（採用時のみ）
- Modify: `docs/PERFORMANCE_AUTONOMY_PLAN.md`（§8・Phase 5/6 チェックボックス）

**Interfaces:**
- Consumes: これまでの全タスク、CLAUDE.md「Performance changes」のゲート、`bench-results/baseline.json`（旧値）
- Produces: 採用判定の記録。採用時は新 baseline

- [ ] **Step 1: 計測**

Run: `npm run bench:build` → `npm run bench`
（他の重負荷アプリを起動しない。ベンチ全体で 10〜20 分。）

- [ ] **Step 2: ゲート判定**

新結果 `bench-results/<sha>-<ts>.json` と `baseline.json` を比較し、以下を**すべて**確認して判定を明文化する:

1. **改善ゲート**: TTFI_cold median が 1771.4ms 比 **10% 以上改善**（= 1594ms 以下。予測は 400〜700ms — ipc_cold 1266ms の大半が消えるため）
2. **回帰ゲート**: NAV_warm median（baseline 162.0ms）/ NAV_cold median（515.6ms）が p95 の揺れを超えて悪化していない（NAV_warm は data URL パース消滅で改善見込み）
3. **n ゲート**: gated 3 指標すべて n=7。`fetch_decode_cold` は新設のため baseline 比較なし（`ipc_cold`/`decode_cold` が新 JSON に無いのはパイプライン撤廃による設計変更 — この説明を採用コミットのメッセージに含めることで CLAUDE.md の「n が runs を下回った場合は説明」要件を満たす）
4. **正しさゲート**: `npm test` / `cd src-tauri && cargo test --lib` green
5. **視覚ゲート**: `npm run test:e2e` green（EXIF 検証含む）

**不合格の場合**: baseline を更新せず、実測値と考察を本プランのこのセクションに追記してコミットし、**停止して人間に報告する**（ブランチ破棄 = revert 相当の判断はブランチ全体に及ぶため人間の確認を待つ）。

- [ ] **Step 3: 採用処理**

Run: `npm run bench:baseline`（検証ガードを通って baseline.json が更新される）

`docs/PERFORMANCE_AUTONOMY_PLAN.md`:
- §8 の表を新実測で書き換え（旧値は「旧 baseline（base64 IPC 時代）」として表の下に 1 行残す。ipc/decode 行は `fetch_decode` 行に置換）
- Phase 5 の「[最有力] base64 over IPC の撤廃」チェックボックスを `[x]`
- Phase 6 チェックボックス（§9 サマリ含む）を `[x]`（ゲート運用の初回サイクルが完了したため）

- [ ] **Step 4: Commit**

```bash
git add bench-results/baseline.json docs/PERFORMANCE_AUTONOMY_PLAN.md
git commit -m "feat(perf): adopt spica-img pipeline — TTFI_cold <新median>ms (was 1771ms)"
```

（`<新median>` は実測値で置換。コミット本文に Step 2 の 5 項目の判定結果と breakdown フィールド変更の説明を列挙すること。）

---

### Task 8: 死んだ base64 経路の削除とスペック整合（採用後のみ実行）

**Files:**
- Modify: `src-tauri/src/commands/file.rs`（`load_image` コマンドと関連テスト削除）
- Modify: `src-tauri/src/lib.rs`（invoke_handler から `load_image` 削除）
- Modify: `src-tauri/src/utils/image.rs`（`load_image_as_base64` と関連テスト削除。`get_image_dimensions`/`generate_thumbnail`/`is_supported_image`/`get_image_format` は**残す** — サムネイル経路が現役）
- Modify: `PROJECT_SPEC.md`（Known Limitations の base64 項）

**Interfaces:**
- Consumes: Task 4/5 でフロントの `load_image` 呼び出しがゼロになっていること（`git grep '"load_image"' -- src/` がゼロ件）
- Produces: 死コードなしの最終状態

- [ ] **Step 1: 利用ゼロを確認**

Run: `git grep -n "load_image" -- src/ e2e/`
Expected: ヒットなし（あれば削除してはならない — 停止して原因を確認）

- [ ] **Step 2: 削除**

- `file.rs`: `load_image` 関数、`use ... load_image_as_base64` import、`load_image` 系テスト（`test_load_image_*` 5 本）を削除
- `lib.rs`: `generate_handler!` リストと `use commands::file::{...}` から `load_image` を削除
- `image.rs`: `load_image_as_base64` と `test_load_image_as_base64_*` 3 本を削除（`read_raw`/`decode`/`encode`/`base64` の PerfTimer もこの関数と共に消える。`PerfTimer` 自体は protocol.rs の `serve` が使うため残る）

- [ ] **Step 3: PROJECT_SPEC の既知の制限を更新**

`PROJECT_SPEC.md` の Known Limitations にある「**Large Image Performance**: 2000px+ images load slower due to base64 encoding」の項を、次で置換:

```markdown
1. ~~**Large Image Performance**: 2000px+ images load slower due to base64 encoding~~ — Resolved: images are served as raw bytes over the custom `spica-img` protocol (see docs/PERFORMANCE_AUTONOMY_PLAN.md §8 for measured results)
```

- [ ] **Step 4: 確認と Commit**

Run: `cd src-tauri && cargo test --lib` → green（件数は削除分減る）/ `cargo check` / `cargo check --features e2e`
Run: `npm test` → green / `npm run bench:build` → `npm run test:e2e` → green（プロトコル経路が引き続き動く実機確認）
bench 再実行は不要（死コード削除はホットパス非接触。CLAUDE.md の bench 要件は「パフォーマンス関連の変更」= 計測経路に触れる変更が対象であり、本コミットは非該当 — この判断をコミット本文に 1 行残す）。

```bash
git add src-tauri/ PROJECT_SPEC.md
git commit -m "refactor(perf): remove dead base64 load_image pipeline"
```

---

## リスクと予測

- **予測効果**: TTFI_cold 1771ms → 400〜700ms（ipc 1266ms の大半が消える。目標 <500ms には folder スキャン+fetch+decode 次第で届かない可能性あり — その場合も改善ゲート(≥10%)は余裕で通る。<500ms 未達なら次仮説「表示解像度デコード」を別プランで）。NAV_warm は 11MB data URL の毎回パースが消えるため改善見込み（<100ms 到達は未保証 — 未達なら次仮説）。
- **decode() の失敗情報が粗くなる**: 旧経路は Rust のエラーメッセージ（"Failed to load image: ..."）が出たが、新経路は `decode()` reject。エラーメッセージは「Failed to load image: <path>」相当になる。E2E の破損ファイル挙動はブラウザのデコード失敗として現れる（既存 UX と同等）。
- **EXIF 回転は挙動変更（修正）**: 回転付き JPEG が正しく表示されるようになる。Task 6 の視覚検証がこれを固定化する。
- **API シグネチャの不確実性**: `register_asynchronous_uri_scheme_protocol` / `tauri::http` の細部は Tauri 2.11 の docs.rs で実装時に必ず確認（Task 2 冒頭に明記済み）。
- **メモリ**: preload の base64 文字列（〜8MB×10）が消え、保持は encoded バイト相当のブラウザキャッシュ参照になる。悪化方向のリスクは低い。

## Self-Review 済み事項

- スペック対応: Phase 4→Task 1、Phase 5 候補 1→Task 2〜6、Phase 6→Task 7、§7 の「まず 1 枚表示できることを確認してから計測へ」→Task 4 Step 5、EXIF 注意→Task 6、1 コミット 1 仮説→Global Constraints の解釈条項。Phase 5 の他候補（表示解像度デコード等）は意図的にスコープ外（別仮説）。
- 型整合: `ImageData{path,src,width,height,format}`（Task 3 定義）を Task 4/5/6 が一貫使用。`loadImageViaProtocol` の返り値 `{data, element}` は Task 4 定義・Task 5 消費で一致。`src:set` は Task 4 発行・Task 6 消費で一致。
- プレースホルダ: Task 1 Step 3 と Task 7 Step 4 の `<実測>`/`<新median>` は実行時実測値の記入指示であり、コミット前に必ず置換される設計（指示文に明記済み）。
