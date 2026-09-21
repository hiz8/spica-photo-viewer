# Explorer 起動時に Spica が背面に出てクリックでも前面化しない問題 — 調査・修正計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** エクスプローラーのダブルクリック起動で Spica がエクスプローラーの背面に表示され、Spica をクリックしても前面化しない事象について、PR #310 で失われた「起動 ~500ms 後の 2 回目のアクティブ化」を安全な形で復元し（§1.4、確定した回帰機構）、あわせて次の再現時に「最初のアクティブ化が取り消される原因」と「クリックで前面化しない原因」を一意に特定できる証拠を採取できるようにする。

**Architecture:** アプリ側は前面化 API を一切呼んでおらず、tao の `ShowWindow` 時の OS 判定に全面依存している（§1.1）。PR #310 以前は、フロントエンドが起動 ~500ms 後に呼ぶ `maximize_window` が `ShowWindow(SW_MAXIMIZE)` となり、最初のアクティブ化が取り消されていても前面化をやり直す機会になっていた。PR #310 でウインドウが最初から最大化で生成されるようになった結果、同じ呼び出しは tao の `apply_diff` で no-op になり、やり直しが消えた（§1.4）。修正は (C1) 起動ファイルありの起動に限り、`run_start` から 1.5 秒以内・最大 2 回だけ `SetForegroundWindow` で前面を再主張する（前面が奪われた `Focused(false)` も契機に含める。OS が拒否すべき状況では OS が拒否するので、ユーザー操作を奪わない）。並行して (A) 再現時の OS 状態を外部から採取する読み取り専用スクリプトと、アプリ内の前面状態トレース（SPICA_PERF のファイル出力）を整備し、(B) 仮説ごとの判別条件を固定する。(C3) 起動時ソートプローブの遅延は、A2 の証拠で必要と判ったときだけ 1 コミット 1 仮説で試す。

**Tech Stack:** Rust (tauri 2.11 / tao 0.35 / wry 0.55, `windows` crate 0.62), PowerShell 5.1 (診断スクリプト), vitest / cargo test。

**Spec:** 未作成。根本原因が未確定のため、本計画 §1–§3 が現時点の根拠。原因が確定した時点で `docs/superpowers/specs/2026-09-20-explorer-launch-foreground-design.md` に設計を起こし、§3 の採用仮説を反映する。

## Global Constraints

- `npm test` と `cd src-tauri && cargo test --lib` が全件 green でないとコミットしない（CLAUDE.md）。
- Rust は `cargo fmt --check` と `cargo clippy --all-targets -- -D warnings` が CI ゲート（ubuntu ジョブ）。`#[cfg(windows)]` 外のコードにも dead code 警告を出さないこと。
- コメントは Why のみ。ラベル付き根拠は `docs/code-rationale.md` に定義を置く。
- tao の `Window::set_focus()` は **使わない**（§2 H2 参照。前面化に失敗すると `force_window_active` が合成 ALT キー入力を前面アプリ＝エクスプローラーへ送る。これは今回の症状そのものを引き起こしうる副作用）。
- `SetForegroundWindow` の再主張は起動ファイルありの起動に限り、`run_start` から 1500ms 以内・最大 2 回。それ以外のタイミング（通常操作中）で前面を奪わない。
- 診断スクリプトは読み取り専用（ウインドウの操作・入力送信をしない）。

---

## §1 調査で確定した事実

### 1.1 アプリは前面化を一切制御していない

- リポジトリ内に `set_focus` / `SetForegroundWindow` / `AllowSetForegroundWindow` / `set_always_on_top` / `startDragging` / `data-tauri-drag-region` の呼び出しは無い。Win32 呼び出しは `commands/window.rs`（ウインドウ化のための placement 操作）と `commands/explorer_sort.rs`（`GetForegroundWindow` の読み取りと Shell COM）のみ。
- フロントエンドにフォーカス/blur のリスナは無い。画像上の `mousedown` は `e.preventDefault()` でパン開始するだけで、ウインドウ操作は行わない（`src/components/ImageViewer.tsx:639-650`）。
- メインウインドウは `tauri.conf.json` で `create: false`、`src-tauri/src/lib.rs:59-65` の `setup` で `.maximized(true)` 付きで生成。tao はこのとき `ShowWindow(SW_MAXIMIZE)` → `ShowWindow(SW_SHOW)` を呼ぶだけで（`tao-0.35.3/src/platform_impl/windows/window_state.rs:325-385`）、`force_window_active`（ALT ハック）は fullscreen 指定時にしか呼ばれない（同 `window.rs:1338-1343`）。
- したがって「前面に出るかどうか」は、ShowWindow 時点で **プロセスが前面化権を持っているか**（エクスプローラー＝前面プロセスから起動されたので本来は持つ。ただし「次にユーザーが他プロセスへ入力すると失効」する）に完全に依存する。

### 1.2 起動タイムライン（ローカル 3000 枚フォルダ、warm cache、本機で計測）

`SPICA_PERF=1` で release exe を直接起動（`scripts/diagnose-foreground.ps1` と並走）した結果:

| 時点 | 経過 |
|---|---|
| run_start | 0 ms |
| prefetch_start / folder_scan_start | 14–18 ms |
| folder_scan_end（n=3000、walk 5ms、probe_wait 136ms） | 165 ms |
| window_created（tao 表示 + WebView2 初期化完了） | 291 ms |
| page_load_finished | 334 ms |
| get_startup_file（sync コマンド、thumb hit） | 355 ms |

- 3000 枚ローカルでは、メインスレッドの `WM_NULL` 往復は常時 0.1–0.3 ms（応答停止なし）、`IsHungAppWindow=false`、`WS_EX_NOACTIVATE` / `WS_EX_TOPMOST` / `WS_DISABLED` いずれも無し。**ローカルの大量枚数だけでは背面化もクリック無視も再現しない。**
- 起動元が前面でない PowerShell からの起動でも Spica は即座に前面になった（ユーザー入力が直前に無かったため OS が許可した）。ユーザー報告の「背面」には、ダブルクリック直後の追加入力か、エクスプローラー側の再前面化が絡んでいる可能性が高い。
- ユーザー環境ではエクスプローラーが UNC パス（`\\polaris\...`）のタブを開いていた。ネットワークフォルダではフォルダ走査・Shell COM プローブ（300ms 予算）・エクスプローラー自身のサムネイル処理が長引き、「初期表示に時間がかかるときに出やすい」観察と整合する。

### 1.3 tao / wry の該当実装（バージョン固定の事実）

- `tao::Window::set_focus()` → 前面でなければ `force_window_active`: `SetForegroundWindow` 失敗時に `SendInput` で **左 ALT の押下・解放を合成**してから再試行（`tao-0.35.3/src/platform_impl/windows/window.rs:1500-1527`）。エクスプローラーは ALT 単押しでメニュー/キーヒントモードに入り、そのスレッドがマウスキャプチャを持つ間、他ウインドウへのクリックが食われる。**現状このパスは呼ばれていない**が、修正で `set_focus()` を安易に使うと症状を作り込む。
- wry は WebView2 生成直後に `controller.MoveFocus(PROGRAMMATIC)` を呼ぶ（`wry-0.55.1/src/webview2/mod.rs:546-548`）。これはキーボードフォーカスのみで前面化ではない。
- `SetForegroundWindow` は呼び出し側と対象が別入力キューのとき **非同期**で、対象スレッドがメッセージを処理して初めて実際の activate が起きる（Raymond Chen, 2016-11-18）。エクスプローラーのスレッドが busy だと、前面切替が遅延したり、その間にエクスプローラー側の後続処理で戻される余地がある。

### 1.4 PR #310（merge 9d6f55c, 2026-09-05）との差分 — 回帰の機構（ソース読解で確定）

ユーザー報告「#310 以降に発生」を受けて `git diff 9d6f55c^1 9d6f55c` を精査した結果、前面化に関わる差分は次の 3 点。

**(a) 起動 ~500ms 後の 2 回目のアクティブ化が消えた（確定）。**

| | PR #310 以前 | PR #310 以後 |
|---|---|---|
| ウインドウ生成 | `create: true`。tauri 内部 `setup()` が config から生成（ユーザー `setup` 直前、`tauri-2.11.5/src/app.rs:2521-2531`）。800×600・非最大化で `ShowWindow(SW_SHOW)` | `create: false`。ユーザー `setup` 内で `.maximized(true)` 付きで生成。`ShowWindow(SW_SHOW)` → `ShowWindow(SW_MAXIMIZE)` |
| 起動 ~500ms 後 | フロント `openImageFromPath` が `maximize_window` を呼ぶ（`src/store/index.ts:683`、現在も同じ）→ tao `set_maximized(true)` → MAXIMIZED フラグが変化 → **`ShowWindow(SW_MAXIMIZE)`（= アクティブ化を伴う）** | 同じ呼び出しだが既に MAXIMIZED なのでフラグ差分なし → `apply_diff` が `diff == empty` で **早期 return、ShowWindow は呼ばれない**（`tao-0.35.3/src/platform_impl/windows/window_state.rs:315-323`） |

`ShowWindow(SW_MAXIMIZE)` は「ウインドウをアクティブ化して最大化表示する」動作で、`SetForegroundWindow` と同じ前面化権の判定を通る。エクスプローラーから起動されたプロセスは「前面プロセスに起動された」ため、ユーザーが他プロセスへ入力しない限りこの権利を保つ。したがって #310 以前は、最初のアクティブ化（起動 ~50–100ms、エクスプローラーがダブルクリック処理中で忙しい時間帯）が取り消されても、~500ms 後に**もう一度前面を取りに行っていた**。#310 以後はこの機会が無く、最初の 1 回で決まる。これが「#310 以降」「初期表示に時間がかかる（＝エクスプローラーが忙しい）ときに出やすい」の両方と整合する。

**(b) Explorer への COM RPC がウインドウ表示と同時に走るようになった（寄与は未確定）。**

#310 以前は `spawn_detect`（`IShellWindows` → `IShellBrowser` → `IFolderView2` のクロスプロセス COM 呼び出し。エクスプローラーの UI スレッドで処理される）が、フロントの `get_folder_images`（ページロード後）で初めて走っていた。#310 以後は `setup` 内の `commands::startup::start()` がウインドウ生成**前**にフォルダ走査スレッドを起動し、その中で `spawn_detect` が走る。§1.2 の計測では `folder_scan_start` 18ms → `folder_scan_end` 165ms（`probe_wait` 136ms）で、`window_created` 291ms の途中、つまり **`ShowWindow` によるエクスプローラーの非アクティブ化処理とエクスプローラー UI スレッドへの RPC が同時進行**する。エクスプローラーが UNC フォルダやサムネイル生成で忙しいとき、RPC の待ち行列と前面切替の非同期処理（§1.3）が絡み、最初のアクティブ化が完了しない・戻されるという経路は否定できないが、証拠はまだ無い。C3 の対象。

**(c) `get_startup_file` が同期コマンドになりメインスレッドで最大 150ms 待つ**（`startup.rs:29` `THUMB_WAIT`）。H3 の候補だが、§1.2 の実測ではメインスレッド応答は 0.1–0.3ms で、150ms の一時停止だけでは「クリックで前面化しない」を説明できない。C2 の対象（証拠が出た場合のみ）。

**(a) が説明しないこと**: 「背面の Spica をクリックしても前面化しない／エクスプローラーを最小化→復元すると直る」。前面化の再試行が無いことは背面に**留まる**理由であって、クリックが効かない理由ではない。当初は §2 の H2/H4/H5 のどれかと見ていたが、2026-09-21 の実機再現（§1.5）で **どれでもない 1 状態** に決まった。

### 1.5 実機再現で確定した状態（2026-09-21、C1 + A2 を含むビルド）

15ms 周期の読み取り専用ウォッチャー（前面 HWND と可視トップレベル窓の z オーダーを変化時のみ記録）と `perf.log` を突き合わせた結果:

| 時点（Spica の窓が現れてから） | 状態 |
|---|---|
| 0 ms（`run_start` +~35ms） | Spica の窓が z の**最上位**かつ**前面** |
| +22〜31 ms | 起動元エクスプローラー窓（`perf.log` の `launcher` と同一 HWND、非最大化・非 topmost）が **前面は取らず z だけ** Spica の上へ。Spica は `is_foreground:true`、`gui_flags 0`、メッセージポンプ正常 |
| +~500 ms | `window_created`（`foreground_is_ours:true`）。W2 の最初の契機だが、前面が自分なので何もしない |
| フォーカスが他へ移るまで | 変化なし（19 秒の採取で不変） |

- 通常起動（同セッション 9〜10 回）ではウォッチャー上ずっと `above=[]`。発生率はウォッチャー稼働中で約 2/12。ローカル・NAS どちらのフォルダでも発生し、フォルダ種別は判別条件にならない。
- **「クリックしても前面化しない」の機構**: この状態では Spica が既にアクティブ（前面）ウインドウなので、クリックしてもアクティブ化が起きず、z も動かない。他アプリへ一度フォーカスを移してからクリックすると、アクティブ化が z も最上位へ戻す（3 回確認）。つまり「前面は自分・z だけエクスプローラーの下」の 1 状態が「背面に出る」と「クリックが効かない」の両方を説明する。
- **Spica 固有。行為者は未確定**（下記「行為者の判別実験」。いったん「プローブが必要条件」と判断したが、実験の条件が発生率の低いものだったので判別力が無く、2026-09-21 夕方に訂正した）: 当初の候補は、エクスプローラー/OS 自身か、+6〜100ms で重なる自前の `explorer_sort` COM 読み取り（IShellWindows、読み取りのみ）が誘発したか、の 2 つだった。対照実験（2026-09-21、ユーザー実施）: `.txt` をメモ帳で 30 回ダブルクリック起動してもエクスプローラーはメモ帳の上に来なかった。日常使用でも Spica 以外でこの事象は見ていない。したがってエクスプローラー/OS の一般挙動である可能性は低く、Spica が起動直後に行う処理のうちエクスプローラーの UI スレッドに届くのは COM プローブだけなので、それが第一容疑。対策 C4 は行為者に依存しない。
- **C4 適用後の実機（2026-09-21、インストール版、20 起動）**: `z_above` = 起動元 HWND が 2 起動、どちらも `window_created` 契機の `z_raise ok:true` 1 回で解消し、`page_load_finished` での 2 回目は不要だった。`foreground_reassert` は 0 件。発生率 2/20 は修正前（約 2/12）と同程度なので、事象は同じ頻度で起きているが C4 が毎回直している。同じエクスプローラー窓からの 10 起動で 2 回だけ出たので、窓やフォルダの状態ではなくタイミングの競合と見ていた。ただし後の集計（下記「発生条件」）で、発生はフォルダへ移動した直後の最初の起動に強く偏ることが分かった。
- 旧 `maximize_window`（`ShowWindow(SW_MAXIMIZE)`）が z も直していた、というのは**推定**（確定した回帰機構 (a) とは別）。

#### 行為者の判別実験（2026-09-21）

- **実験 A — プローブ単体（コード変更なし）**: Spica は起動せず、`scripts/explorer-sort-probe/probe.ps1 app` と同じバイナリ（`detect_sort_spec` に続けて `get_folder_images` を実行するので、1 実行で起動時と同じ COM 連鎖が 2 回走る）を 3 秒間隔で 30 回実行した。対象は `e2e/fixtures/corpus/medium` を表示したエクスプローラー窓で、その上にメモ帳を重ねて前面にした。実行元はエージェントの背面シェルなので、前面状態は変わらない。30 回すべて `detect_sort_spec => Some(Name 昇順)` を返しており、対象窓まで届いている。メモ帳を対象にした 15ms ウォッチャーは、z オーダーにも前面にも一度も変化を記録しなかった。30 回のうち 27 回はメモ帳が前面で上に何も無い状態、残る 3 回はユーザーの入力で VS Code が前面だった。結果は **0/30**。当初は「発生率が起動時と同じ ~11% なら 27 回続けて出ない確率は ~5%」として、プローブ単体では持ち上がらないと読んだ。しかし同じフォルダ・同じ窓での起動時の発生率は ~3%（下記「発生条件」）なので、27 回出ないのは普通（~44%）で、この実験に判別力は無い。また実際の起動と違い、ここでのエクスプローラーは直前まで前面だった窓でもなく、非アクティブ化の最中でもない。その組み合わせは実験 B で調べる。
- **実験 B — 起動時プローブを止めたビルド（コミット `e1de747`。結果を記録した後で revert した。再検証するときは cherry-pick する）**: `SPICA_NO_SORT_PROBE` が設定されていると、`spawn_detect` は既存の「前のプローブが詰まっている」経路に入る（`tx` を落とし、`join()` が即 None = 名前順）。これをインストールし、ユーザー環境変数に `setx` で設定して、エクスプローラーから 30 回ダブルクリック起動した（ローカルフォルダ、同じエクスプローラー窓）。30 起動すべてで `explorer_sort` が `source:"fallback"`・~1ms なのでスイッチは効いており、`window_created` はすべて `foreground_is_ours:true`、**`z_above` が非 0 の起動は 0/30**。ウォッチャー（対象 = Spica）でも、Spica が前面の行はすべて `above=[]` だった。
- **対照 — 同じビルドでプローブ有効**: 実験 B の直後に環境変数を消し（.NET の User スコープ削除。`WM_SETTINGCHANGE` を投げるのでエクスプローラーが取り直す）、同じ窓・同じ手順で 30 起動した。`explorer_sort` は 30 起動すべて `source:"explorer"`・76〜97ms で、**`z_above` = 起動元は 2/30**。どちらも `window_created` の `z_raise ok:true` 1 回で解消した。ウォッチャーでは、持ち上げは Spica の窓が現れてから +30ms / +32ms、覆われていた時間は 451ms / 468ms（C4 が直すまで）。
- **判定（2026-09-21 夕方に訂正、行為者は未確定）**: 当初は、プローブ有効の累計 7/65（対照 2/30、C4 実機 3/23、C4 前 2/12）とプローブ停止 0/30 を比べて（Fisher 片側 p ≈ 0.06）、「起動時プローブとウインドウ表示の同時進行が必要条件」と判断した。**これは誤り**。累計 7/65 は発生率の大きく違う条件を混ぜている（下記「発生条件」）。実験 B と対照は、同じローカルフォルダを同じ窓から繰り返し起動する条件で行っており、この条件でのプローブ有効は 2/63（~3%）しかない。同じ条件同士で比べると（B 0/30 対 2/63）Fisher 片側 p ≈ 0.46 で、何も言えない。
- **発生条件（2026-09-21 夕方、`perf.log` の `z_above` 付き全起動を集計）**: いつもの窓から、その日まだ起動していない NAS フォルダへ移動して最初に起動した場合は 6/18（33%）、同じフォルダでの 2 回目以降は 0/4。実験用のローカルフォルダを実験用の窓から繰り返し起動した場合は 2/63（3%）。発生はフォルダを移動した直後の最初の起動に強く偏る。エクスプローラーがそのフォルダの列挙やサムネイル処理で忙しい時間帯であり、元報告の「初期表示に時間がかかるときに出やすい」と整合する。フォルダ種別（UNC/ローカル）、窓、直前の起動からの間隔は交絡しており、どれが効いているかは分離していない。
- **C3 の実機 A/B（1 回目、低頻度条件）**: インストール先の exe を C3（`835fd89`）と直前のビルドでブロックごとに入れ替えた（C3 15 → 対照 18 → C3 15 → 対照 15）。フォルダはローカル、窓は実験用。全起動の走査順（`folder_scan_start` が `window_created` の前か後か）で入れ替えを確認した。結果は C3 0/30、対照 0/33 で、対照でも 0 件なので判定不能（Task C3 Step 3 の事前基準）。上記の高頻度条件でやり直す。
- **この実験で切り分けられないこと**: スイッチはエクスプローラーの UI スレッドへの RPC と、Spica 側の COM 処理（プローブスレッドの STA 初期化、`ShellWindows` プロキシの生成）を同時に止める。どちらが引き金かは分からない。プローブを止めると走査スレッドの待ち（`probe_wait`）も消えるが、ウインドウ生成はメインスレッドで進むので表示時刻は変わらない。どの COM 呼び出しの直後に z が動くのか、読み取りしかしない呼び出しがなぜ z を動かすのかという機構も未解明。

## §2 仮説と判別条件

診断スクリプト（Task A1）の出力とアプリ内トレース（Task A2）で、次のどれかに決まる。

| # | 仮説 | 再現時に観測されるはずのこと | 対応 |
|---|---|---|---|
| H1 | ダブルクリック直後の追加入力（2 回目の LBUTTONUP 以降の操作）や起動の遅延で **前面化権が失効**し、ShowWindow が背面表示になった | A2 の `window_created` で `foreground_is_ours=false` かつ `foreground=explorer` のまま。`Focused(true)` が一度も出ない。タスクバーの Spica が点滅 | C1（再主張）。権が失効していれば OS が拒否するので、その場合は起動時間短縮以外に手は無い |
| H2 | エクスプローラーがモーダル状態（メニュー/キーヒントモード、マウスキャプチャ保持）に入り、**Spica へのクリックを食っている** | 診断スクリプトの前面ウインドウ（explorer）の `gui_flags` に `0x4/0x8/0x10` が立つ、または `gui_capture != 0`。エクスプローラー最小化で解消（キャプチャ解放） | アプリ側では回避不能。ALT ハック（`set_focus`）を将来も使わないことを規約化。Windows 側事象として記録 |
| H3 | Spica の **メインスレッドが応答停止**しており、クリックによる activate 通知を処理できない | 診断スクリプトの Spica 行で `pump_ok=false` または `pump_ms` が数百 ms、`hung=true` | 同期コマンド `get_startup_file`（最大 150ms ブロック）を async 化、他のメインスレッド占有を perf ログで特定して排除（C2） |
| H4 | Windows 11 22H2–24H2 で報告されている **エクスプローラーの前面奪取バグ**（背景のエクスプローラーが勝手に前面へ出る）が、起動直後に発火した | A2 で `Focused(true)` → 数百 ms 以内に `Focused(false)`、その時点の前面が explorer で、ユーザー入力は無い | C1 で起動直後 1.5 秒は再主張。ユーザー側の回避策「フォルダーウィンドウを別のプロセスで開く」を手動チェックリストに記載 |
| H5 | 前面はエクスプローラーなのに Spica スレッドのキューでは Spica が active/focus 扱い（wry の `MoveFocus` が非前面状態で走った）で、クリックが「既に active」と判定され前面化を起こさない | 診断スクリプトの Spica 行で `gui_active == spica hwnd` かつ `is_foreground=false` | C1 の再主張で整合が取れるか確認。取れなければ `focused(false)` でウインドウを作り、前面化成功後に `webview.focus()` を呼ぶ順序へ変更 |

## §3 修正方針（採用順）

1. **C1: 起動直後の前面再主張**（§1.4(a) で失われた 2 回目のアクティブ化の復元。H1/H4/H5 を同時にカバー、低リスク）。起動ファイルありのときだけ、`window_created` 直後・`page_load_finished`・`WindowEvent::Focused(false)` の各契機で `GetForegroundWindow() != hwnd` なら `SetForegroundWindow(hwnd)`。`run_start` から 1500ms を過ぎたら、または 2 回試したら何もしない。結果と `GetLastError` を perf ログへ。`maximize_window` を非最大化に戻して旧挙動を再現する案は、#310 の起動高速化（800×600 → 最大化のジャンプ回避）を捨てることになるので採らない。
2. **C3: 起動時ソートプローブの遅延**（§1.4(b)。A2 の `window_created` トレースで `foreground_is_ours:false` が再現時に観測され、かつ C1 の再主張が `ok:false` で拒否される場合のみ）。`startup::start` のフォルダ走査を `window_created` 後に開始する 1 コミットで検証し、`profile-startup.mjs` で起動時間の悪化幅を確認して採否を決める。
3. **C2: メインスレッドの同期ブロック排除**（H3 の証拠が出た場合のみ）。
4. H2 はアプリ側修正なし。証拠が出たら `docs/code-rationale.md` に記録し、`set_focus()` 禁止を規約に残す。
5. **C4: 起動直後の z オーダー是正**（§1.5 で確定した「前面は自分・z だけ下」の状態。W2 と同じ枠内で、前面が自分かつ覆われているとき `SetWindowPos(HWND_TOP, SWP_NOACTIVATE)`。根拠 `docs/code-rationale.md` W3）。C3（プローブ遅延）とは混ぜない（1 コミット 1 仮説）。
6. **起動時プローブをウインドウ表示と重ねない**（2026-09-21 に C3 を実装済み・実機 A/B 中）。提案時は、§1.5 の実験 A/B から「z の持ち上げはプローブと表示が重なったときだけ起きる」と判断していた。この判断は同日夕方に訂正した（A/B に判別力が無かった）。現在は、重なりをなくせば消えるかを C3 自体で確かめる位置づけ。候補は 2 つある。
   - **C3（発動根拠を置き換え）**: フォルダ走査と COM プローブを `window_created` の後に始める（Task C3 の手順のまま）。事象そのものが起きなくなるので、C4 では残る「~0.5 秒エクスプローラーが上に居る」見た目も消える。代償は `folder:scanned` がウインドウ生成の分（本機で ~270〜500ms）遅れること。首枚の paint は走査に依存しない。`e2e/scripts/profile-startup.mjs` で測って採否を決める。事象が消えたかの検証は実験 B と同じ手順（エクスプローラーから 30 起動以上、`z_above` 非 0 が 0 件）で行い、プローブ有効の対照と交互に取る（時間帯による差と混ざらないようにするため）。元の発動条件（`foreground_is_ours:false` かつ C1 が `ok:false`）は一度も観測されていないので、発動の根拠は §1.5 に置き換える。
   - **局所修正**: `entry_at` の各 COM 呼び出し（`Item` / `IUnknown_QueryService` / `QueryActiveShellView` / `GetWindow`）と `current_folder_path` / `read_sort_spec` の間に `perf::phase` を入れた一時ビルドで、ウォッチャーが捉えた持ち上げ時刻の直前の呼び出しを特定し、その呼び出しだけを避けるか遅らせる。起動時間はほぼ変わらない。ただし発生率が ~10% なので特定には 50〜100 起動が要り、特定できる保証も無い。
   - 推奨は C3 を先に試すこと。引き金の呼び出しを特定しなくても同じ指標（0/N）で検証でき、起動時間の代償も測れる。C4 は行為者に依存しないので、どちらを採っても保険として残せる。

実施順は **C1 → A1 → A2 → A3 → C4**（C1 は根拠が確定しており単独で価値があるので先に出す。A1–A3 は C1 で解消しない場合の切り分け用。C4 は A1–A3 の採取結果から決まった）。C4 の後に実験 A/B（§1.5、2026-09-21）を行ったが、発生率の低い条件だったので判別力が無かった。6 の C3 を実装し（`835fd89`）、発生率の高い条件（新しいフォルダへ移動して最初の起動）で実機 A/B を行っている。

---

## §4 タスク

進捗（2026-09-21）: C1 / A1 / A2 / A3 は実装・コミット済み。C1 Step 6 は項目 1 合格、項目 2 は手動では成立しない（窓生成が起動 ~0.2–0.5 秒後で、0.5 秒以内に別アプリをクリックできない）、項目 3 は C4 のビルドで併せて実施。実機再現（§1.5）を受けて C4 を実装済み（実機検証待ち）。C2 / C3 は条件付きのため未着手。行為者の判別実験 A/B（§1.5）を実施した。当初は「起動時プローブが必要条件」と判断したが、発生率の低い条件で行っていて判別力が無かったので訂正した。実験 B のスイッチ（`e1de747`）は、製品に文書化されない環境変数を残さないため revert した。§3 の 6 のうち C3 を実装済み（`835fd89`）で、実機 A/B は 1 回目が判定不能。高頻度条件でやり直している。

### Task A1: 診断スクリプトの整備とコミット

**Files:**
- Modify: `scripts/diagnose-foreground.ps1`（本調査で作成済み。未コミット）
- Modify: `PROJECT_SPEC.md`（トラブルシュート節に 1 段落追加）

**Interfaces:**
- Produces: `scripts/diagnose-foreground.ps1 [-Seconds N] [-IntervalMs M]` — 1 サンプル 1 行の JSON を stdout に出力。先頭行は環境情報、以降は `{t, foreground:{...}, spica:[{..., is_foreground, above:[...]}]}`。

- [ ] **Step 1: 内容を確認する**

スクリプトは調査時に作成済み。`SystemParametersInfoW` の宣言は残っているが未使用（`SPI_GETFOREGROUNDLOCKTIMEOUT` は本機でレジストリ値 200000 に対し 2147483647 を返し信頼できなかったため出力から外した）。宣言行（`SystemParametersInfoW` の 1 行）も削除してよい。

- [ ] **Step 2: 動作確認**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose-foreground.ps1 -Seconds 2 -IntervalMs 500`
Expected: エラーなく 3 行以上の JSON。`foreground.class` が空でなく（例 `CabinetWClass`, `Chrome_WidgetWin_1`）、Spica 起動中なら `spica[]` に `hwnd` / `pump_ms` / `gui_flags` が入る。

- [ ] **Step 3: 使い方を PROJECT_SPEC.md に追記**

「トラブルシュート」相当の節（無ければ末尾に `## トラブルシュート` を新設）に追加:

```markdown
### 起動直後に Spica が他ウインドウの背面に出る / クリックで前面化しない

症状が出ている **その状態のまま** 次を実行し、出力を issue に貼る（読み取り専用、ウインドウを操作しない）:

    powershell -ExecutionPolicy Bypass -File scripts\diagnose-foreground.ps1 -Seconds 10

見るところ: `foreground.proc`（前面のプロセス）、`foreground.gui_flags`（0x4/0x8/0x10 はメニューモード）、`foreground.gui_capture`、`spica[].pump_ms`（メインスレッド応答）、`spica[].gui_active`。
```

- [ ] **Step 4: Commit**

```bash
git add scripts/diagnose-foreground.ps1 PROJECT_SPEC.md
git commit -m "chore(diag): add a read-only foreground state probe for the launch-behind-Explorer report"
```

### Task A2: perf ログのファイル出力と前面状態トレース

エクスプローラー起動では stderr が捨てられるため、`SPICA_PERF_FILE=<path>` が設定されていればそのファイルへ追記する。あわせて `window_created` 時点の前面状態と `Focused` イベントを記録する。

**Files:**
- Modify: `src-tauri/src/utils/perf.rs`
- Modify: `src-tauri/src/commands/explorer_sort.rs:305,315`（`eprintln!` → `perf::emit`）
- Modify: `src-tauri/src/commands/file.rs:182`（同上）
- Modify: `src-tauri/src/commands/window.rs`（`foreground_state` 追加）
- Modify: `src-tauri/src/lib.rs`（`window_created` 直後のトレースと `on_window_event`）
- Test: `src-tauri/src/utils/perf.rs`（`#[cfg(test)] mod tests`）

**Interfaces:**
- Consumes: C1 の `commands::window::foreground_state`、C1 が `lib.rs` に追加した `on_window_event` ハンドラ（`Focused` 分岐にトレースを足す）。
- Produces: `perf::emit(line: String)` — 有効時のみ、`SPICA_PERF_FILE` があればそのファイルへ追記、なければ stderr。`perf::phase` / `PerfTimer` / 既存の `eprintln!` 呼び出しはすべてこれを経由する。
- Produces: perf ログの新フェーズ `window_created`（`,"foreground_is_ours":bool,"foreground":isize,"launcher":isize` 付き）、`focused`（`,"focused":bool`）。

- [ ] **Step 1: 失敗するテストを書く（ファイル追記）**

`perf.rs` の `mod tests` に追加:

```rust
#[test]
fn append_line_creates_and_appends() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("perf.log");
    append_line(&path, "{\"a\":1}");
    append_line(&path, "{\"b\":2}");
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text, "{\"a\":1}\n{\"b\":2}\n");
}

#[test]
fn append_line_ignores_unwritable_path() {
    // 存在しないディレクトリ配下: 失敗しても panic せず黙る（計測が本体を壊さない）
    append_line(std::path::Path::new("Z:/no/such/dir/perf.log"), "x");
}
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd src-tauri && cargo test --lib utils::perf`
Expected: `append_line` 未定義でコンパイルエラー。

- [ ] **Step 3: 実装**

`perf.rs`:

```rust
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("SPICA_PERF").map(|v| v == "1").unwrap_or(false) || file_sink().is_some()
    })
}

/// Explorer 起動では stderr が捨てられるので、SPICA_PERF_FILE があればそこへ追記する。
fn file_sink() -> Option<&'static PathBuf> {
    static SINK: OnceLock<Option<PathBuf>> = OnceLock::new();
    SINK.get_or_init(|| std::env::var_os("SPICA_PERF_FILE").map(PathBuf::from))
        .as_ref()
}

pub(crate) fn append_line(path: &Path, line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

pub fn emit(line: String) {
    if !enabled() {
        return;
    }
    match file_sink() {
        Some(path) => append_line(path, &line),
        None => eprintln!("{line}"),
    }
}
```

`phase` と `PerfTimer::drop` の `eprintln!` を `emit(format!(...))` に置き換える。`explorer_sort.rs:305,315` と `file.rs:182` の `eprintln!(...)` も `crate::utils::perf::emit(format!(...))` に置き換える（`if crate::utils::perf::enabled()` のガードはそのまま）。

`explorer_sort.rs` に `pub fn foreground_at_launch() -> Option<isize>`（`FOREGROUND_AT_LAUNCH.get().copied()`、非 Windows は `None`）を追加。

`lib.rs` の `window_created` フェーズ出力（C1 で `let window = ...build()?;` になっている）を、C1 の `foreground_state` を使って拡張:

```rust
let fg = commands::window::foreground_state(&window);
crate::utils::perf::phase(
    "window_created",
    &format!(
        r#","foreground_is_ours":{},"foreground":{},"launcher":{}"#,
        fg.is_ours,
        fg.foreground,
        commands::explorer_sort::foreground_at_launch().unwrap_or(0)
    ),
);
```

C1 が追加した `.on_window_event` の `Focused` 分岐に、再主張の前にトレースを足す:

```rust
if let tauri::WindowEvent::Focused(focused) = event {
    crate::utils::perf::phase("focused", &format!(r#","focused":{focused}"#));
    // ...C1 の reassert_startup_foreground 呼び出しはこの後
}
```

- [ ] **Step 4: テストとリントを通す**

Run: `cd src-tauri && cargo test --lib && cargo fmt --check && cargo clippy --all-targets -- -D warnings`
Expected: すべて green。`SPICA_PERF` 未設定のテストは従来どおり無出力。

- [ ] **Step 5: ファイル出力を手動確認**

Run（PowerShell）:
```powershell
$env:SPICA_PERF_FILE = "$env:TEMP\spica-perf.log"; & src-tauri\target\release\spica-photo-viewer.exe e2e\fixtures\corpus\small\img-000.jpg
```
Expected: `$env:TEMP\spica-perf.log` に `window_created` 行（`foreground_is_ours` 付き）と `focused` 行がある。確認後にアプリを閉じる。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/utils/perf.rs src-tauri/src/commands/window.rs src-tauri/src/commands/explorer_sort.rs src-tauri/src/commands/file.rs src-tauri/src/lib.rs
git commit -m "feat(perf): file sink for Explorer launches and a foreground state trace at window creation"
```

### Task A3: 再現プロトコルと判定表の文書化

**Files:**
- Create: `docs/superpowers/specs/2026-09-20-explorer-launch-foreground-checklist.md`

- [ ] **Step 1: 手順書を書く**

```markdown
# Explorer 起動で背面化する事象の採取手順

## 準備（1 回）
1. `setx SPICA_PERF_FILE %LOCALAPPDATA%\SpicaPhotoViewer\perf.log`（エクスプローラーは WM_SETTINGCHANGE で環境変数を取り直すので再ログイン不要。反映されない場合はエクスプローラーを再起動）
2. 発生しやすい条件で使う: 画像の多いフォルダ、ネットワーク（UNC）フォルダ、エクスプローラーがサムネイル生成中。

## 発生したら（この順で、ウインドウを触る前に）
1. `powershell -ExecutionPolicy Bypass -File scripts\diagnose-foreground.ps1 -Seconds 10 > %TEMP%\fg-before.jsonl`
2. Spica の画像を 1 回クリックし、再度 `... > %TEMP%\fg-after-click.jsonl`
3. エクスプローラーを最小化→復元して直った後、`... > %TEMP%\fg-after-restore.jsonl`
4. `%LOCALAPPDATA%\SpicaPhotoViewer\perf.log` の末尾（該当起動の `run_start` 以降）を添付。
5. ダブルクリック後に他のクリック・キー入力をしたか、ネットワークフォルダか、エクスプローラーの「フォルダーウィンドウを別のプロセスで開く」設定の有無を記録。

## 判定表
| 観測 | 仮説 |
|---|---|
| perf.log の `window_created` が `foreground_is_ours:false`、`focused:true` が無い | H1（前面化権の失効） |
| `focused:true` の直後に `focused:false`、`fg-before` の前面が explorer | H4（エクスプローラーの前面奪取） |
| `fg-before` の `foreground.gui_flags` に 0x4/0x8/0x10、または `gui_capture` が非 0 | H2（エクスプローラーのモーダル状態） |
| `spica[].pump_ok:false` / `pump_ms` > 100 / `hung:true` | H3（メインスレッド応答停止） |
| `spica[].gui_active` が Spica 自身で `is_foreground:false` | H5（キュー内 active の不整合） |
| `fg-after-click` で `spica[].is_foreground:true` なのに前面に見えない | 描画側の問題（新規調査） |
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-09-20-explorer-launch-foreground-checklist.md
git commit -m "docs: reproduction protocol and decision table for the launch-behind-Explorer report"
```

### Task C1: 起動直後の前面再主張（起動ファイルあり・1.5 秒以内・最大 2 回）— 最初に実施

§1.4(a) で消えた「~500ms 後の 2 回目のアクティブ化」を、最大化状態を保ったまま復元する。

**Files:**
- Modify: `src-tauri/src/commands/window.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `docs/code-rationale.md`（新ラベル `W2` を定義）
- Test: `src-tauri/src/commands/window.rs`（`mod tests`）

**Interfaces:**
- Consumes: 既存の `native::hwnd_of`（`window.rs:152`）、`perf::phase`。
- Produces: `commands::window::foreground_state(window: &tauri::WebviewWindow) -> ForegroundState { is_ours: bool, foreground: isize }`（非 Windows では `is_ours: true, foreground: 0`。A2 も使う）。
- Produces: `commands::window::should_reassert_foreground(launched_with_file: bool, is_ours: bool, elapsed: Duration, attempts: u32) -> bool`（純関数、単体テスト対象）。
- Produces: `commands::window::reassert_startup_foreground(window: &tauri::WebviewWindow, launched_with_file: bool, started: Instant, attempts: &AtomicU32, phase: &str)`（Windows で `SetForegroundWindow` を呼び、結果を perf ログ `foreground_reassert` に `,"phase":"...","ok":bool,"err":u32` で記録）。
- Produces: `lib.rs` の `.on_window_event` ハンドラ（`Focused(false)` を再主張の契機にする。A2 がトレースを相乗りする）。

契機が 3 つある理由: `window_created`（最初のアクティブ化が最初から成立しなかった場合）、`page_load_finished`（旧 `maximize_window` 相当のやり直し）、`Focused(false)`（成立した後にエクスプローラー側に戻された場合＝H4。旧実装はこのケースも ~500ms の `SW_MAXIMIZE` で拾えていた）。`Focused(false)` は WebView2 子ウインドウがキーボードフォーカスを取るときにも毎回発火する（tao は `WM_KILLFOCUS` で `Focused(false)` を出す、`tao-0.35.3/src/platform_impl/windows/event_loop.rs:1800`）が、そのとき `GetForegroundWindow()` はトップレベルの自ウインドウのままなので `is_ours == true` で弾かれる。

- [ ] **Step 1: 失敗するテストを書く**

`window.rs` の `mod tests` に追加:

```rust
use std::time::Duration;

#[test]
fn reasserts_only_for_file_launches_that_are_not_foreground() {
    assert!(should_reassert_foreground(true, false, Duration::from_millis(300), 0));
    assert!(!should_reassert_foreground(false, false, Duration::from_millis(300), 0));
    assert!(!should_reassert_foreground(true, true, Duration::from_millis(300), 0));
}

#[test]
fn reassert_is_bounded_in_time_and_count() {
    assert!(should_reassert_foreground(true, false, Duration::from_millis(1500), 1));
    assert!(!should_reassert_foreground(true, false, Duration::from_millis(1501), 0));
    assert!(!should_reassert_foreground(true, false, Duration::from_millis(300), 2));
}
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd src-tauri && cargo test --lib commands::window::tests`
Expected: `should_reassert_foreground` 未定義でコンパイルエラー。

- [ ] **Step 3: 実装**

`window.rs`:

```rust
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

pub struct ForegroundState {
    pub is_ours: bool,
    pub foreground: isize,
}

/// 非 Windows は常に「自分が前面」。
pub fn foreground_state(window: &tauri::WebviewWindow) -> ForegroundState {
    #[cfg(windows)]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        let fg = unsafe { GetForegroundWindow() };
        let ours = native::hwnd_of(window).map(|h| h == fg).unwrap_or(false);
        return ForegroundState { is_ours: ours, foreground: fg.0 as isize };
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        ForegroundState { is_ours: true, foreground: 0 }
    }
}

/// 再主張の上限（W2）: ダブルクリック直後の起動処理に収まる範囲に限り、
/// ユーザーが別ウインドウへ移った後は一切奪わない。
pub const FOREGROUND_REASSERT_WINDOW: Duration = Duration::from_millis(1500);
pub const FOREGROUND_REASSERT_MAX: u32 = 2;

pub(crate) fn should_reassert_foreground(
    launched_with_file: bool,
    is_ours: bool,
    elapsed: Duration,
    attempts: u32,
) -> bool {
    launched_with_file
        && !is_ours
        && elapsed <= FOREGROUND_REASSERT_WINDOW
        && attempts < FOREGROUND_REASSERT_MAX
}

/// tao の `set_focus()` は使わない: 失敗時に合成 ALT 入力を前面アプリへ送り、
/// エクスプローラーをメニューモードに落とす（W2）。
pub fn reassert_startup_foreground(
    window: &tauri::WebviewWindow,
    launched_with_file: bool,
    started: Instant,
    attempts: &AtomicU32,
    phase: &str,
) {
    let state = foreground_state(window);
    let n = attempts.load(Ordering::Relaxed);
    if !should_reassert_foreground(launched_with_file, state.is_ours, started.elapsed(), n) {
        return;
    }
    attempts.fetch_add(1, Ordering::Relaxed);
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::GetLastError;
        use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
        let Ok(hwnd) = native::hwnd_of(window) else { return };
        let ok = unsafe { SetForegroundWindow(hwnd) }.as_bool();
        let err = if ok { 0 } else { unsafe { GetLastError() }.0 };
        crate::utils::perf::phase(
            "foreground_reassert",
            &format!(r#","phase":"{phase}","ok":{ok},"err":{err}"#),
        );
    }
    #[cfg(not(windows))]
    let _ = phase;
}
```

`lib.rs`: `run()` 先頭（`run_start` フェーズと同じ位置）で `let started = std::time::Instant::now();`、`static REASSERTS: AtomicU32` を用意し、`launched_with_file` は `startup_file_from_args().is_some()` を `OnceLock<bool>` に保持して各クロージャから参照する。

- `setup`: `.build()?;` を `let window = ...build()?;` に変え、`window_created` フェーズ出力の直後に `commands::window::reassert_startup_foreground(&window, maximized, started, &REASSERTS, "window_created");`
- `.on_page_load` の `Finished` 分岐: `if let Some(w) = webview.window().get_webview_window("main") { commands::window::reassert_startup_foreground(&w, launched_with_file, started, &REASSERTS, "page_load_finished"); }`
- `.on_page_load(...)` の後に追加:

```rust
.on_window_event(move |window, event| {
    if let tauri::WindowEvent::Focused(false) = event {
        if let Some(w) = window.get_webview_window("main") {
            commands::window::reassert_startup_foreground(
                &w, launched_with_file, started, &REASSERTS, "focus_lost",
            );
        }
    }
})
```

`reassert_startup_foreground` はイベントループのスレッド（メインスレッド）から呼ばれる。`SetForegroundWindow` は自スレッドのウインドウに対して呼ぶので、tao の `thread_executor` を経由する必要はない。

`Cargo.toml` の `windows` features に `Win32_Foundation` が含まれることを確認（`GetLastError` 用。既に `HWND`/`RECT` で使用中）。

`docs/code-rationale.md` に追加:

```markdown
## W2: 起動直後の前面再主張

エクスプローラーからの起動は前面化権を持つが、ダブルクリック直後の追加入力や
エクスプローラー側の再前面化で ShowWindow の activate が取り消されることがある
（2026-09-20 報告）。ウインドウを最初から最大化で生成する前（PR #310 以前）は、
フロントが起動 ~500ms 後に呼ぶ `maximize_window` が `ShowWindow(SW_MAXIMIZE)` に
なり、この取り消しを事実上やり直していた。最大化生成後は同じ呼び出しが tao の
`apply_diff` で no-op になり、やり直しが消えた。その代替として、起動ファイルありの
起動に限り、`run_start` から 1500ms 以内・最大 2 回だけ `SetForegroundWindow` を
呼ぶ（契機: window_created / page_load_finished / Focused(false)）。権が失効して
いれば OS が拒否するので、ユーザーが意図して他ウインドウへ移った場合は奪えない
（奪わない）。tao の `set_focus()` は失敗時に合成 ALT キーを前面アプリへ送るため
使わない。`maximize_window` を非最大化生成に戻して旧挙動を再現する案は、起動時の
800×600 → 最大化のジャンプを復活させるので採らない。
```

- [ ] **Step 4: テスト・リント**

Run: `cd src-tauri && cargo test --lib && cargo fmt --check && cargo clippy --all-targets -- -D warnings`
Expected: green。

- [ ] **Step 5: 回帰確認（起動体感・e2e）**

Run: `npm test && npm run test:e2e`
Expected: green（前面再主張は e2e の WebDriver 起動に影響しないこと。もし e2e が focus 依存で落ちる場合、`SPICA_PERF_FILE` ログの `foreground_reassert` を見て原因を切り分ける）。

- [ ] **Step 6: 手動チェック（通常起動の非回帰）** — ユーザー実施

1. エクスプローラーから画像をダブルクリック → 従来どおり前面・最大化で開く。`SPICA_PERF_FILE` を設定していれば（A2）、通常起動では `foreground_reassert` 行が **出ない**（`window_created` 時点で前面が自ウインドウ）ことを確認する。
2. ダブルクリック直後にすぐ別アプリ（例: ブラウザ）をクリック → Spica はそのアプリを **奪わない**（タスクバー点滅のみ）。perf.log に `foreground_reassert ... ok:false` が記録される。
3. 既存のウインドウ化（画像外クリック）と F11 が影響を受けない。

実装セッション（2026-09-20）での注記: エージェントのシェルから release exe を起動した時点では、デスクトップ全体で `GetForegroundWindow()` が NULL（ロック画面など前面ウインドウが存在しない状態）だったため、`window_created` と `page_load_finished` の両契機で再主張が走り（`was:0`）、いずれも `ok:false, err:6` で OS に拒否された。設計どおり上限 2 回で止まり、それ以上は何もしていない。通常起動で再主張が走らないことの確認は、対話デスクトップ上でのユーザー実施に委ねる。

同セッションの 2 回目（A2 のファイル出力で採取、デスクトップに前面ウインドウがある状態、起動元は前面でないエージェントのシェル）: `window_created` で `foreground_is_ours:false`（前面は起動時と同じ別プロセスのウインドウ）→ 再主張 `ok:false` → **5ms 後に `focused:true`** → `page_load_finished` でも前面は変わらず再主張 `ok:false`。つまり「自ウインドウはキュー内で active かつフォーカス済みだが、`GetForegroundWindow` は別プロセス」という H5 と同じ形の状態が、**前面化権を持たないプロセスから起動しただけで再現**した。エクスプローラー起動では権利があるので同じ経路にはならないが、A2 のトレースがこの状態を判別できることは確認できた。`err` の値（6 / 183）は `SetForegroundWindow` が `GetLastError` を設定しないときの残骸で、判定には使わない。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands/window.rs src-tauri/src/lib.rs docs/code-rationale.md
git commit -m "fix(window): reassert the foreground once right after a file-association launch (W2)"
```

### Task C2（条件付き: H3 の証拠が出た場合のみ）: `get_startup_file` の同期ブロック解消

**Files:**
- Modify: `src-tauri/src/commands/file.rs:218-229`
- Test: `src-tauri/src/commands/startup.rs`（既存テストが引き続き通ること）

- [ ] **Step 1: async 化**

```rust
#[tauri::command]
pub async fn get_startup_file() -> Result<Option<StartupFile>, String> {
    crate::utils::perf::phase("get_startup_file", "");
    tauri::async_runtime::spawn_blocking(|| {
        startup_file_from_args().map(|path| {
            let thumbnail = crate::commands::startup::take_thumbnail(&path);
            crate::utils::perf::phase(
                "get_startup_file_end",
                &format!(r#","thumb":{}"#, thumbnail.is_some()),
            );
            StartupFile { path, thumbnail }
        })
    })
    .await
    .map_err(|e| format!("startup file task failed: {e}"))
}
```

`take_thumbnail` の最大 150ms 待ち（`startup.rs:29`）がメインスレッドを塞がなくなる。フロントエンドは既に `await invoke(...)` なので変更不要。

- [ ] **Step 2: テストと起動ベンチ**

Run: `cd src-tauri && cargo test --lib && npm test`
Expected: green。続けて `node e2e/scripts/profile-startup.mjs --file e2e/fixtures/corpus/medium/img-000.jpg --runs 3` で `get_startup_file_end` までの時間が悪化していないこと（±20ms 以内）。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands/file.rs
git commit -m "perf(startup): keep the startup-file thumbnail wait off the main thread"
```

### Task C3（条件付き: §3 の 2 の条件を満たした場合のみ）: 起動時ソートプローブをウインドウ表示後に遅らせる

§1.4(b) の検証。エクスプローラー UI スレッドへの COM RPC が最初の `ShowWindow` と重ならないようにし、それで再現が止まるかを見る。1 コミット 1 仮説（CLAUDE.md）。

**Files:**
- Modify: `src-tauri/src/commands/startup.rs`（`start` をサムネイル部とフォルダ部に分割: `start_thumbnail(path, screen)` / `start_folder(path)`）
- Modify: `src-tauri/src/lib.rs`（`start_folder` を `window_created` フェーズの後へ移す）
- Modify: `docs/code-rationale.md`（W4）
- Test: `src-tauri/src/commands/startup.rs`（新規 2 件、既存テストにはスロット用のテストロックを追加）

（2026-09-21: 発動根拠は §3 の 6（§1.5 の実験 A/B）に置き換えた。根拠ラベルは `docs/code-rationale.md` W4。）

- [x] **Step 1: 分割と移動**（テスト先行: `start_thumbnail` はフォルダ枠に触れない / `start_folder` は画像の親フォルダを先読みして `take_folder` が返す。変異チェック 2 件 = `start_thumbnail` から `start_folder` を呼ぶ・親でなく画像パスをキーにする、いずれも該当テストが落ちる）

`setup` 内で、ウインドウ生成前は `start_thumbnail` のみ、`.build()?` の後（W2/W3 の後）に `start_folder`。`take_folder` の契約（スロットが無ければ `None` → 通常走査）は変えない。

- [x] **Step 2: 起動時間の影響を測る**

Run: 直前のビルドの e2e exe と C3 の e2e exe で、`profile-startup.mjs --file e2e/fixtures/corpus/medium/img-000.jpg` を交互に 3 起動 × 3 ラウンド（それぞれ捨て起動 1 回の後）。
結果: 走査開始は `window_created` +0〜2ms。起動から `window_created` までの時間は両 exe とも二峰性（~0.5 秒 / 0.9〜1.5 秒）なので、`window_created` 起点で比べた。`folder:scanned` は速い回で差なし（中央値 ~100ms 同士）、遅い回で +241 → +281ms（+40ms）。首枚の paint は変わらない。計画時の予想（~270ms 遅れ）より小さいのは、フロントが一覧を求めるのがページロードと React マウントの後で、走査の大半がその間に収まるため。NAS・大フォルダでは走査が長いので、遅れはウインドウ生成の分に近づく（W4）。

- [ ] **Step 3: 採否（実機、§3 の 6）**

エクスプローラーから起動し、C3 のビルドと直前のビルド（対照）をブロックごとに交互に入れ替えて、それぞれ 30 起動以上。合格条件: C3 側で `window_created` の `z_above` が非 0 の起動が 0 件で、同時に取った対照側には起きていること（対照でも 0 件なら判定不能）。あわせて、一覧・サムネイルバーの出方に体感の悪化が無いこと。不合格なら `git revert`。
  - 1 回目（2026-09-21、ローカルの同じフォルダ・実験用の窓）: C3 0/30、対照 0/33 で判定不能（§1.5）。
  - 2 回目（高頻度条件）: いつもの窓から、毎回その日まだ起動していない NAS フォルダへ移動して最初に起動する。10 起動ずつ C3 → 対照 → C3 → 対照で、各 20 起動。対照の見込みは ~30%（§1.5 の 6/18）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/startup.rs src-tauri/src/lib.rs
git commit -m "fix(startup): start the folder prefetch after the window is shown"
```

### Task C4: 起動直後の z オーダー是正（前面は自分・z だけ起動元の下）

§1.5 の状態を、W2 と同じ時間枠・別カウンタで解消する。根拠は `docs/code-rationale.md` W3。

**Files:**
- Modify: `src-tauri/src/commands/window.rs`（`Rect::intersects` / `ZWindow` / `covering_window` / `should_raise_z` / `raise_startup_z` / `native::windows_above` / `native::raise_to_top`、`ForegroundState.z_above`）
- Modify: `src-tauri/src/lib.rs`（`Z_RAISES`、`window_created` と `page_load_finished` で W2 の直後に呼ぶ、`window_created` 行に `z_above`）
- Modify: `docs/code-rationale.md`（W3）
- Test: `src-tauri/src/commands/window.rs`（`mod tests`）

**Interfaces:**
- Produces: `covering_window(above: &[ZWindow], ours: Rect) -> Option<isize>` — z 上位から順に、可視・非最小化・非 toolwindow・非 topmost・非 cloaked・非所有・矩形交差、をすべて満たす最初の HWND（純関数）。
- Produces: `should_raise_z(launched_with_file, is_ours, covered, elapsed, attempts) -> bool` — `launched_with_file && is_ours && covered && elapsed <= 1500ms && attempts < 2`（純関数）。
- Produces: `raise_startup_z(window, launched_with_file, started, attempts, phase)` — 条件を満たせば `SetWindowPos(HWND_TOP, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)`、perf ログ `z_raise`（`at` / `above` / `ok` / `err`）。
- Produces: perf ログ `window_created` の `"z_above":<hwnd|0>`。

- [x] **Step 1: 失敗するテストを書く**（各テストが名指しする本番変更: 除外条件 6 つ・別モニタ・辺接触・順序、`is_ours` 反転、1500ms ちょうど / 1501ms、回数上限）
- [x] **Step 2: 赤を確認**（`ZWindow` / `covering_window` / `should_raise_z` / `Z_RAISE_MAX` 未定義でコンパイルエラー）
- [x] **Step 3: 実装**
- [x] **Step 4: 変異チェック**（回数上限 `<` → `<=`、topmost 除外の削除、矩形交差 `<` → `<=`、`is_ours` 反転: いずれも該当テストが落ちる）
- [x] **Step 5: ゲート** `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` / `cargo test --lib`（130）/ `npm test`（413）
- [ ] **Step 6: e2e** `npm run bench:build` → `npm run test:e2e` 2 回連続 green
- [ ] **Step 7: 実機検証（ユーザー）** — インストーラを更新し、エクスプローラーから 30 回以上起動（ローカル・NAS）。合格条件: 「Spica が前面のまま、起動元エクスプローラーが `above` に 1 秒以上残る」起動が 0 件。`perf.log` の `z_raise ... ok:true` が症状の出た起動と対応していること。あわせて C1 Step 6 の項目 3（ウインドウ化・F11）を実施。
- [ ] **Step 8: 不合格なら** `git revert` せず、ウォッチャーの記録（再度持ち上げられた時刻）を根拠に次の契機（遅延再確認など）を相談する。

---

## §5 完了条件

- C1 がマージされ、ユーザー環境で再現条件（UNC フォルダ・大量枚数）の運用で背面化が出なくなる。perf ログの `foreground_reassert` 行で「再主張が成功したか / OS が拒否したか」が読める。
- A1–A3 がマージされ、C1 後も再現した場合に §2 の判定表で仮説が一意に決まる。
- C1 後も再現し、採取結果で H2 または H4（Windows 側）と判定された場合は、`docs/code-rationale.md` に事象と回避策を記録して本件をクローズする。H1/H5 で C1 が `ok:false` なら C3 を実施し、H3 なら C2 を実施する。
- （2026-09-21 追記）実機再現は §1.5 の状態だったので、C4 がマージされ、ウォッチャー付きの 30 回以上の起動で「前面は自分・z だけ下」が 1 秒以上残る起動が 0 件になれば本件をクローズする。C4 後にも 1500ms より後で持ち上げられる場合は、ウォッチャーの記録から契機を追加する（別 PR）。
