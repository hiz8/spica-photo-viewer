# explorer-sort-probe

spec §7.3(Explorer ソート連動の手動検証)用のプローブ群。
spec 付録 A の C# プローブを、アプリ本体と同じ windows crate バインディングを
使う Rust example(`src-tauri/examples/explorer_sort_probe.rs`)に置き換えた
もの(SAFEARRAY マーシャリング罠 = 付録 A.5 を構造的に回避)。

**どのスクリプトも `SetSortColumns` は呼ばない(spec R10)。**
ソート変更は `set-sort-via-ui.ps1`(UIA のヘッダクリック)か手動で行う。

| コマンド | 用途 |
|---|---|
| `./probe.ps1 list` | 全 Explorer 窓/タブの HWND・パス・生ソート列・グループ化を列挙 |
| `./probe.ps1 order <folder>` | そのフォルダを表示中のタブの実表示順(`GetItem`)を出力 |
| `./probe.ps1 app <folder> [-Hwnd N]` | アプリ本体の検出+ソート経路の結果順を出力(stderr に検出結果) |
| `./compare-order.ps1 <folder>` | 上 2 つを diff(一致で exit 0) |
| `./set-sort-via-ui.ps1 -Path <folder> -Column <ヘッダ名> [-Clicks n]` | 詳細表示に切替えて列ヘッダを UIA クリック(1=昇順, 2=降順) |

`-Hwnd` が影響するのは stderr の検出結果行(`detect_sort_spec`)のみ。
stdout の並びは `get_folder_images` の実経路で、プローブ実行では起動時
foreground 退避が無いため常に列挙順先頭の窓が選ばれる。複数窓の選択ロジック
検証は stderr の検出結果で行うこと。

PROPERTYKEY の読み方(spec 付録 B): fmtid B725F130-… の pid 10=名前 /
12=サイズ / 14=更新日時 / 15=作成日時 / 4=種類。dir 1=昇順, -1=降順。
