# Explorer 起動で背面化する事象の採取手順

対象: エクスプローラーから画像をダブルクリックして起動した Spica がエクスプローラーの背面に出て、クリックしても前面化しない事象（2026-09-20 報告）。
背景と仮説は `docs/superpowers/plans/2026-09-20-explorer-launch-foreground.md` §1–§2、修正 W3 は `docs/code-rationale.md`（前面を取り戻す W2 は、実機で一度も要らなかったので撤去した）。

2026-09-21 の実機再現では、症状は「前面が自分でない」ではなく **「前面は Spica のまま、z オーダーだけ起動元エクスプローラーの下」** だった（判定表の最終行、対策 C4 = W3）。

## 準備（1 回）

1. `setx SPICA_PERF_FILE %LOCALAPPDATA%\SpicaPhotoViewer\perf.log`
   エクスプローラーは `WM_SETTINGCHANGE` で環境変数を取り直すので再ログインは不要。反映されない場合はエクスプローラーを再起動する。
   設定したままでも、`SPICA_PERF=1` で起動する bench・プロファイル・e2e の出力は stderr のまま（`SPICA_PERF=1` が優先）。
2. 発生しやすい条件で使う: エクスプローラーでまだ開いていないフォルダ（特に NAS）へ移動した直後の最初の起動。2026-09-21 の集計では、この条件で ~30%、同じフォルダを繰り返し起動すると ~3%（plan §1.5）。

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
| perf.log の `window_created` が `foreground_is_ours:true` かつ `z_above` が起動元 `launcher` の HWND（または `fg-before` で `spica[].is_foreground:true` かつ `above` に起動元エクスプローラー） | **前面は Spica・z だけエクスプローラーの下**（2026-09-21 に実機で確定）。C4（W3）の対象で、W3 が起動直後に直す |

「クリックしても前面化しない」の説明: 最終行の状態では Spica が既にアクティブ（前面）ウインドウなので、クリックしてもアクティブ化が起きず、z オーダーも動かない。他アプリへ一度フォーカスを移してから Spica をクリックすると、アクティブ化が z も最上位へ戻す。エクスプローラーの最小化→復元で直るのも同じ理由（覆っていたウインドウが無くなる／z が組み直される）。

H1 / H4 / H5（前面が Spica でない状態）は、2026-09-21 までの実機 260 起動で一度も観測されていない。前面を取り戻す W2 はそのため撤去した。観測されたら、判定表で仮説を決めてから W2 の再導入を検討する（`docs/code-rationale.md` W2 に設計が残っている）。

## W3（C4）の効き方の読み取り

perf.log の `z_raise` 行（`at`: 契機、`above`: 覆っていた HWND、`ok`: `SetWindowPos` の成否、`err`: 失敗時のメッセージ）と、`window_created` 行の `z_above`（覆っている HWND、無ければ 0）で判断する。

| 観測 | 意味 |
|---|---|
| `z_above:0` で `z_raise` 行が無い | 起動元は Spica の上に来なかった（通常） |
| `z_above` が `launcher` と同じで `z_raise ... ok:true` | 起動元がすぐ上に来ていたのを W3 が持ち上げた |
| `z_raise ... ok:true` の後もエクスプローラーが上に居る | W3 の枠（窓の生成から 1500ms）より後に再度持ち上げられた。外部ウォッチャー（15ms ポーリング）で持ち上げの時刻を採り、契機の追加を検討する |
| `z_above` が `launcher` 以外 | 別のウインドウ（前面が自分のまま覆っているもの）。同じ対策の対象だが、何のウインドウかを `diagnose-foreground.ps1` の `above` で確認する |
