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
