# 設計: Explorer のフォルダ表示順に合わせた画像ナビゲーション順

- 日付: 2026-08-28 / 前提: `main` 60b35a7
- 種別: 実装可否調査 + 設計（brainstorming 成果物）。ユーザー決定事項（§3 D1–D4）は **2026-08-28 に推奨案で承認済み**
- 実装プランは Phase 単位で `docs/superpowers/plans/` に置く（§10）
- 実機検証の生データは **付録 A**。検証スクリプトは `scripts/explorer-sort-probe/` に整理して置く（Phase 2）

## 0. 結論（実装可否）

**実現可能。** Windows 11 実機で、Explorer が保持しているソート設定を COM 経由で正確に取得できることを確認した（付録 A）。

| 検証項目 | 結果 |
|---|---|
| `IShellWindows` によるウィンドウ列挙 | ✅ 動作。**Windows 11 のタブも個別に列挙される**（HWND 4 個に対し 10 エントリ） |
| バックグラウンドタブからの取得 | ✅ 可能。各タブが独立した `IShellBrowser` を持つ |
| `IFolderView2::GetSortColumns` | ✅ **タブごとに実際の設定**を返す（名前昇順 `pid=10 dir=1` / サイズ降順 `pid=12 dir=-1`） |
| `IFolderView2::GetGroupBy` | ✅ 取得可（`pid=14` = 更新日時） |
| 取得コスト（全 10 ウィンドウ走査） | cold **77ms** / warm **12ms**。一致時点で打ち切ればさらに短い |

**副次的に判明した既存バグ**: Explorer 設定に合わせる以前に、現在の「名前順」自体が Explorer と一致していない。`src-tauri/src/commands/file.rs:59` の `a.filename.cmp(&b.filename)` は序数（バイト）比較であり、Explorer の自然順（`StrCmpLogicalW`、大小文字無視）とは別物。実フォルダでの実測:

| フォルダ | ファイル数 | 序数比較（現状） | `StrCmpLogicalW` | 大小無視の文化圏比較 |
|---|---|---|---|---|
| `_vid` | 21 | **先頭から不一致** | **完全一致** | 不一致 |
| デスクトップ | 17 | **先頭から不一致** | **完全一致** | 一致 |
| `01.-feel-myself` | 11 | 一致 | 一致 | 一致 |

このため本設計は 2 段構成とする（§10）。Phase 1（自然順比較の導入）は Explorer 窓の有無に関係なく効き、Phase 2 のフォールバック経路そのものにもなる。

## 1. 現状分析（コードの事実）

1. **並び順は Rust 側で固定**。`commands/file.rs:59` の `images.sort_by(|a, b| a.filename.cmp(&b.filename))` のみ。フロントは受け取った配列順をそのままナビゲーション順・サムネイルバー順に使う（`store/index.ts:442,464`、`ThumbnailBar.tsx:80`）。**並び替えの責務は Rust に一元化されている**ため、変更点はここ 1 箇所に閉じる。
2. **`folder.sortOrder` は死にフィールド**。`src/types/index.ts:63,110` に `"name" | "date"` として定義されているが、`store/index.ts:123,190` で常に `"name"` を書き込むだけで読み出し箇所が無い。テスト・ファクトリ 5 箇所（`src/utils/testFactories.ts:75,108`、`src/utils/testUtils.tsx:86`、`src/components/__tests__/ImageViewer.test.tsx:85`、`src/store/__tests__/index.test.ts:41,81`）が参照している。
3. **`ImageInfo` に作成日時が無い**。`commands/file.rs:14-20` は `path / filename / size / modified / format`。`get_image_info`（`file.rs:290`）は既に `fs::metadata` を読んでいるので、`created` の追加コストは `metadata.created()` 1 回のみ。
4. **`get_folder_images` は初回描画のクリティカルパス外**。`store/index.ts:631` の呼び出しは、画像パスの `set`（同 610）と `maximize_window`（同 626）の**後**。したがって `open:paint` には影響しないが、**ナビゲーション可能になるまでの時間**とサムネイルバー表示には影響する。
5. **同じコマンドを D&D 経路も使う**（`src/hooks/useFileDrop.ts:46`）。この経路は Explorer 窓と無関係なことが多く、フォールバックが常用される。
6. **起動時にソート情報は渡ってこない**。`get_startup_file`（`file.rs:86`）は `std::env::args()` から画像パスを拾うだけ。関連付け起動でも渡るのはパスのみで、順序は自力で再導出するしかない。
7. **`windows` crate は既に依存にある**が features は `Win32_Storage_FileSystem` / `Win32_Foundation` のみ（`src-tauri/Cargo.toml`）。必要な `StrCmpLogicalW` / `IShellWindows` / `IFolderView2` / `SORTCOLUMN` / `SID_STopLevelBrowser` は **windows 0.62.2 に全て存在する**ことを確認済み。
8. **CI は `ubuntu-latest` で `cargo test --lib` を実行する**（`.github/workflows/ci.yml:18,47,67`）。Windows 専用 API は `#[cfg(windows)]` 分岐が必須で、**CI green は Explorer 一致を保証しない**（§7）。

## 2. ゴール / 非ゴール

**ゴール**

- **G1**. 画像を開いた時点で、その画像が属するフォルダを Explorer が表示しているソート設定（キー＋昇降）を取得し、アプリ内のナビゲーション順とサムネイルバーの並びを一致させる
- **G2**. Explorer 設定を取得できない場合も、Explorer の「名前」順（自然順・大小文字無視）と一致する並びにする。§0 の既存ズレを解消する
- **G3**. 取得失敗・異常時に機能が止まらない。COM 由来の失敗は必ずフォールバックに落ち、画像表示とナビゲーションは常に成立する
- **G4**. 既存の性能ゲート（TTFI_cold / NAV_warm / NAV_rapid / NAV_visible）を p95 の揺れを超えて悪化させない

**非ゴール**

- グループ化（`GetGroupBy`）の表示順再現（§9 R3）
- 開いた後の Explorer 側の設定変更への追従。**開いた時点のスナップショット**とする
- アプリ内ソート UI・設定の永続化（D4）
- 撮影日時（EXIF）ソート（D3）
- Explorer の「種類」列の完全一致。ローカライズされた種類名ではなく拡張子で近似する（§9 R4）
- Windows 以外のプラットフォームでの Explorer 連動（そもそも対象外。ただしコンパイルとテストは通す）

## 3. ユーザー決定事項（2026-08-28 承認済み）

| # | 決定 | 採用 | 代替（不採用） |
|---|---|---|---|
| **D1** | **スコープ**: 自然順ソート修正（Phase 1）と Explorer 連動（Phase 2）の両方を 1 つの要件書に含める | **採用**。Phase 1 は Phase 2 のフォールバック経路そのものであり、どちらにせよ必要 | どちらか一方のみ |
| **D2** | **取得方式**: `GetSortColumns` で「キー＋昇降」だけを 1 回取得し、並べ替えは Rust 側で行う | **採用**。COM 往復がファイル数に依存せず（warm 12ms）、アプリのファイル列挙（`WalkDir`）と一貫する | `GetItem(i)` で表示順を直読み（§4 案 B） |
| **D3** | **対応ソートキー**: 名前・サイズ・更新日時・作成日時・種類。`ImageInfo` に `created` を追加。未対応キーは名前昇順にフォールバック | **採用**。`fs::metadata` だけで賄える範囲に留める | 名前・サイズ・更新日時のみ / 撮影日時（EXIF）まで含める |
| **D4** | **設定 UI**: 追加しない。常に自動追従（取得できれば Explorer 順、できなければ名前昇順） | **採用**。現在のアプリに設定永続化の仕組みが無く、新規サブシステムを作らずに済む | アプリ内ソート切替 UI / 追従 ON/OFF トグル |

## 4. 検討した方式

- **案 A（採用）: ソートキーを COM で 1 回取得し、Rust で自前ソート**。`IShellWindows` → `IShellBrowser` → `IFolderView2::GetSortColumns` で `SORTCOLUMN`（PROPERTYKEY + 昇降）を取得し、`Vec<ImageInfo>` を Rust 側で並べ替える。COM 往復は 1 回でファイル数に依存しない。アプリ側のファイル列挙結果に対して並べ替えるため、隠しファイルの扱いが Explorer の表示設定に左右されない。
- **案 B: `IFolderView2::GetItem(i)` で表示順を直読み**。理論上はグループ化を含めて完全再現できるが、**不採用**。理由は 3 つ。(a) 実測で**同一フォルダを開いた 2 窓が異なる順序を返した**（付録 A）ため、返る順が表示順である保証がない。(b) ファイル数ぶんの COM 往復が必要で、1722 件のフォルダでは実用的でない。(c) Explorer が非表示にしているファイルは含まれず、アプリの `WalkDir` 列挙結果と件数が食い違う。
- **案 C: レジストリの ShellBags を読む**。`HKCU\...\Shell\Bags\<N>\Shell\{GUID}` の `Sort` バイナリ値を解析する案。**不採用**。ソート設定は生きているビューのメモリ上にあり、レジストリの値は古くなる（先行事例では対象フォルダの最終書き込みが 1 か月以上前）。加えてフォーマットが非公開で Windows バージョン間の互換性が無い。

## 5. 全体像と不変条件

処理の流れ（`get_folder_images` 内で完結する）:

```
get_folder_images(path)
  ├─ [並行 A] WalkDir でファイル列挙 → rayon で get_image_info（既存）
  └─ [並行 B] 専用スレッド: CoInitializeEx → Explorer 問い合わせ → Option<SortSpec>
        ↓ join（上限 300ms）
     sort_images(&mut images, spec.unwrap_or_default())   // 既定 = Name 昇順
        ↓
     Vec<ImageInfo>（並び順そのものが答え）
```

**不変条件**

- **I1**. 並び順は決定的。同値時は必ず名前（自然順）をタイブレーカにする。これが無いと同サイズ・同時刻のファイルで順序が不定になり、ナビゲーションとプリロード窓が安定しない
- **I2**. COM 由来の失敗はエラーではなく `None`。`get_folder_images` は COM の失敗理由でエラーを返さない（G3）
- **I3**. Explorer 問い合わせは Rust 内で完結し、フロントは並び順を受け取るだけ。フロントに COM の概念を漏らさない
- **I4**. 非 Windows でもコンパイル・`cargo test --lib` が通る（§1 の 8）

**層の分離**（COM をテスト可能な境界の外に追い出す）

| 層 | 場所 | 責務 | テスト |
|---|---|---|---|
| 比較器 | `src-tauri/src/utils/natural_sort.rs`（新規） | 自然順比較。Windows は `StrCmpLogicalW`、それ以外は純 Rust 代替 | ユニット可 |
| ソート適用 | `src-tauri/src/commands/file.rs`（純粋関数 `sort_images`） | `SortSpec` + `Vec<ImageInfo>` → 並べ替え | ユニット可 |
| Explorer 問い合わせ | `src-tauri/src/commands/explorer_sort.rs`（新規・`#[cfg(windows)]`） | COM で `Option<SortSpec>` を返すだけ | 手動検証（§7.3） |

## 6. 設計詳細

### 6.1 自然順比較（新規 `src-tauri/src/utils/natural_sort.rs`）

```rust
/// Explorer の「名前」列と同じ順序でファイル名を比較する。
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering;
```

- **Windows**: `StrCmpLogicalW`（`windows::Win32::UI::Shell`）に委譲。実測で Explorer と完全一致（§0）。UTF-16 への変換と NUL 終端が必要
- **非 Windows**: 純 Rust の自然順代替（数字列を数値として比較、それ以外は大小無視 → 同値なら大小区別で決定的に）。**CI をコンパイル・実行可能にするためだけの実装**で、Explorer 一致を保証しない

> Windows には「File Explorer で数値による並べ替えを無効にする」ポリシーが存在する（`HKCU`(または `HKLM`)`\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer` の DWORD `NoStrCmpLogical` = 1）。有効な環境では Explorer が桁単位の比較（`111 < 22 < 3`）に切り替わるため一致しなくなるが、既定（未設定 = 0）は自然順であり、対応しない（§9 R6）。

### 6.2 ソート適用（`src-tauri/src/commands/file.rs`）

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey { Name, Size, Modified, Created, Type }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SortSpec { pub key: SortKey, pub descending: bool }

impl Default for SortSpec { /* Name, descending: false */ }

/// 純粋関数。COM に依存しない = ユニットテスト可能。
pub fn sort_images(images: &mut [ImageInfo], spec: SortSpec);
```

比較規則:

| `SortKey` | 一次キー | 備考 |
|---|---|---|
| `Name` | `natural_cmp(a.filename, b.filename)` | |
| `Size` | `a.size.cmp(&b.size)` | |
| `Modified` | `a.modified.cmp(&b.modified)` | |
| `Created` | `a.created.cmp(&b.created)` | §6.5 |
| `Type` | `natural_cmp(a.format, b.format)` | 拡張子による近似（§9 R4） |

- `descending` が真なら一次キーの結果を反転する
- **タイブレーカ**: 一次キーが `Equal` の場合は常に `natural_cmp(filename)` の**昇順**（`descending` の影響を受けない）。Explorer も同値時は名前順にフォールバックする（I1）
- `get_folder_images`（`file.rs:33`）の末尾 `images.sort_by(...)` を `sort_images(&mut images, spec)` に置き換える

### 6.3 Explorer 問い合わせ（新規 `src-tauri/src/commands/explorer_sort.rs`、`#[cfg(windows)]`）

```rust
/// 対象フォルダを表示している Explorer のタブを探し、そのソート設定を返す。
/// 見つからない・失敗した場合は None（呼び出し側は Name 昇順にフォールバック）。
pub fn detect_sort_spec(folder: &Path, foreground_hwnd: Option<HWND>) -> Option<SortSpec>;
```

**手順**

1. `CoCreateInstance(ShellWindows)` → `IShellWindows`
2. `Count()` / `Item(i)` で各エントリを列挙 → `IDispatch`
3. `IUnknown_QueryService(SID_STopLevelBrowser, IID_IShellBrowser)` → `IShellBrowser`
4. `QueryActiveShellView()` → `IShellView` → QI `IFolderView2`
5. `IFolderView2::GetFolder(IID_IPersistFolder2)` → `GetCurFolder()` → `SHGetPathFromIDListW` で**現在のフォルダの実パス**を得る
   - `IWebBrowser2::LocationURL` は `%20` エスケープや UNC（`file://polaris/another`）の形式差があるため使わない。PIDL 経由が正確
6. 対象フォルダと比較（大小文字無視・末尾セパレータ正規化）して候補を収集
7. `IFolderView2::GetSortColumnCount()` → `GetSortColumns()` で先頭 1 件の `SORTCOLUMN` を取得し、付録 B の対応表で `SortSpec` に写像

**複数候補の解決**（実測で `Downloads` が 2 窓あり、順序も異なっていた）

1. プロセス起動直後に退避した `GetForegroundWindow()` と同じ HWND のエントリ
2. 無ければ `IShellWindows` の列挙順で最初にマッチしたもの
3. 候補ゼロなら `None`

**実装上の注意**

- **配列パラメータのマーシャリング**: `GetSortColumns` は `SORTCOLUMN*` を受け取る。COM では配列既定が `SAFEARRAY` になる言語バインディングがあり、検証時はこれが原因で `E_INVALIDARG` が返った（付録 A）。Rust では `&mut [SORTCOLUMN]` がポインタとして渡るため問題ないが、**vtable の順序が `GetSortColumnCount` → `SetSortColumns` → `GetSortColumns` である**点に注意（SDK ヘッダ `ShObjIdl_core.h` で確認済み。誤ると `SetSortColumns` を呼んでユーザーの Explorer の並びを書き換えてしまう）
- **COM の初期化**: Tauri のスレッドと衝突させないため、専用スレッドで `CoInitializeEx(COINIT_APARTMENTTHREADED)` してから実行し、終了時に `CoUninitialize`
- **タイムアウト**: `mpsc::recv_timeout(300ms)` で待ち、超過したら `None` にフォールバック。COM 呼び出しはキャンセルできないためスレッドはデタッチしたままにする
- 非 Windows 向けには `detect_sort_spec` が常に `None` を返すスタブを用意する（I4）

### 6.4 `src-tauri/Cargo.toml`

最終形（Phase 2 完了時）:

```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.62", features = [
  "Win32_Storage_FileSystem", "Win32_Foundation",  # 既存
  "Win32_UI_Shell",            # Phase 1: StrCmpLogicalW / Phase 2: IShellWindows / IFolderView2 / SORTCOLUMN / SID_STopLevelBrowser
  "Win32_UI_Shell_Common",     # Phase 2: ITEMIDLIST
  "Win32_System_Com",          # Phase 2: CoCreateInstance / IDispatch
  "Win32_System_Variant",      # Phase 2: VARIANT（IShellWindows::Item）
] }
```

**Phase 1 で追加するのは `Win32_UI_Shell` のみ**（`StrCmpLogicalW` に必要）。残る 3 つは Phase 2 で追加する。

`Win32_UI_Shell` は大きなモジュールのため、**ビルド時間への影響を実測する**（§8）。既知の事情として、最終クレートの LLVM 最適化がビルド時間を支配している。

### 6.5 フロント（型のみ・振る舞いの変更なし）

- `ImageInfo` に `created: u64` を追加（`src-tauri/src/commands/file.rs:14`、`src/types/index.ts:1`）
  - `get_image_info`（`file.rs:290`）で `metadata.created()` を読む。**取得できない環境では `modified` の値で代替する**（Linux では作成時刻が取れないことがあり、`?` で伝播させると CI が落ちる）
- **`folder.sortOrder` を削除**（`src/types/index.ts:63,110`、`src/store/index.ts:123,190`）。読み出し箇所が無い死にフィールドであり、実際の並びは Rust が決めるため誤解を生む。参照している 5 箇所のテスト・ファクトリも合わせて更新
- `get_folder_images` の**戻り値は `Vec<ImageInfo>` のまま**。並び順そのものが答えなので、呼び出し側（`src/store/index.ts:631`、`src/hooks/useFileDrop.ts:46`）は無変更
- 採用したソート由来（`explorer` / `fallback`）とキーは `SPICA_PERF=1` の Rust ログにのみ出す（D4 により UI には出さない）

## 7. テスト

### 7.1 ユニットテスト（`cargo test --lib`、CI で実行）

`natural_sort`:

| ケース | 期待 |
|---|---|
| `img2.jpg` < `img10.jpg` | 数字列を数値として比較 |
| `IMG_1.jpg` と `img_2.jpg` | 大小文字を無視して順序が決まる |
| `01.jpg` < `2.jpg` | ゼロ埋めの扱い |
| 日本語ファイル名を含む集合 | パニックしない・決定的 |
| 同一文字列 | `Equal` |

`sort_images`:

| ケース | 期待 |
|---|---|
| 5 キー × 昇順/降順 | 一次キーどおりに並ぶ |
| サイズ同値・更新日時同値 | **名前昇順**のタイブレーカが効く（降順指定でもタイブレーカは昇順） |
| 空・1 件 | パニックしない |
| 既存 `test_get_folder_images_with_valid_folder`（`file.rs:402`） | `image1/2/3` は自然順でも同順なので**そのまま green** |

Windows 限定テスト（`#[cfg(windows)]`）: `StrCmpLogicalW` 経路が上記契約を満たすことを確認する。

### 7.2 CI の限界（要件として明記）

CI は `ubuntu-latest`（`.github/workflows/ci.yml:18,47`）なので、**CI が green でも Explorer との一致は検証されていない**。非 Windows では純 Rust 代替が走り、COM 層はスタブになる。Explorer 一致は §7.3 の手動チェックリストで担保する。

### 7.3 手動検証チェックリスト（Phase 2 の受け入れ条件）

検証スクリプトを `scripts/explorer-sort-probe/` に置き、以下を各項目 1 回ずつ確認する:

1. 名前昇順のフォルダ → アプリの並びが Explorer と一致
2. **サイズ降順**のフォルダ → 一致（付録 A の `@lo` が該当）
3. 更新日時降順 / 作成日時昇順 → 一致
4. Explorer 窓を閉じてから関連付け起動 → 名前昇順にフォールバックし、エラーが出ない
5. **同一フォルダを別ソートで 2 窓開き**、手前の窓から開く → 手前の窓の設定が採用される
6. バックグラウンドタブのフォルダから開く → そのタブの設定が採用される
7. D&D で開く → フォールバックし、エラーが出ない
8. グループ化が有効なフォルダ → ソートキーのみ適用され、エラーが出ない（既知の制限）
9. アプリを管理者権限で起動 → フォールバックし、エラーが出ない

### 7.4 E2E

既存の E2E は並び順に依存しているため、Phase 1 で並びが変わった場合は fixture の期待値を更新する。視覚ゲートを含め green を維持する。

## 8. 性能・採否ゲート

`get_folder_images` は初回描画のクリティカルパス外（§1-4）だが、ナビゲーション可能になるまでの時間には効くため、CLAUDE.md の規約に従う。

- `npm run bench:build && npm run bench`（N=7、中央値／p95）を実施し `bench-results/baseline.json` と比較する
- **TTFI_cold / NAV_warm / NAV_rapid / NAV_visible が p95 の揺れを超えて悪化していないこと**（本件は改善を狙う変更ではないため「10% 以上改善」の条件は適用せず、非悪化をゲートとする）
- `npm test` と `cd src-tauri && cargo test --lib` が全件 green
- `npm run test:e2e`（視覚ゲート含む）が green
- **`tauri build` の所要時間を Phase 1 / Phase 2 それぞれの前後で実測**し、features 追加による増分を記録する（Phase 1 で `Win32_UI_Shell`、Phase 2 で COM 系 3 つを足すため、増分は 2 回に分かれる）
- COM 問い合わせはフォルダ走査と並行実行し、`SPICA_PERF=1` のログに所要時間を出す。**cold 77ms / warm 12ms**（付録 A）が実測の基準値

## 9. リスクと対策

| # | リスク | 対策 |
|---|---|---|
| **R1** | 対象フォルダを表示している Explorer 窓が存在しない（窓を閉じた・D&D・ファイルダイアログ・検索結果ビュー・ライブラリ表示） | 名前昇順にフォールバック（I2）。Phase 1 により、この経路でも Explorer の名前順とは一致する |
| **R2** | 同じフォルダを別ソートで開いた窓が複数ある | 起動時の foreground HWND を優先し、次に列挙順の先頭（§6.3）。それでも取り違える可能性は残るが、フォールバックより実害は小さい |
| **R3** | グループ化が有効な場合、表示順はグループ順になりソートキーだけでは再現できない | **既知の制限として明記**。ソートキーのみ適用する。`GetGroupBy` の結果は `SPICA_PERF` ログに記録し、後日の判断材料にする |
| **R4** | 「種類」列は Explorer がローカライズされた種類名で並べるため、拡張子近似では一致しないことがある | 既知の制限として明記。対象が画像 4 形式に限られるため実害は小さい |
| **R5** | アプリが管理者権限で起動されると、整合性レベルの差で Explorer への COM 呼び出しが失敗する | フォールバック（I2）。手動チェックリスト項目 9 で確認 |
| **R6** | `NoStrCmpLogical` ポリシー（§6.1）が有効な環境では Explorer が桁単位比較になり、`StrCmpLogicalW` と一致しない | 非対応。既定は未設定（= 自然順）であり、対応するとレジストリ読み取りが増える。必要になれば `natural_cmp` 内でポリシーを見て `StrCmpW` に切り替えれば済む |
| **R7** | Explorer は隠しファイルを表示設定で隠すが、アプリは `WalkDir` で全件拾うため件数が食い違う | 既知の制限として明記。アプリは常に全画像を対象にする（案 A を選んだ帰結） |
| **R8** | COM 呼び出しが固まりフォルダ表示が遅延する | 専用スレッド + 300ms タイムアウト（§6.3）。フォルダ走査と並行実行するため通常は完全に隠れる |
| **R9** | `Win32_UI_Shell` feature 追加でビルド時間が増える | §8 で実測。許容できない増加なら feature の絞り込みを検討する |
| **R10** | vtable 順序を誤ると `SetSortColumns` を呼び、**ユーザーの Explorer の並びを書き換えてしまう** | SDK ヘッダで確認済みの順序（§6.3）をコードコメントに明記し、`SetSortColumns` は束縛自体を定義しない |
| **R11** | Phase 1 で並び順が変わり、既存の E2E / スナップショットが落ちる | §7.4。期待値を更新する |

## 10. 実装フェーズ

各フェーズ = 1 ブランチ / 1 PR = 1 つの実装プラン。次フェーズのプランは前フェーズの結果を見てから書く。

### Phase 1: 自然順ソートとソート層の分離（COM なし）

- `utils/natural_sort.rs` 新規（Windows: `StrCmpLogicalW` / その他: 純 Rust 代替）
- `SortKey` / `SortSpec` / `sort_images` を `commands/file.rs` に追加し、`file.rs:59` を置き換える
- `ImageInfo` に `created` を追加（Rust / TS 両方）
- `folder.sortOrder` を削除（参照 5 箇所を更新）
- `Cargo.toml` に `Win32_UI_Shell` を追加
- **単体で価値がある**: Explorer 窓の有無に関係なく、名前順のズレ（§0）が解消される
- 受け入れ: §7.1 のユニットテスト、§8 の非悪化ゲート

### Phase 2: Explorer 連動

- `commands/explorer_sort.rs` 新規（COM・窓選択・タイムアウト・非 Windows スタブ）
- `get_folder_images` でフォルダ走査と並行して問い合わせ、結果を `sort_images` に渡す
- 起動時 foreground HWND の退避
- 検証スクリプトを `scripts/explorer-sort-probe/` に整理
- 受け入れ: §7.3 の手動チェックリスト全項目、§8 の非悪化ゲート、`tauri build` 時間の記録

## 11. 関連ファイル

**変更**

- `src-tauri/src/commands/file.rs` — `ImageInfo`（14）、`get_folder_images`（33）、`get_image_info`（290）、既存テスト（402〜）
- `src-tauri/Cargo.toml` — `windows` features
- `src/types/index.ts` — `ImageInfo`（1）、`AppState.folder`（63）、`FolderState`（110）
- `src/store/index.ts` — `folder` 初期値（123）、`setFolderImages`（190）
- `src/utils/testFactories.ts`（75, 108）、`src/utils/testUtils.tsx`（86）、`src/components/__tests__/ImageViewer.test.tsx`（85）、`src/store/__tests__/index.test.ts`（41, 81）

**新規**

- `src-tauri/src/utils/natural_sort.rs`
- `src-tauri/src/commands/explorer_sort.rs`
- `scripts/explorer-sort-probe/`

**参照のみ（変更しない）**

- `src/hooks/useFileDrop.ts:46`、`src/store/index.ts:631` — `get_folder_images` の呼び出し側
- `src/components/ThumbnailBar.tsx`、`src/hooks/useImagePreloader.ts` — 配列順の消費者

## 付録 A: 実機検証の記録（2026-08-28、Windows 11 Home 10.0.26200）

C# の COM プローブを PowerShell から実行し、開いていた Explorer の全ウィンドウ／タブを走査した。

**A.1 チェーン全段の成否**

```
QI(IServiceProvider)=0x00000000  QueryService=0x00000000  QueryActiveShellView=0x00000000
QI(IFolderView2)=0x00000000      GetSortColumnCount=0x00000000 count=1  GetSortColumns=0x00000000 sizeof=24
```

10 エントリ全てで成功。HWND は 4 種類（2164852 / 1705394 / 13043004 / 108005836）で、**1 つの HWND が複数のタブぶんのエントリを返す**。

**A.2 タブごとに異なるソート設定が返る**

| フォルダ | `GetSortColumns` | 解釈 | `GetGroupBy` |
|---|---|---|---|
| ほとんどのタブ | `{B725F130-47EF-101A-A5F1-02608C9EEBAC},10 dir=1` | 名前 昇順 | なし |
| `Downloads/@video/@twitter/@lo` | `{B725F130-…},12 dir=-1` | **サイズ 降順** | `pid=14`（更新日時） |
| `Downloads` | `{B725F130-…},10 dir=1` | 名前 昇順 | `pid=14`（更新日時） |

**A.3 並び順の照合**（`GetItem(i)` で取得した順と、ローカル計算の順を比較）

| フォルダ | ファイル数 | 序数比較 | `StrCmpLogicalW` | 大小無視の文化圏比較 | サイズ降順か |
|---|---|---|---|---|---|
| `_vid` | 21 | `DIFF@0` | **`MATCH`** | `DIFF@0` | — |
| デスクトップ | 17 | `DIFF@0` | **`MATCH`** | `MATCH` | — |
| `01.-feel-myself` | 11 | `MATCH` | `MATCH` | `MATCH` | — |
| `@lo` | 45 | `DIFF@0` | `DIFF@0` | `DIFF@0` | **True** |
| `Downloads`（グループ化有効） | 946 | `DIFF@0` | `DIFF@0` | `DIFF@0` | False |

- サイズ降順タブでは `GetItem(i)` の順が実際にサイズ降順（53173803 → 37294437 → … → 4593273）
- **グループ化が有効な `Downloads` はどの単純ソートとも一致しない**（§9 R3 の根拠）
- **同一の `Downloads` フォルダを開いた 2 窓が異なる `GetItem` 順を返した**（§4 案 B 不採用の根拠）

**A.4 コスト**

全 10 ウィンドウを走査し `GetSortColumns` まで実行した所要時間: 77.1ms（1 回目、COM 初期化含む） / 11.9 / 13.0 / 12.6 / 11.5ms。

**A.5 検証中に踏んだ罠**

- `GetSortColumns` が `E_INVALIDARG` を返した。原因は **COM の配列パラメータ既定マーシャリングが `SAFEARRAY`** であること。生ポインタ渡しに変更して解決した（§6.3）
- 「`GetSortColumns` は常に `PKEY_ItemNameDisplay` を返す」という先行報告があるが、**この環境では再現しなかった**。上記のマーシャリング問題か、対象ビューの取り違えが原因と思われる

## 付録 B: PROPERTYKEY → `SortKey` 対応表

`fmtid = {B725F130-47EF-101A-A5F1-02608C9EEBAC}` は Windows のシステムプロパティ。`direction` は `1` = 昇順 / `-1` = 降順。

| PROPERTYKEY | 名称 | `SortKey` |
|---|---|---|
| `{B725F130-…}` pid 10 | `PKEY_ItemNameDisplay`（名前） | `Name` |
| `{B725F130-…}` pid 12 | `PKEY_Size`（サイズ） | `Size` |
| `{B725F130-…}` pid 14 | `PKEY_DateModified`（更新日時） | `Modified` |
| `{B725F130-…}` pid 15 | `PKEY_DateCreated`（作成日時） | `Created` |
| `{B725F130-…}` pid 4 | `PKEY_ItemTypeText`（種類） | `Type`（拡張子で近似） |
| `{14B81DA1-0135-4D31-96D9-6CBFC9671A99}` pid 36867 | `PKEY_Photo_DateTaken`（撮影日時） | **未対応** → `Name` 昇順 |
| 上記以外 | — | **未対応** → `Name` 昇順 |
