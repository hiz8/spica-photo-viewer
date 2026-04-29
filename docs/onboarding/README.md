# Spica Photo Viewer オンボーディング

このドキュメントは、**Rust も Tauri も触ったことがない開発者** が Spica Photo Viewer のコードベースを理解し、自力で機能追加 PR を出せるようになるまでを順序立てて学べる教材です。

---

## このオンボーディングのゴール

このドキュメントを通読し、章末のハンズオン演習を完了すると、次のことができるようになります。

- 開発環境を構築し、`npm run tauri dev` でアプリを起動できる
- フロントエンド (React) とバックエンド (Rust) がどのように連携しているかを説明できる
- Tauri の `command` / `capability` / `plugin` の役割を区別できる
- 既存の Tauri コマンドのソースを読み、引数と戻り値の流れを追える
- 新しい Tauri コマンドを追加し、フロントエンドから `invoke` で呼び出せる
- `cargo test --lib` と `npm test` でテストを書いて通せる
- 既存の開発フロー (lint / format / 型チェック / コミット) に沿って PR を出せる

---

## 想定読者

- 何らかの Web アプリ開発、もしくはデスクトップ開発の経験がある
- TypeScript と React をある程度書ける
- Rust と Tauri は未経験、もしくは数行触ったことがある程度

すでに Rust や Tauri に詳しい場合は、章の冒頭に書かれている要約だけ読んで先に進んでください。

---

## 学習ロードマップ

```
[01-setup]            環境を作る
   ↓
[02-architecture]     全体像をつかむ
   ↓
[03-rust-essentials]  Rust の最低限を学ぶ ──┐
                                            ├─ ここまでで「読む」準備が完了
[04-tauri-basics]     Tauri の作法を学ぶ ──┘
   ↓
[05-backend-walkthrough]   Rust 側のコードを精読
   ↓
[06-frontend-walkthrough]  React 側のコードを精読 + IPC を理解
   ↓
[07-testing]               テストの書き方を学ぶ
   ↓
[08-development-workflow]  日々の開発フローを身につける
   ↓
[09-hands-on-final]   総合演習: 新規コマンド追加〜フロント連携〜テスト
```

---

## 章の一覧

| 章 | タイトル | 目安時間 | 内容 |
| --- | --- | --- | --- |
| [01](./01-setup.md) | 環境構築 | 60〜90 分 | Node.js / Rust / Tauri prerequisites のセットアップ、初回起動 |
| [02](./02-architecture.md) | 全体アーキテクチャ | 30 分 | フロント・バック・IPC のメンタルモデル、ディレクトリマップ |
| [03](./03-rust-essentials.md) | Rust の最低限 | 60 分 | 所有権、`Result`、`Option`、`async`、Serde、モジュールシステム |
| [04](./04-tauri-basics.md) | Tauri v2 の基礎 | 45 分 | `#[tauri::command]`、capability、plugin、`AppHandle`、`invoke` |
| [05](./05-backend-walkthrough.md) | バックエンド読解 | 90 分 | `commands/{file,cache,window}.rs` と `utils/image.rs` の精読 |
| [06](./06-frontend-walkthrough.md) | フロントエンド読解 | 90 分 | Zustand store / hooks / IPC コントラクト |
| [07](./07-testing.md) | テスト | 45 分 | `cargo test --lib`、`vitest`、テストヘルパーの使い方 |
| [08](./08-development-workflow.md) | 開発フロー | 30 分 | 起動、保存時の挙動、lint / format、バージョン同期、CI |
| [09](./09-hands-on-final.md) | 総合演習 | 90〜120 分 | 新規コマンド追加〜フロント連携〜テスト追加までの一気通貫 |

合計: 8 〜 10 時間程度。1 日でやり切る必要はありません。

---

## 自分のレベル別ナビゲーション

- **Rust に慣れている方**: 03 を流し読みし、04 から本格的に読み始めてください。
- **Tauri を触ったことがある方**: 04 のうち「`#[tauri::command]` マクロが何をしているか」と「capability」の節だけ読み、05 へ。
- **React と Zustand に慣れている方**: 06 の前半 (Zustand store の精読) は流し読みで構いません。IPC コントラクト一覧は必ず目を通してください。
- **すぐにコードを書きたい方**: 01 → 02 → 04 → 09 の順で読み、必要に応じて他の章を参照してください。

---

## 補足ドキュメント

このオンボーディングは「読み始める入口」を提供します。より詳しい仕様や運用情報は以下を参照してください。

- [`../../README.md`](../../README.md) — ユーザー向け README
- [`../../PROJECT_SPEC.md`](../../PROJECT_SPEC.md) — 機能仕様の正本 (UI レイアウト、性能目標、ステート構造)
- [`../../CLAUDE.md`](../../CLAUDE.md) — コーディング規約、コマンド一覧
- [`../../.claude/rules/zustand-store.md`](../../.claude/rules/zustand-store.md) — Zustand 利用ルール

---

## つまずいたとき

- 環境構築でつまずいたら → [01-setup](./01-setup.md) の「よくあるトラブル」セクション
- IPC の引数や戻り値が分からなくなったら → [06-frontend-walkthrough](./06-frontend-walkthrough.md) の IPC コントラクト一覧表
- バグを踏んだら → 既存の Issue を確認のうえ、再現手順とともに新規 Issue を起票
- 本ドキュメント自体の誤りを見つけたら → 修正 PR を歓迎します

---

それでは、[01-setup.md](./01-setup.md) から始めましょう。
