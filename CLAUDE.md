# CLAUDE.md

## Commands

```bash
npm run tauri dev          # Start frontend + backend dev server
npm test                   # Run all tests (must pass before committing)
npm run type-check         # TypeScript type checking
npm run lint:fix           # Auto-fix lint issues (Biome)
npm run format:fix         # Auto-fix formatting (Biome)
npm run sync-version       # Sync version from package.json to Cargo.toml and tauri.conf.json

# Rust backend tests
cd src-tauri && cargo test --lib
cd src-tauri && cargo test commands::file::tests  # Run specific test module
```

## Code Style

- Biome for linting and formatting (not ESLint/Prettier)
- Run `npm run lint:fix` and `npm run format:fix` before committing

## Testing

- All tests must pass before committing

## Project Specs

For detailed specifications, see [PROJECT_SPEC.md](./PROJECT_SPEC.md).

## Performance changes

- パフォーマンス関連の変更後は、必ず `npm run bench:build && npm run bench` を実行する（`bench:build` が release バイナリを計測対象のソースと一致させる。N=7、中央値/p95）。
- `bench-results/baseline.json` と比較し、以下を**すべて**満たす場合のみ採用する:
  - 対象指標の中央値が baseline 比 **10% 以上改善**
  - 他の指標が p95 の揺れを超えて悪化していない
  - `npm test` と `cd src-tauri && cargo test --lib` が全件 green
  - `npm run test:e2e`（視覚ゲート含む）が green
- いずれかの指標の `n` が `runs` を下回った場合（特に NAV_warm の preload MISS による除外）は、原因を調査して説明できるまで採用しない。
- 満たさない変更は `git revert` する。
- 最適化前に必ず profiling（`SPICA_PERF=1` の Rust ログ（op: `serve`）と `__PERF__` の fetch_decode 内訳）で支配的ボトルネックを特定し、1 コミット 1 仮説とする。当て推量での複数同時変更は禁止。
- 採用時は `npm run bench:baseline` で `baseline.json` を更新し、同じコミットに含める（bench は再実行されず、判定に使った直近 run の JSON がそのまま baseline になる）。
- N=7 の nearest-rank p95 は最大値と一致するため外れ値 1 個で汚染される。回帰判定は中央値を主、p95 を参考値とする（特に NAV_warm）。
- ベンチ実行中は他の重負荷アプリを起動しない（同一マシン・同一条件での比較のみ有効。OS ページキャッシュの影響で再起動直後の初回 run は遅く出る）。
- 体感ナビゲーション（NAV_rapid ワークストリーム）の目標: NAV_rapid フル品質 paint 中央値 < 100ms かつ PLACEHOLDER_dur 中央値 < 80ms（またはプレースホルダー非表示 = 0）。NAV_rapid / PLACEHOLDER_dur の n は runs × steps（7 × 12 = 84）に満たなければその run は無効。サイクル毎の改善判定は NAV_rapid 中央値で行い、PLACEHOLDER_dur の進捗は p95 で追う（hit 優勢時に中央値は 0 に飽和するため）。
- プレビュー層ワークストリーム（2026-08-21〜、設計: `docs/superpowers/specs/2026-08-21-thumbnail-implies-cached-preview-tier-design.md`）の主指標は **NAV_visible**（可視サムネイルへの非単調ナビ 12 ステップ × 7 run、n=84 固定）。目標: **NAV_visible 中央値 < 100ms かつ hit_rate = 1.0 かつ PLACEHOLDER_dur_visible p95 < 80ms（目標 0）**。サイクル毎の改善判定は NAV_visible 中央値で行う。
- `paint:done` の `tier`（thumbnail / preview / full）により「フル品質 paint」= 最初の非プレースホルダー paint（preview または full）と定義する（D1）。フル解像度への到達は **ZOOM_full**（zoom:request → tier full の paint。表示が既に full なら 0）で別途監視し、回帰ゲートには含めない（目安: 中央値 ≤ 500ms）。
- NAV_cold は「プリローダー静穏 → `evictDecoded()` → ジャンプ」のメモリ冷・ディスク温経路（2026-08-21 再定義）。旧 baseline の NAV_cold とは比較しない。
