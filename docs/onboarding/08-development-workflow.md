# 08. 日々の開発フロー

## この章で学ぶこと

- `npm run tauri dev` 中の保存時の挙動
- 型チェック・lint・format の使い分け
- バージョン管理とリリースビルド
- ブランチ運用とコミットメッセージ
- PR と CI の関係
- 困ったときの調査ルート

所要時間: 30 分

---

## 開発サーバを動かす

```bash
npm run tauri dev
```

このコマンドの内訳は [04-tauri-basics.md](./04-tauri-basics.md#tauriconfjson-の主要セクション) で説明済み。動作中:

- **`src/` 配下のファイルを保存**: Vite の HMR (Hot Module Replacement) が走り、WebView 内の React コンポーネントが即座に更新される (`vite.config.ts:14` の `clearScreen: false` で Rust エラーも消えずに残ります)
- **`src-tauri/` 配下のファイルを保存**: Tauri CLI が Rust を再コンパイルし、ウィンドウを自動再起動する。コンパイルが終わるまで数秒〜数十秒かかる
- **`tauri.conf.json` を保存**: 同様に再起動。capability や bundle 設定の変更時はここで反映される

開発中は `Ctrl+C` で停止、再度 `npm run tauri dev` で再開できます。

---

## 型チェック

```bash
npm run type-check         # src/ 全体の TypeScript 型チェック (tsconfig.json)
npm run type-check:test    # テストファイルも含めた型チェック (tsconfig.test.json)
```

`npm run tauri dev` は型エラーがあっても Vite 側では起動できてしまうので、コミット前は **型チェックを必ず通す** のが安心です。

---

## Lint と Format

このプロジェクトでは [oxlint](https://oxc.rs/docs/guide/usage/linter.html) と [oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) を採用しています (ESLint と Prettier ではない点に注意)。設定は `.oxlintrc.json` と `.oxfmtrc.json`。

lint は oxlint の既定 (`correctness` のみ) では Biome の recommended より緩くなるため、`suspicious` カテゴリと react / jsx-a11y / import / promise プラグインまで広げてあります。加えて `options.typeAware` を有効にしていますが、これは Biome の `useOptionalChain` 相当である `typescript/prefer-optional-chain` を動かすためだけのもので (oxlint では型情報が無いと 1 件も検出できません)、同時に起動する他の型認識ルールは `.oxlintrc.json` で個別に off にしてあります。型認識には `oxlint-tsgolint` が要るため devDependency に入っており、lint は 100ms 弱から 300ms 程度に伸びます。個別に切ったルールは `.oxlintrc.json` 内に理由付きで書いてあります。format は oxfmt の既定をそのまま使い、`printWidth` だけ 80 (oxfmt の既定は 100) に据え置いています — Biome 時代の整形結果と一致する値で、移行時にソースの再整形差分をゼロにするためです。

```bash
npm run lint               # lint チェック (修正なし)
npm run lint:fix           # lint チェック + 自動修正
npm run format             # フォーマットチェック (修正なし)
npm run format:fix         # フォーマット適用
```

### 自動整形 hook について

このリポジトリには Claude Code 用の hook (`.claude/hooks/format.mjs`) が組み込まれており、**Edit / Write の直後に対象ファイルが自動整形** されます。手動で `format:fix` を頻発させる必要はありません。拡張子で整形器を選び、`.ts` / `.tsx` / `.js` / `.jsx` / `.json` / `.jsonc` は oxfmt、`.rs` は `rustfmt --edition 2021` を呼びます (edition を渡さないと rustfmt は 2015 とみなして 2021 の構文を解釈できません)。CI では `npm run format` と `cargo fmt --check` (どちらもチェックのみ) が走るため、もし整形漏れがあれば検知されます。

npm scripts の lint / format 対象は `src/` `e2e/` `scripts/` `.claude/hooks/` とルートの ts 設定ファイルで、`src-tauri/` 配下の Rust コードは含みません。Rust には cargo 側のコマンドを使ってください。

---

## Rust の Lint と Format

`rustfmt.toml` も `clippy.toml` も置いておらず、**rustfmt と clippy のデフォルト設定** をそのまま使います。

```bash
cd src-tauri
cargo fmt                                    # 整形を適用
cargo fmt --check                            # 整形チェック (修正なし)
cargo clippy --all-targets -- -D warnings    # lint チェック
```

CI の `backend-tests` ジョブはこの 3 つのうち `cargo fmt --check` と `cargo clippy --all-targets -- -D warnings` をテストの前に実行します。**clippy の警告は 1 件でも CI を落とします** (`-D warnings`)。`--all-targets` は `examples/` も対象に含めます。

なお `backend-tests` は ubuntu-latest で動くため、`#[cfg(windows)]` で囲まれたコード (Explorer 連動の COM レイヤなど) は fmt 以外はチェックされません。これは `cargo test --lib` も同じ制約です。Windows 限定コードを触ったときは手元で `cargo clippy --all-targets -- -D warnings` を回してください。

---

## テスト

```bash
npm test                                # フロント全テスト
npm run test:watch                      # 変更を監視して自動再実行
cd src-tauri && cargo test --lib        # Rust 全テスト
cd src-tauri && cargo test commands::file::tests  # 指定モジュールだけ
```

詳細は [07-testing.md](./07-testing.md) 参照。

---

## バージョン管理: `sync-version`

`package.json` の `version` フィールドが **マスター** で、`src-tauri/Cargo.toml` と `src-tauri/tauri.conf.json` には同じバージョンが書かれている必要があります。

これを手動で同期するのは事故のもとなので、`scripts/sync-version.cjs` が用意されています。

```bash
npm run sync-version
```

このスクリプト (`scripts/sync-version.cjs:6-37`) は次を行います。

1. `package.json` の `version` を読む
2. `src-tauri/tauri.conf.json` の `version` フィールドを上書き
3. `src-tauri/Cargo.toml` の `[package]` セクションの `version = "x.y.z"` を上書き

`package.json:11` の `build` スクリプトはビルド前に必ず `sync-version` を呼ぶようになっているため、`npm run tauri build` を走らせれば自動同期されます。**手動で実行する必要があるのは「バージョンを上げて即コミットしたいとき」だけ** です:

```bash
npm version patch          # package.json の version を 1.0.0 → 1.0.1
npm run sync-version       # tauri.conf.json と Cargo.toml にも反映
git diff                   # 確認
git add ...
git commit
```

About ダイアログ (`AboutDialog.tsx:14`) は `getVersion()` で `tauri.conf.json` のバージョンを動的に取得するため、コードを書き換える必要はありません。

---

## リリースビルド

```bash
npm run tauri build
```

このコマンドは:

1. `npm run sync-version` でバージョンを揃える (`package.json:11`)
2. `tsc --project tsconfig.json` で型チェック
3. `vite build` でフロントを `dist/` に出力
4. Tauri CLI が Rust を release モードでコンパイル
5. プラットフォーム別のインストーラを生成

Windows の場合の出力先:

- 実行ファイル: `src-tauri/target/release/spica-photo-viewer.exe`
- NSIS インストーラ: `src-tauri/target/release/bundle/nsis/Spica Photo Viewer_<version>_x64-setup.exe`

NSIS は [01-setup.md](./01-setup.md#3-3-本番ビルド時のみ-nsis) の通り初回ビルド時に自動で取得されます。インストーラの設定は `tauri.conf.json:43-91` の `bundle` セクション、インストーラに差し込む処理は `src-tauri/installer-hooks.nsh`。

リリースビルドは初回 10〜15 分かかります。差分ビルドでも数分かかるので、頻繁に走らせるものではありません。

---

## ブランチ運用

`main` 直接コミットは原則不可。機能や修正ごとに feature ブランチを切り、PR をマージします。

慣例的なブランチ名:

```
feature/add-rotation
fix/thumbnail-flicker
chore/upgrade-deps
docs/onboarding-guide
```

PR をマージしたあとはブランチを削除します。

---

## コミットメッセージ

Conventional Commits 形式を採用しています。最近のコミットを `git log --oneline -20` で見ると傾向がつかめます。

```
feat: 画像のローテーション機能を追加
fix: サムネイルバーのちらつきを修正
chore(deps)(deps-dev): bump vitest from 4.1.4 to 4.1.5
docs: オンボーディングドキュメントを追加
test: useKeyboard の Ctrl+R テストを追加
refactor: useImagePreloader のキューロジックを簡略化
```

タイプ:

- `feat`: 新機能
- `fix`: バグ修正
- `refactor`: 機能変更を伴わないリファクタ
- `chore`: 依存更新やビルド設定の変更
- `docs`: ドキュメントだけの変更
- `test`: テストだけの変更

依存自動更新 (Dependabot) のコミットは `chore(deps)...` 形式で自動生成されます (`git log` で `dependabot/` ブランチのマージコミットを確認)。

---

## PR を出してから CI が通るまで

PR を作成すると、`.github/workflows/ci.yml` が走ります (`*.md`、`scripts/`、`public/`、`LICENSE`、`.gitignore` のみの変更時はスキップされます)。

| ジョブ | 実行内容 |
| --- | --- |
| `frontend-tests` | `npm ci` → `npm run type-check` → `npm run lint` → `npm run format` → `npm test` |
| `backend-tests` | apt で webkit2gtk 等を入れる → Rust toolchain stable (`components: rustfmt, clippy`) → `cargo fmt --check` → `cargo clippy --all-targets -- -D warnings` → `cargo test --lib` |

両方が green になればマージ可能。

ローカルで `npm run type-check && npm run lint && npm run format && npm test` を通してから push すると CI 待ちのストレスが減ります。Rust 側は `cd src-tauri` して `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test --lib` の 3 つを加えればフルチェックです。

---

## 困ったときの調査ルート

### コードの仕様を知りたい

- まず [`PROJECT_SPEC.md`](../../PROJECT_SPEC.md) — 機能の意図、UI レイアウト、性能目標
- 実装の詳細はソースを直接読む。本オンボーディングの [05](./05-backend-walkthrough.md) と [06](./06-frontend-walkthrough.md) で「どこに何があるか」の地図を提供しています

### コーディング規約や運用ルールを知りたい

- [`CLAUDE.md`](../../CLAUDE.md) — コマンド一覧、Code Style、Testing 方針
- [`.claude/rules/`](../../.claude/rules/) — エンジニアが守るべき詳細ルール (例: Zustand の不変更新)

### Rust API のドキュメントが見たい

```bash
cd src-tauri
cargo doc --open
```

依存クレート (`tauri`、`image`、`serde` など) のドキュメントが手元でビルドされ、ブラウザで開きます。`tauri::Builder::invoke_handler` などをクリックして辿れます。

### Tauri の最新仕様を知りたい

- 公式: https://tauri.app/
- API リファレンス (Rust): https://docs.rs/tauri/latest/tauri/
- API リファレンス (JS): https://tauri.app/reference/javascript/
- Discord / GitHub Discussions

### バグを発見したら

1. まず `git log` と GitHub の Issues で既知の問題か確認
2. 再現手順をできるだけ細かく書いて新規 Issue を起票
3. 自分で直せそうなら feature ブランチを切って PR

### Issue が無い既知の制約

- D&D は無効化中 (`App.tsx:21`)
- 2000px 超の画像は base64 エンコード時間で重くなる ([README.md](../../README.md) の Known Issues 参照)

---

## 開発のコツ

- **小さくコミット**: 1 コミット = 1 トピック。Conventional Commits を意識すると自然と粒度が揃います
- **`git diff` を必ず読む**: コミット前に `git diff --stat` と `git diff` を見る習慣を
- **CI を待たない**: ローカルで `type-check` + `lint` + `format` + `test` を通してから push
- **Rust のコンパイルは並行作業で待つ**: `tauri dev` の Rust コンパイル中に別ターミナルで `npm test` を回せる
- **ストアの新規アクションを追加する手順** ([`.claude/rules/zustand-store.md`](../../.claude/rules/zustand-store.md)):
  1. `AppActions` interface に追加
  2. ストアに不変更新で実装
  3. `src/utils/testUtils.tsx` のモックを更新 (使われている場合)
  4. `src/store/__tests__/index.test.ts` にテスト追加

---

## 次のステップ

開発フローが分かったら → [09-hands-on-final.md](./09-hands-on-final.md) で総合演習にチャレンジしましょう。
