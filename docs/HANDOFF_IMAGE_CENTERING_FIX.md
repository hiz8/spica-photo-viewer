# Handoff: 画像中央配置バグの修正(canvas 表示パス)

> **次セッションへの指示:** この文書を読み、superpowers:systematic-debugging で仮説を検証してから修正を実施すること。この文書自体は最初のコミットに含めて永続化する(過去に未追跡ドキュメントが消失した事故あり)。

## 症状(ユーザー報告、2026-08-21)

PR #270(decoded bitmap window + canvas paint、merge commit `5bf5caf`)のマージ後、画像が中央に表示されないケースが発生:

- フォルダ内の画像へナビゲーションする際、写真が右上や左下にズレて配置されることがある
- プレースホルダー(サムネイル)は中央に正しく表示されるが、その後のオリジナル(フル解像度)画像がズレて表示される
- 横長の画像は右下に見切れて表示されることが多い
- 縦長の画像は下の完全に見えない位置に表示されることが多い
- 再現確認は `.tmp` 内の画像で実施済み

仕様: 画像は fit-to-window でウィンドウ中央に表示される(`PROJECT_SPEC.md:104` "Centered image with automatic fit-to-window"、`:217` "Calculate center position based on container dimensions and image size")。

## 有力仮説(未検証 — 必ず systematic-debugging で確証してから修正すること)

**`src/App.css:103-106` の配置ルールが `img` セレクタにのみ適用され、PR #270 で新設した `<canvas>` 表示要素に適用されていない。**

```css
.image-viewer img {
  position: absolute;
  transform-origin: center;
}
```

根拠:

1. `src/components/ImageViewer.tsx` は表示要素を条件分岐しており(`ImageViewer.tsx:594-614`)、bitmap キャッシュ **hit 時は `<canvas>`、miss 時・サムネイル表示時は `<img>`** を使う。両者に同じ `imageStyle`(`left`/`top` を `view.imageLeft`/`view.imageTop` から設定 + `transform: scale() translate()`、`ImageViewer.tsx:533-562`)を渡している。
2. しかし `left`/`top` が効くのは `position: absolute` の場合のみ。canvas は CSS が当たらず `position: static`(通常フロー、コンテナ左上起点)になる。
3. 症状と完全に整合する:
   - 要素の width/height は原寸(例 4000×3000)で、`scale()` は要素中心を原点に縮小するため、フロー配置の canvas は「原寸の中心」付近に縮小結果が置かれる → 横長は右下方向へ、縦長は下方向へ大きくズレる(報告の「横長は右下に見切れ」「縦長は下に見えない」と一致)
   - プレースホルダーは `<img>` パスなので中央に正しく出る(報告と一致)
   - hit 時のみ canvas になるため「ズレることがある」という間欠性、および #270 で hit_rate が 0.714→1.0 になったため顕在化したことも説明できる
4. 既存の e2e 視覚ゲートが 3 連続 green だったのにこのバグを見逃した → **視覚ゲートは表示要素の配置(中央性)を検証していない**。

検証方法の例: 実アプリ(`npm run tauri dev` または release ビルド)で hit 時の canvas に `getComputedStyle` で `position` を確認する、あるいは CSS を `.image-viewer img, .image-viewer canvas { ... }` に変えて症状が消えることを確認する。

副次チェック(仮説が外れた/直り切らない場合): EXIF 回転画像で `bitmap.width/height`(`canvasDraw.ts` が canvas 属性サイズに使用)と `data.width/height`(`imageStyle` の CSS サイズに使用)の縦横が食い違うと配置・アスペクトが崩れる。e2e に「exif hit-canvas case」はあるが配置までは見ていない。

## 修正要件

1. **TDD(superpowers:test-driven-development)**: 先に失敗する回帰テストを書く。本命は e2e 層 — **表示要素(`img` と `canvas` の両方のパス)の boundingRect 中心がビューポート中心と一致(fit-to-window 時)することをアサート**する。横長・縦長・EXIF 回転の各ケースを含める。現行視覚ゲートがこのバグを素通しした穴を塞ぐのが目的。
2. 修正は最小で(CSS セレクタに canvas を追加する等)。`transform-origin: center` も canvas に揃えること。
3. ドラッグ・ズーム(ホイール/ダブルクリックリセット)・ウィンドウリサイズ・保存済み view state 復元が canvas 表示でも正しく動くことを確認(`zustand-store.md` のルール: 新規画像は `fitToWindow()`、再訪画像は `updateImageDimensions()`)。

## ゲート(CLAUDE.md 準拠)

- `npm test`(vitest)と `cd src-tauri && cargo test --lib` が全件 green
- `npm run test:e2e`(新設の中央配置アサート含む)が green
- 表示ホットパス(NAV_rapid の計測対象)に触れるため、**`npm run bench:build && npm run bench` を実行し回帰がないことを確認**する。これはバグ修正であり 10% 改善は不要だが、NAV_rapid / NAV_warm / TTFI_cold の中央値が baseline 比で p95 の揺れを超えて悪化していないこと。baseline(`gitSha: c4dc4d8` 系列、main では #270 マージ済み)の更新は原則不要
- ベンチ中は他の重負荷アプリを起動しない。bench の n 欠落(runs 未満)があればその run は無効

## プロセス・環境の注意

- worktree を作成して作業する(superpowers:using-git-worktrees。`.claude/worktrees/` 配下、これまでのブランチ命名は `worktree-<topic>`)
- サブエージェントに編集させる場合、biome の lint/format hook が発火しない。コミット前に lint/format が通ることを検証すること(過去に CI で落ちた実績あり)
- lint/format はメインセッションでは hook に任せる(手動での過剰対応は不要)
- SSH push は不可。`git push https://github.com/hiz8/spica-photo-viewer.git <branch>` の HTTPS 形式で push する(gh credential helper 設定済み)
- 長時間コマンド(テスト・bench)は background で実行する
- 完了後は push → `gh pr create`(base: main、過去 PR の命名規則: `fix:`/`perf:` プレフィックス + 効果の要約)

## 関連ファイル

| ファイル | 関連 |
|---|---|
| `src/App.css:103-106` | 疑いの中心: `img` のみの配置ルール |
| `src/components/ImageViewer.tsx:533-562, 594-614` | `imageStyle` 定義と img/canvas 分岐 |
| `src/utils/canvasDraw.ts` | canvas 属性サイズ = bitmap 原寸 |
| `src/store/index.ts` の `fitToWindow` | `view.imageLeft/imageTop` の中央配置計算 |
| `e2e/specs/visual.e2e.ts` | 既存視覚ゲート(配置検証の追加先候補) |
| `docs/superpowers/specs/2026-08-16-nav-rapid-bitmap-window-design.md` | #270 の設計背景 |
