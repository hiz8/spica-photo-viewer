# Explorer 起動で背面化する事象の採取手順

対象: エクスプローラーから画像をダブルクリックして起動した Spica がエクスプローラーの背面に出て、クリックしても前面化しない事象（2026-09-20 報告）。
背景と仮説は `docs/superpowers/plans/2026-09-20-explorer-launch-foreground.md` §1–§2、修正 W2 は `docs/code-rationale.md`。

## 準備（1 回）

1. `setx SPICA_PERF_FILE %LOCALAPPDATA%\SpicaPhotoViewer\perf.log`
   エクスプローラーは `WM_SETTINGCHANGE` で環境変数を取り直すので再ログインは不要。反映されない場合はエクスプローラーを再起動する。
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

## W2 の効き方の読み取り

perf.log の `foreground_reassert` 行（`at`: 契機、`ok`: `SetForegroundWindow` の成否、`err`: 失敗時の `GetLastError`、`was`: その時点の前面 HWND）で判断する。

| 観測 | 意味 |
|---|---|
| 行が無い | 最初のアクティブ化が成立し、その後も奪われていない（通常） |
| `ok:true` | 取り消された前面を W2 が取り戻した |
| `ok:false` が 2 行 | OS が拒否した。ユーザーが他ウインドウへ入力した（正常）か、前面化権の失効（H1）。`fg-before` と合わせて判定表へ |
