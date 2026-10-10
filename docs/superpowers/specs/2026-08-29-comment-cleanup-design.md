# 設計: コード全体のコメント整理と簡素化（src / src-tauri）

作成日: 2026-08-29
対象: `src/`（49 ファイル・11,539 行）、`src-tauri/src/`（14 ファイル・3,822 行）

## 0. 結論（実装可否）

実施可能。コメントは 2 群にはっきり分かれており、機械的に削れる群と判断を要する群を別フェーズに分けることで安全に進められる。

最大のリスクは「積極的圧縮」による知見の消失である。特に `M1` / `M3`〜`M6` / `X1` / `X2` の 7 ラベル（コード内 13 箇所）は **docs 配下のどこにも定義がなく、コードのコメントが唯一の記録**である。この対策として、圧縮より前に `docs/code-rationale.md` へ全文移設するフェーズを置く（Phase 0）。

TypeScript 側はコメント除去後のコードが変更前後で完全一致することを esbuild で機械的に保証できる（`node_modules` に 0.28.2 が存在、追加依存は不要）。Rust 側は同等の手段がなく、行ベース検査 + `cargo test --lib` が現実的な上限である。この非対称性は受け入れる。

## 1. 現状分析（コードの事実）

コメント行は TS 1,051 行 / Rust 435 行、合計 1,486 行（全体の約 10%）。日本語コメントは 1 行のみで、実質英語に統一済み。TODO/FIXME/HACK は 0 件。コメントアウトされたコードは `src/App.tsx:10` の 1 件のみ。

コメントは性質の異なる 2 群からなる。

**A 群 — 削減対象の What コメント**

- 命令形の一行コメント約 210 行（非テスト 106 / テスト 105）。`// Mark this path as actively loading`、`// Update dimensions`、`// Set an error first` など。
- 該当ファイル（非テスト）: `App.tsx`、`ImageViewer.tsx`、`ThumbnailBar.tsx`、`useThumbnailGenerator.ts`、`useWindowState.ts`、`store/index.ts`、`utils/testUtils.tsx`、`commands/file.rs`、`test_utils.rs`
- `src/constants/timing.ts` は 77 行中 53 行がコメントで、各 JSDoc の 1 行目が定数名の言い換えになっている。

**B 群 — 設計知見を担う Why ブロック**

`useImagePreloader.ts`、`bitmapLoader.ts`、`ImageViewer.tsx`、`preview.rs`、`explorer_sort.rs`、`file.rs`、`cache.rs` に集中。設計スペック参照（`design spec 2026-08-21 §6.6` など 7 箇所）とラベル参照を持つ。

ラベルの出現状況（コード内）:

| ラベル | 出現数 | スペックに定義 |
|---|---|---|
| I1 / I2 / I3 / I4 | 14 / 4 / 3 / 2 | あり |
| D2 / D3 / D4 / D5 | 2 / 1 / 2 / 4 | あり |
| R2 / R3 / R4 | 2 / 1 / 1 | あり |
| **X1 / X2** | **6 / 2** | **なし（孤児）** |
| **M1 / M3 / M4 / M5 / M6** | **各 1** | **なし（孤児）** |

孤児ラベルの所在: `preview.rs` 9 箇所、`cache.rs` 3 箇所、`file.rs` 1 箇所。内容は CMYK/YCCK ソースで ICC プロファイルを落とす理由（X1）、`jpeg_encoder` が拒否するプロファイル長（X2）、`into_rgb8()` の無コピー最適化（M1）、一時ファイル名の衝突回避（M3）、クラッシュ時の孤児一時ファイル（M4）、キャッシュディレクトリに触れる前のパス検証（M5）、キャッシュ掃除の JSON 全読み（M6）。

参照記法は現在 3 形式が混在する: `(I1)`、`Phase 2 invariant I1`、`design spec 2026-08-21 §6.4`。

## 2. ゴール / 非ゴール

**ゴール**

- コードを読めば判る What コメントを削除する。
- 冗長な Why コメントを圧縮する。詳細な根拠は docs 側に置き、コードからは参照する。
- 判断基準を CLAUDE.md に残し、今後のコメント再増殖を防ぐ。
- ラベル参照を統一し、「この不変条件はどこで参照されているか」を grep 一発で追えるようにする。

**非ゴール**

- 振る舞いの変更。Phase 4（ヘルパ抽出）を除き、コードは 1 行も動かさない。
- Phase 4 以外のリファクタリング。ファイル分割、命名変更、型の再設計は対象外。
- 日本語化・英語化の統一作業（既に英語で統一済み）。
- `docs/` 配下の既存ドキュメントの整理（`code-rationale.md` の新規作成のみ行う）。

## 3. ユーザー決定事項（2026-08-29 承認済み）

1. **B 群の方針**: 積極的に圧縮する。要点を残し、詳細な根拠は docs 側に任せる。
2. **孤児ラベルの扱い**: 圧縮前に `docs/code-rationale.md` へ移設し、コードは 1 行参照に置換する。
3. **テストファイル**: 対象に含める。同一ルーブリックを適用する。
4. **追加施策**: 4 件すべて採用 — 規約の CLAUDE.md 恒久化、参照記法の統一、コメントのみ変更の検証ゲート、ヘルパ抽出による自己文書化。
5. **実行方式**: ハイブリッド（下記 §4 の案 B）。

## 4. 検討した方式

| 案 | 内容 | 判定 |
|---|---|---|
| A | 全ファイルを逐次処理 | 判断は一貫するがコストが高い |
| **B** | **DEL 群は一括、CMP/KEEP/MOVE 群は逐次** | **採用。判断が品質を左右する箇所にコストを寄せる** |
| C | サブエージェント並列 | 不採用。ルーブリック適用がばらつく。加えてサブエージェントの編集では biome hook が発火せず CI の lint/format で落ちる既知の問題がある |

## 5. 全体像と不変条件

```
Phase 0（準備）         docs/code-rationale.md 新規作成 ← 孤児 13 箇所を全文移設
                        scripts/verify-comment-only.mjs 追加
                        CLAUDE.md に規約追記
        ↓
Phase 1（コメントのみ）  非テストの DEL1/DEL2/DEL4/DEL5 を削除
        ↓
Phase 2（コメントのみ）  CMP1〜CMP3 圧縮 + 孤児の 1 行参照化 + Spec 行整備
        ↓
Phase 3（コメントのみ）  テストファイル（DEL3 中心）
        ↓
Phase 4（ロジック変更）  ImageViewer.tsx のヘルパ抽出 ← 別 PR
```

**不変条件**

- **N1（順序）**: Phase 0 の移設は Phase 2 の圧縮より先に完了する。逆順だと根拠がどこにも存在しない状態が一時的に生まれる。
- **N2（コード不変）**: Phase 1〜3 では TS/TSX のコメント除去後のコードが変更前後で完全一致する。Rust は変更行が全てコメント行または空行である。
- **N3（参照の健全性）**: コード内のすべてのラベル参照は、スペックまたは `code-rationale.md` に定義を持つ。孤児ラベルを残したまま完了しない。
- **N4（Phase 4 の隔離）**: ロジックに触れる変更は Phase 4 のみ。単独で revert 可能な別 PR とする。

## 6. 設計詳細

### 6.1 ルーブリック

**削除する（DEL）**

| | 対象 | 例 |
|---|---|---|
| DEL1 | 直後のコードの言い換え | `// Update dimensions` の直下が `setDimensions(...)` |
| DEL2 | 名前を言い換えた JSDoc 1 行目 | `IMAGE_LOAD_DEBOUNCE_MS` の "Debounce delay for image loading" |
| DEL3 | テストの手続き実況（テスト名が意図を語っている場合に限る） | `// Set an error first` |
| DEL4 | 死んだコード | `App.tsx:10` のコメントアウト import |
| DEL5 | 型・シグネチャが既に述べている記述 | `@param path - the path` |

**圧縮する（CMP）— 情報は保持する**

- **CMP1**: 「What 行 + Why 行」の 2 行を Why 1 行に統合する。
  例: `// Process metadata in parallel using rayon` + `// This dramatically speeds up folder scanning for large folders (900+ images)`
  → `// Parallel: 900+ image folders are dominated by per-file metadata reads.`
- **CMP2**: スペックに定義がある内容の再説明を、参照 + 1 行要約に置換する（`(I2)` / `§6.3`）。
- **CMP3**: 長い散文ブロックを短文・箇条書きに直す。条件・例外・数値は 1 つも落とさない。

**必ず残す（KEEP）— 削除も要約もしない**

- **KEEP1**: なぜこの実装でないと壊れるか。順序依存、abort 処理、キャッシュ無効化条件。
- **KEEP2**: 数値の根拠。80MB vs 8MB、300ms 予算、2% ヘッドルーム、q85、1.3 倍ゲート。
- **KEEP3**: 外部の落とし穴。`image` 0.25 の CMYK 報告、`StrCmpLogicalW` の Equal、HWND が Send でない、jsdom に ImageBitmap がない。
- **KEEP4**: 意図的な非採用。"Deliberately does NOT go through an HTMLImageElement"、"Deliberately frozen for the process lifetime"。
- **KEEP5**: 不変条件の表明そのもの。

**移設する（MOVE）**

孤児ラベル 13 箇所を `docs/code-rationale.md` へ全文移設し、コード側は 1 行参照にする。

```rust
// X1: why ICC is dropped for CMYK/YCCK sources — docs/code-rationale.md#x1
```

### 6.2 参照記法の統一

- ファイル先頭に **1 回だけ** 所属スペックを書く。TS/TSX は冒頭の `/** */`、Rust は `//!`。

  ```
  Spec: docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md
  ```

- 以降のインライン参照は `§6.6` / `(I2)` / `(D5)` のみとする。日付とパスを繰り返さない。
- 孤児ラベルは `(X1 → code-rationale.md)` 形式で、移設先が判るようにする。

### 6.3 `docs/code-rationale.md` の構成

スペックが日付付きの設計記録であるのに対し、このファイルは実装に張り付いた根拠を蓄積する生きたドキュメントとする。ラベルごとに見出し（`## X1`）を持ち、コードからアンカーで参照できる形にする。各項目には根拠の全文に加えて、参照元のファイルを記載する。

### 6.4 Phase 4: ヘルパ抽出

`ImageViewer.tsx` の長い手続き本体（`// Mark this path as actively loading`、`// Check if this image has saved view state`、`// Load full resolution directly` などが並ぶ区間）を名前付きヘルパに切り出し、コメント自体を不要にする。抽出後の関数名がコメントの内容を担う。

パフォーマンス経路上のファイルであるため、§8 のベンチゲートを適用する。

### 6.5 CLAUDE.md への規約追記

§6.1 のルーブリックを圧縮した形で「コメント方針」節として追記する。DEL/CMP/KEEP の 3 分類と、孤児ラベルを作らない（新しい根拠は `code-rationale.md` に定義を置く）ことを明記する。

## 7. テスト・検証

### 7.1 コメントのみ変更の検証ゲート（Phase 1〜3）

新規 `scripts/verify-comment-only.mjs` を追加し、各フェーズのコミット前に実行する。

1. **TS/TSX の意味的検査**: 変更された各 `.ts` / `.tsx` について、変更前後の内容を `esbuild --loader=tsx --legal-comments=none` に通し、出力の完全一致を要求する。コメント以外が 1 文字でも変われば検出される。esbuild 0.28.2 は `node_modules` に存在するため追加依存は不要。
2. **Rust の行検査**: `git diff -U0` の追加・削除行がすべてコメント行（`//`、`///`、`//!`、`/*`、`*`、`*/`）または空行であることを検査する。行末コメント（`code // comment`）を編集した行はこの検査を通らないため、スクリプトは該当行を列挙して目視確認を要求する。

Rust には esbuild 相当の手段がないため、TS 側より検証が弱い。この非対称性は `cargo test --lib` で補う。

### 7.2 各フェーズ共通

- `npm test`
- `cd src-tauri && cargo test --lib`
- `npm run type-check`
- `npm run lint`

### 7.3 ラベル参照の健全性検査（N3）

Phase 2 完了時に、コード内の全ラベル参照を抽出し、スペックまたは `code-rationale.md` に定義があることを確認する。§1 の表を更新後の状態で再生成し、孤児が 0 件であることを示す。

## 8. 性能・採否ゲート

Phase 1〜3 はコメントのみの変更であり、生成物に影響しないためベンチは不要。

Phase 4 は `src/components/ImageViewer.tsx` の変更であり、CLAUDE.md のパフォーマンス規定の対象となる。`npm run bench:build && npm run bench` を実行し、CLAUDE.md の採否基準のうち **「他の指標が p95 の揺れを超えて悪化していない」** を適用する（本変更は性能改善を目的としないため、10% 改善の要件は課さない）。

監視する指標:

- NAV_visible 中央値（主指標。n = 84 固定、hit_rate = 1.0）
- PLACEHOLDER_dur_visible p95
- NAV_rapid 中央値

いずれかが p95 の揺れを超えて悪化した場合は `git revert` する。`npm run test:e2e`（視覚ゲート含む）も実行する。`bench:build` 直後の初回 e2e は timing flake が既知のため、フル e2e 2 回連続 green で判定する。

性能改善を採用したわけではないため、`baseline.json` は更新しない。

## 9. リスクと対策

| | リスク | 対策 |
|---|---|---|
| R1 | 積極的圧縮で KEEP1〜KEEP5 に該当する知見を落とす | ルーブリックの KEEP 分類を歯止めとする。Phase 2 は逐次処理とし、圧縮後の diff を 1 ファイルずつ確認する |
| R2 | 孤児ラベルの根拠が移設前に失われる | N1（Phase 0 を先行）で順序を固定する。Phase 0 は移設のみでコードに触れない |
| R3 | Rust 側でコメント以外を誤って変更する | 行ベース検査 + `cargo test --lib`。行末コメント編集は目視確認に回す |
| R4 | Phase 4 が性能を悪化させる | 別 PR に隔離し、ベンチゲートで判定する。悪化時は Phase 4 のみ revert する |
| R5 | 63 ファイルの diff が大きくレビュー不能になる | 検証ゲートで「ロジック未変更」を機械的に保証し、レビューはコメント内容の妥当性に集中できるようにする |
| R6 | 規約を残してもコメントが再増殖する | CLAUDE.md への追記（§6.5）。実装時とサブエージェント dispatch 時の双方で参照される位置に置く |

## 10. 関連ファイル

- `docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md`（I1〜I4 / D1〜D5 の定義元）
- `docs/superpowers/specs/2026-08-28-explorer-folder-sort-order-design.md`（I1〜I4 / D1〜D5 / R1〜R9 の定義元）
- `CLAUDE.md`（§6.5 で追記）
- 新規: `docs/code-rationale.md`、`scripts/verify-comment-only.mjs`
