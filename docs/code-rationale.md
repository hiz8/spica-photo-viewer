# コード根拠集（code rationale）

`docs/superpowers/specs/` 配下の設計ドキュメントが日付付きの設計記録であるのに対し、
このファイルは実装に張り付いた根拠を蓄積する生きたドキュメントである。
コードのコメントから 1 行で参照される。

各節はコードから `— docs/code-rationale.md#<anchor>` の形で参照される。
節を削除・改名するときは参照元も同時に直すこと。行番号は編集のたびにずれるため、
コードへの逆参照は行番号ではなくシンボル名（関数名・フィールド名・テスト名）で行う。

## X1

**CMYK/YCCK ソースでは ICC プロファイルを落とす**

> X1: ICC is carried only when the SOURCE was encoded as RGB/RGBA; for CMYK/YCCK
> sources the decoder already converted to RGB and the embedded profile would describe the
> wrong color space, so it is dropped. Must be checked against the *original*
> (pre-decode) color type, not the decoded `DynamicImage`'s — `image`'s JPEG decoder
> always hands back RGB8 pixels for a CMYK/YCCK source, so gating on the decoded type
> would let a CMYK profile through and stamp it onto already-converted RGB pixels.
> This check alone is not enough for every decoder, though: `image` 0.25's JPEG
> decoder reports CMYK/YCCK sources as `original_color_type() == Rgb8` too (it
> collapses to RGB at the same point it configures pixel decoding), so
> `icc_describes_rgb` below double-checks the profile's own declared data color space.

（`icc_applies`（`src-tauri/src/utils/preview.rs`）の doc コメントが**移行前に**持っていた
全文。現在の `icc_applies` は 1 行の要約 + この節への参照を持つ）

同じ判断が参照されている補足箇所:

- `Decoded::original_color` フィールドの doc コメント（移行前）:

  > The source file's color type *before* decoding converted it (X1) — a CMYK/YCCK
  > JPEG is already RGB pixels in `image` by the time it's a `DynamicImage`, but
  > `original_color` still says `Cmyk8`.

  現在は 1 行の要約 + この節への参照に置き換え済み。

- `decode_oriented` 内、`original_color_type()` を読む行の直前（**現在も変更なし** —
  移行対象ではない。`from_decoder` が decoder を消費する前に読まなければならない
  という、その場で守るべき順序制約そのものであり、要約や参照に置き換えると制約の
  実効性が失われるため）:

  > X1: must be read before `from_decoder` consumes the decoder.

- `generate` 内、`icc_applies` / `icc_describes_rgb` で ICC をフィルタする行の直前
  （移行前。coordinator follow-up の注記）:

  > X1 + coordinator follow-up: the decoder's original color type is checked (correct
  > for formats whose decoders do report CMYK, e.g. TIFF), AND the profile's own
  > header is checked, because `image` 0.25's JPEG decoder reports CMYK/YCCK sources
  > as RGB regardless.

  現在はこの節への 1 行参照のみ。

- テスト `icc_applies_only_to_rgb_like_color_types` 内（`#[cfg(test)]` 配下）。この根拠
  移行タスクは当初非テスト領域のみを対象とし、テスト領域への反映は後続タスクに委ねて
  いた。後続タスクで対応済み — 全文は上の本節と同一内容の再掲だったため、現在はこの
  節への 1 行参照に置き換え済み:

  > X1: CMYK/YCCK must not carry its profile — docs/code-rationale.md#x1

- テスト `generate_drops_cmyk_icc_profiles` 内（同上）。対応済み — このテスト固有の
  結論（プロファイルヘッダのチェックが唯一残る判定手段である理由）は残しつつ、
  再説明していた `image` 0.25 の挙動の部分をこの節への参照に置き換え済み:

  > The decoded pixels are RGB either way (X1's `image` 0.25 caveat —
  > docs/code-rationale.md#x1), so this profile header is the only
  > signal that stops it being carried through.

参照元: `src-tauri/src/utils/preview.rs`

## X2

**エンコーダが拒否する ICC プロファイル長は、失敗させず無視して続行する**

- `encode_jpeg` 内、ICC プロファイルを追加する行の直前（移行前）:

  > X2: a profile the encoder refuses (e.g. > 254 APP2 chunks, so over ~15.9 MB) must
  > not fail the whole preview — degrade to no ICC rather than lose the bar thumbnail
  > generated alongside it.

  現在は 1 行の要約 + この節への参照。

- テスト `generate_degrades_gracefully_when_the_icc_profile_is_too_large_to_attach` 内
  （`#[cfg(test)]` 配下。**現在も変更なし**）:

  > X2: the smallest profile length `jpeg_encoder::Encoder::add_icc_profile` rejects —
  > it splits into 65519-byte APP2 chunks and errors once the count reaches 255
  > (254 * 65519 + 1 = 16,641,827 bytes). Deliberately NOT the coordinator's suggested
  > 17 MiB: that also exceeds `image`'s own JpegEncoder ICC cap (~16.7 MB), so
  > `create_jpeg_with_metadata` itself would panic writing the *source* fixture before
  > this test ever reaches the code under test.

参照元: `src-tauri/src/utils/preview.rs`

## M1

**`into_rgb8()` を使った無コピー変換（24 MP 写真で約 72 MB）**

> M1: takes `image` by value and uses `into_*` instead of `to_*` — for the common
> no-alpha case `into_rgb8()` returns the decoder's own buffer with no copy at all
> (vs. `to_rgb8()`'s always-copy), which matters at ~72 MB for a 24 MP photo.

（`flatten_to_rgb8`（`src-tauri/src/utils/preview.rs`）の doc コメントが**移行前に**
持っていた全文。現在の `flatten_to_rgb8` は 1 行の要約 + この節への参照を持つ）

参照元: `src-tauri/src/utils/preview.rs`

## BUILD-TIME

**typed API でジェネリックな `Resizer::resize` の単相化コストを避ける**

> Build-time note: the dynamic `Resizer::resize(&DynamicImage, &mut Image)` entry
> point is generic over the image types, and its body matches on the runtime pixel
> type — so the caller's crate instantiates the convolution kernels for all 13 pixel
> types × every SIMD path. That alone made this crate's LLVM pass ~80 s longer
> (2026-08-23 measurement). Going through `TypedImageRef<U8x3>` / `resize_typed`
> instantiates only the RGB8 path; the filter, SIMD dispatch and rayon row splitting
> are identical.

（`resize_rgb8`（`src-tauri/src/utils/preview.rs`）の doc コメントが**移行前に**
持っていた全文。現在の `resize_rgb8` は 1 行の要約 + この節への参照を持つ）

参照元: `src-tauri/src/utils/preview.rs`

## Z1

**ポインタ基準ズームの座標系: pan は「スケール後のスクリーン px」、原点は表示要素の中心**

表示要素は `left/top/width/height` でレイアウトされ、`transform-origin: center` で
変換される。したがって変換の原点 O は**要素自身の中心**であって、ビューアの中心ではない。
`.thumbnail-bar` は `position: fixed` なのでフローを占めず、`.image-viewer` は
ウインドウ全高になる一方、画像はバーの上の領域（`innerHeight - THUMBNAIL_BAR_HEIGHT`）に
センタリングされる。この 2 つの中心は常に **バー高の半分（40px）** ずれている。

ポインタ位置をビューア中心基準で渡すと、その差 d だけ原点を取り違えたまま
アンカー計算を行うことになり、1 ノッチあたり `d × (1 − ratio)` だけ画像がずれる。
実測（2026-08-30、2560×1369 ウインドウ / 2000×1500 画像、WebDriver）:
ズームイン 5 ノッチで dy = +8.00 +17.60 +29.12 +42.94 +59.53、
ズームアウト 5 ノッチで dy = −6.67 −12.22 −16.85 −20.71 −23.92、dx はいずれも ~1e-4。
d = −40 に対する `d × (1 − 1.2) = +8.000` / `d × (1 − 1/1.2) = −6.667` と一致し、
横方向に定常ずれが出ないことも「原点の食い違いは縦方向だけ」という説明と一致する。

**変換の順序**: `translate(pan) scale(s)` と書く（= pan がスケールの**後**に効く
スクリーン px オフセット）。画像ローカル点 L のスクリーン位置は `O + T + s·L`。
アンカー保存は `T₁ = ratio·T₀ + (1 − ratio)·m`（m はポインタの O からのオフセット）
という 1 次補間になり、これは CSS トランジションが T と s を独立に線形補間しても
**全経過点で** `O + T(p) + s(p)·L* = A` を満たす（p の 1 次項が消えるため。
イージング関数にも依存しない）。

逆順の `scale(s) translate(pan)`（= pan が画像 px）では
`O + s(p)·(L + T(p))` が p の 2 次式になり、アンカーが
`p(1−p)·m·Δs²/(s₀s₁)` だけ膨らんで戻る — ポインタが中心から離れるほど、
かつ 1 回のトランジションが跨ぐズーム幅が大きいほど大きい。
実測（8 ノッチを 16ms 間隔、m = −640）で dx が −108px まで振れた。
この順序ならトランジションの途中で次のノッチが割り込んでも、
中断点は始点と終点を結ぶ線分上にあり、その線分上の全状態が同じアンカーを
同じ位置に写すため、割り込み後のアンカーもずれない。

参照元: `src/store/index.ts`（`zoomAtPoint`）、
`src/components/ImageViewer.tsx`（`handleWheel` / `imageStyle`）

## W1

**画像外クリックのウインドウ化: クライアント領域 = 表示画像、位置は画像基準、クランプ無し（Picasa 準拠）**

Picasa Photo Viewer は画像の外をクリックすると、表示中の画像（ズーム適用後）の
サイズにウインドウを縮め、画像の画面上の位置を変えない。ウインドウの横幅の最小値は
544px で、それ未満の画像では 544 × (544·h/w) の箱の中央に現在のズームのまま置く
（2000×1000 → 544×272、1000×2000 → 544×1088）。上限は無く、画面をはみ出すほど
拡大していればウインドウもはみ出す。

**サイズと位置はストアの状態から決める（DOM を見ない）**。表示要素は bitmap ヒット時
`<canvas>`、ミス時 `<img>` で切り替わるため `querySelector(".image-viewer img")` は
ヒット時に null になり（2026-09-06 時点の旧実装はこれで無反応だった）、また
`transform` の 0.1s トランジション中にクリックされると `getBoundingClientRect` は
中途の矩形を返す。Z1 の座標系では要素の画面上の中心は
`(imageLeft + W/2 + panX, imageTop + H/2 + panY)` で閉じた式になる。

**物理 px 変換と枠オフセット**。フロントは CSS px（ビューポート座標）を渡し、Rust が
`scale_factor()` と `inner_position()` で画面上の物理 px に写す（CSS px をそのまま
物理 px として使うと DPI ≠ 100% でずれる）。Tauri の `set_size` はクライアント寸法
（tao `set_inner_size`）、`set_position` は外枠位置なので、復元後に
`inner_position() − outer_position()` を実測してタイトルバー・境界分を差し引く。
最大化中の枠オフセットは復元後と異なる（Windows は最大化時に境界を画面外へ押し出す）
ため、復元**後**に測る。

**画面より大きいウインドウ**。サイズ変更可能なウインドウは `WM_GETMINMAXINFO` の既定
`ptMaxTrackSize`（仮想スクリーン + 枠）で `SetWindowPos` の寸法も切り詰められる。
tao は `max_size` が設定されているときだけ `ptMaxTrackSize` を上書きするので、
ウインドウ生成時に builder の `max_inner_size` で十分大きな上限を与えておく。
**コマンド内で `set_max_size` を呼んではいけない**: tao の `set_max_inner_size` は
「境界を再チェックさせる」ために現在サイズで `set_inner_size` を呼び直し、その
`set_inner_size` は MAXIMIZED フラグを落として `SW_RESTORE` する。つまり最大化中に
呼ぶと**その時点で**最大化前の矩形（800×600）へ復元されてしまう（2026-09-06 に
e2e の resize 記録で発見。復元先を書き換える前に復元が起きていた）。

**画面内へクランプしない**。位置一致を優先する。上端がはみ出してタイトルバーが
届かなくなっても、Windows 11（26200 で 2026-09-06 に実測: 標準フレームのウインドウを
y = −150 に置き、左端のリサイズ境界をクリックのみ / 20px ドラッグ → いずれも
上端が y = 0 に揃った）はリサイズ境界の操作で上端をスクリーンに揃えるため、
アプリ側の補正は不要。Picasa も同じ復帰手段に依存している。

**ウインドウ表示中のレイアウト**。ストアの `view.windowed` が真の間はサムネイルバーを
除外せず、マージン 0 でクライアント領域全体に中央配置する（`viewerLayoutArea`）。
既定の「バーの上 + 20px マージン」のままだと、リサイズ直後の `resize` イベントが
画像を 40px 上へ寄せ、位置一致が壊れる。フラグは `resizeToImage` 成功時にだけ立て、
最大化 / フルスクリーンで下ろす。手動の「元のサイズに戻す」では立てない: 起動直後は
`get_window_state` の IPC が返るまで `isMaximized` が偽なので、非最大化 = ウインドウ表示
と定義すると起動時の fit がレイアウト面の広い方で計算され、最大化確定後にその
ズームのまま残る競合が生じる。

**復元は 1 回のジオメトリ変更で行う**（2026-09-06 追記）。tao の `unmaximize` は
`ShowWindow(SW_RESTORE)` で、Windows は**最大化前の復元矩形**（起動時の 800×600）へ戻す。
その後 `set_size` / `set_position` で 2 回動かすと画像が経路上で動いて見え、さらに DWM は
最大化→復元の遷移に直前フレーム全体を縮小するアニメーション（150〜200ms）を掛ける。
対策: (1) 処理中だけ `DWMWA_TRANSITIONS_FORCEDISABLED` を立て、成否に関わらず終了時に戻す。
(2) `SetWindowPlacement` で `rcNormalPosition` だけを目標の外枠矩形に書き換えてから
tao の `unmaximize` を呼ぶ。tao は最大化状態を自前フラグで持ち（`is_maximized` は
`IsZoomed` を見ない）`WM_SIZE` で同期するため、`SW_RESTORE` 自体は tao 経由でなければ
以後の `maximize` が no-op になる。外枠は `AdjustWindowRectExForDpi`（`WS_MAXIMIZE` を
外した現在のスタイル、DPI = scale × 96）で求め、`rcNormalPosition` はワークスペース座標
（プライマリ作業領域の原点基準。タスクバーが上・左にあるとスクリーン座標とずれる）に
変換する。復元後に `inner_size` / `inner_position` を検証し、ずれていれば 1 回だけ補正する
（フォールバック）。ワークスペース座標の原点は**副モニタ上でもプライマリの作業領域**である
（2026-09-06 実測: 副モニタが x = 2560 から始まる構成で、画面座標 (2700, 100) に置いた
素の Win32 窓の `rcNormalPosition` は 2700,100 と報告され、`rcNormalPosition` に画面座標
(3000, 200) を書いて `SW_RESTORE` すると画面座標 (3000, 200) に復元された）。
`MonitorFromWindow` の作業領域で変換すると副モニタで 2560px ずれるので採用しない。

**ウインドウ表示を抜けるとき pan は保持する**。入るときの畳み込みは見た目を変えない操作で、
その後の再レイアウトが窓の配置（pan 込みの中心で決めた）と一致するために必要だった。
抜けるとき（最大化 / フルスクリーン）は他のあらゆるリサイズと同じく
`fitToWindow(preserveZoom)` の流儀で pan を保持する。ここで pan を 0 にすると画像が
跳ぶだけで、Picasa にも対応する挙動は無い。

**失敗パスと別ファイルの open**。IPC 中は `windowed` を先に立てているので、その間に
ナビゲーションで表示された画像は「クライアント領域全体」で fit されている。IPC が失敗して
最大化のままになったら、その fit は利用者の選んだズームではないので保持せず、最大化用の
領域で fit し直す（`refitCurrentImage`）。同様に `openImageFromPath` は
`maximize_window` を呼ぶので、開始時点で `windowed` を下ろし、最大化イベントより先に
画像が読み込まれても最大化用の領域で fit されるようにする。
`set_restore_rect` は `unmaximize` より前に `rcNormalPosition` を書くため、万一 `unmaximize`
が失敗すると最大化のまま復元先だけが画像サイズを指す（次に利用者が手動で復元すると
そのサイズになる）。`ShowWindow(SW_RESTORE)` は実質失敗しないので補正は入れていない。

**`get_window_state` の応答は最新の問い合わせ分だけ適用する**（`useWindowState`）。
`tauri://resize` ごとに問い合わせるため、最大化中に発行された問い合わせの応答が復元後の
応答より遅れて届くと、`setMaximized(true)` → `leaveWindowedView` で小さい窓のまま
最大化レイアウトに戻ってしまい、次の実際の最大化まで直らない。連番で古い応答を捨てる。フロントは `windowed` を IPC の**前**に立て、IPC 完了より先に届く
`resize` イベントの再レイアウトが最初から最終配置になるようにする（失敗時は戻す）。
WebView2 が新サイズのフレームを描くまでの 1〜2 フレームは旧フレームが左上基準で見える
可能性があり、これはアプリ側では消せない。

**pan は IPC の前にレイアウトへ畳み込む**（2026-09-06 追記）。ドラッグで pan した画像で
クリックすると、最初の再レイアウト（`fitToWindow(preserveZoom)` は pan を保持する）は
pan 分ずれた位置に置き、IPC 完了時の `panX/panY = 0` を `transform 0.1s` のトランジションが
アニメーションするため、画像がドラッグ位置からスライドインして見えた（e2e のフレーム記録:
リサイズ後 (−300, 40) に 2 フレーム留まり、5 フレームかけて (0, 0) へ）。Z1 の座標系では
要素中心 O を pan 分動かして pan を 0 にしても全点の画面位置は不変（`O + T + s·L`）なので、
`windowed` を立てるのと同時に `imageLeft/Top += pan, pan = 0` と畳み込み、その瞬間だけ
`suppressTransition` でトランジションを止める。以後 transform は変わらず、再レイアウトは
left/top（トランジション対象外）だけを動かす。IPC 失敗時は畳み込みも戻す（畳み込んだまま
だと後続の `preserveZoom` 再レイアウトが pan 0 で中央へ戻し、ドラッグ位置が失われる）。

参照元: `src/utils/windowedGeometry.ts`（`windowedClientBox`）、
`src/utils/viewerLayout.ts`（`viewerLayoutArea`）、
`src/store/index.ts`（`resizeToImage` / `leaveWindowedView`）、
`src-tauri/src/commands/window.rs`（`resize_window_to_image` / `restore_onto`）

## W2

**撤去: 起動直後の前面再主張（`SetForegroundWindow`、起動ファイルありの起動に限り `run_start` から 1500ms 以内・最大 2 回）**

2026-09-21 に実装したが、同日のうちに撤去した。実機では前面が失われる状態が一度も起きなかった。
エクスプローラーからの 260 起動すべてで `window_created` が `foreground_is_ours:true`、
`foreground_reassert` の発動は 0 回だった。報告された症状は「前面は自分のまま z だけ起動元の下」
で、それは W3 が扱う。前面が失われる状態は `window_created` の `foreground_is_ours:false` で
今も検出できるので、観測されたら以下の設計で再導入を検討する。

以下は実装時の根拠（撤去後も有効な事実を含む）。

エクスプローラーから起動されたプロセスは前面化権を持つが、ダブルクリック直後の
追加入力やエクスプローラー側の再前面化で、最初の `ShowWindow` によるアクティブ化が
取り消されることがある（2026-09-20 報告: Spica がエクスプローラーの背面に出る）。
ウインドウを最初から最大化で生成する前（PR #310 以前）は、フロントが起動 ~500ms 後に
呼ぶ `maximize_window` が `ShowWindow(SW_MAXIMIZE)` になり、この取り消しを事実上
やり直していた。最大化生成後は同じ呼び出しが tao の `apply_diff` でフラグ差分なしと
判定され no-op になり、やり直しが消えた（`tao-0.35.3/src/platform_impl/windows/window_state.rs`
`apply_diff` の `diff == empty` 早期 return）。

その代替として `SetForegroundWindow` を、`window_created` / `page_load_finished` /
`Focused(false)` の各契機で、前面が自ウインドウでないときだけ呼ぶ。前面化権が失効して
いれば OS が拒否するので、ユーザーが意図して他ウインドウへ移った場合は奪えない
（奪わない）。1500ms は起動タイムライン（`page_load_finished` ~330ms、旧
`maximize_window` ~500ms）を余裕を持って含み、かつユーザーが次の操作に移る前に収まる
値。2 回は「最初から取れなかった」と「取れた後に戻された」の両方を 1 回ずつ拾える最小値。

`Focused(false)` は WebView2 子ウインドウがキーボードフォーカスを取るときにも毎回発火する
（tao は `WM_KILLFOCUS` で出す）が、そのとき `GetForegroundWindow()` はトップレベルの
自ウインドウのままなので `is_ours` で弾かれる。

**採らない案**: tao の `set_focus()` は前面化に失敗すると合成 ALT キーを前面アプリへ送り
（`force_window_active`）、エクスプローラーをメニューモードに落とす。`maximize_window` を
非最大化生成に戻して旧挙動を再現する案は、起動時の 800×600 → 最大化のジャンプを
復活させる。

参照元: `src-tauri/src/commands/window.rs`（`raise_startup_z` の doc: 撤去の記録）、
`docs/superpowers/plans/2026-09-20-explorer-launch-foreground.md` §1.4 / §1.5

## W3

**起動直後の z オーダー是正: 前面が自分なのに覆われているとき、起動ファイルありの起動に限り窓の生成から 1500ms 以内・最大 2 回 `SetWindowPos(HWND_TOP, SWP_NOACTIVATE)`**

実機検証（2026-09-21、15ms 周期の読み取り専用ウォッチャー）で、報告された症状は
「前面が自分でない」状態ではなく **「前面は自分（`GetForegroundWindow()` == 自 HWND、
`focused:true`）のまま、起動元エクスプローラー窓だけが z オーダーで自分の上に居る」**
状態だと判った。Spica の窓は最上位・前面で現れ（`run_start` +~35ms）、その 22〜54ms 後に
起動元エクスプローラー窓（非最大化・非 topmost）がアクティブ化を伴わずに z だけ上へ来る。
Spica 側から観測できる最初の契機（`window_created`、+~500ms）より前に終わっている。
前面を取り戻す W2（撤去）は、前面が自分のときは何もしないので、この状態には効かなかった。

この 1 状態が元報告の両方を説明する: 「背面に出る」は z の話であり、「クリックしても
前面化しない」は、既に前面（アクティブ）なウインドウをクリックしても OS は何もしない
（アクティブ化が起きないので z も動かない）ため。他アプリへ一度フォーカスを移してから
クリックすると、アクティブ化が z も最上位へ戻す（ウォッチャーで確認）。

対策は、起動ファイルありの起動に限り、`window_created` / `page_load_finished` で
「前面は自分 かつ 自分より上に覆っているウインドウがある」なら
`SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)` を
呼ぶ。1500ms は窓の生成（`.build()` の戻り = `window_created`）から数え、ユーザーが次の
操作に移る前に収まる値。`run_start` から数えると、WebView2 が冷えている起動（インストール
直後など。窓の生成まで 0.9〜2.5 秒を計測したことがある）では `window_created` の時点で枠を
過ぎてしまう。持ち上げは窓の出現直後に起きるので、その起動では直されずに残る。実機 267 起動
では `window_created` は `run_start` から最大 817ms、`page_load_finished` はその ~50〜150ms 後
なので、どちらの契機も窓の生成からの枠に十分収まる。前面が自分のときしか動かないので、起点を
後ろへずらしても前面を奪う危険は増えない。2 回は 2 つの契機に 1 回ずつ。
実機では持ち上げは起動 1 回につき 1 度きりで、すべて `window_created` の 1 回で直り、
再び覆われることは無かった（2026-09-21、`z_raise` 17 回すべて `ok:true`、覆われていた
時間は 0.44〜0.49 秒）。旧 `maximize_window` の `SW_MAXIMIZE` も ~0.5 秒後に z を
戻していたはずなので、見た目は #310 以前と同等になる。

- **`SWP_NOACTIVATE` の理由**: 動かすのは z だけでよい。前面は既に自分なので
  アクティブ化を再要求する必要が無く、要求すると OS の前面化判定をもう一度通ることになる
  （拒否されれば無意味、通れば余計なフォーカスイベント）。前面が自分のときにしか動かない
  ので、この呼び出しがユーザーからフォーカスを奪うことは無い。
- **`HWND_TOP` は topmost を越えない**: `HWND_TOP` は非 topmost 帯の先頭に置くだけで、
  `WS_EX_TOPMOST` のウインドウ（タスクバー、常に手前のツール）より上には行けない。
  そのため「覆っているウインドウ」の判定から topmost を除き、topmost しか上に無い状態では
  呼ばない（呼んでも変わらない）。
- **「覆っている」の判定**: 自分より z が上で、可視・非最小化・`WS_EX_TOOLWINDOW` でない・
  `WS_EX_TOPMOST` でない・DWM cloaked でない（別仮想デスクトップや UWP の休止窓）・
  所有ウインドウでない（ツールチップ・ポップアップ）・矩形が自分の矩形と交差する（別モニタの
  ウインドウで無駄に動かさない）、をすべて満たす最初の 1 枚。列挙は `GetTopWindow(NULL)` →
  `GetWindow(GW_HWNDNEXT)` を自 HWND まで。自 HWND に到達せずに列挙が終わった場合は
  何も言えないので動かない。
- **引き金は W5 で特定・除去した**（最初の表示が `SW_MAXIMIZE`）。以下は特定前の記録。
  W3 は行為者に依存しない保険として残す。
- **Spica 固有**（plan §1.5）。同じ窓・同じフォルダ・同じ手順で
  Picasa Photo Viewer を起動しても、エクスプローラーは持ち上がらなかった（Picasa 0/40、
  Spica 8/40）。発生は、エクスプローラーでフォルダを移動した直後の最初の起動に強く偏る
  （その日まだ起動していない NAS フォルダで 6/18、同じフォルダを繰り返し起動すると 2/63）。起動時の `explorer_sort` COM プローブは引き金では
  ない。走査とプローブをウインドウ生成の後へ遅らせたビルドでも、プローブが走る前に持ち上げが
  起きた（W4、非採用）。この対策は行為者に依存しない。旧 `maximize_window`
  （`ShowWindow(SW_MAXIMIZE)`）が z も直していた、というのは推定であり、確定した回帰機構（W2）
  とは別扱い。

トレース: 発動時に perf ログへ `z_raise`（`at` / `above` / `ok` / `err`）を 1 行。
通常起動では出ない。`window_created` 行の `z_above`（覆っている HWND、無ければ 0）で
外部ウォッチャー無しでもこの状態を読める。

参照元: `src-tauri/src/commands/window.rs`（`covering_window` / `should_raise_z` /
`raise_startup_z` / `native::windows_above` / `native::raise_to_top`）、
`src-tauri/src/lib.rs`（`window_created` / `on_page_load`）、
`docs/superpowers/specs/2026-09-20-explorer-launch-foreground-checklist.md` 判定表

## W4

**非採用: 起動時のフォルダ先読み（と Explorer ソートプローブ）をウインドウ生成の後へ遅らせる**

W3 の状態（前面は自分・z だけ起動元エクスプローラーの下）の引き金として、起動時の
`explorer_sort` COM プローブ（エクスプローラーの UI スレッドへの RPC）が最初のウインドウ表示と
重なることを疑った。そこで、サムネイル先読みだけをウインドウ生成前に始め、フォルダ走査
（プローブを含む）を `.build()` が返った後に始めるビルドを作った（2026-09-21、`835fd89`）。
実機では、この版でも持ち上げが起きた。ウォッチャーでは窓が現れて +23ms、`window_created` の
`z_above` も起動元だった。どちらもプローブが走る前なので、プローブは引き金ではない
（plan §1.5）。事象を防げず、フォルダ一覧が遅れる代償だけが残るので revert した。

- **代償の実測（参考）**: ローカル 30 枚、`e2e/scripts/profile-startup.mjs` で直前のビルドと
  交互に 9 起動ずつ、`window_created` 起点。`folder:scanned` は、ウインドウ生成の速い回で差が
  無く、遅い回で +40ms。首枚の paint は変わらない。走査の長い NAS・大フォルダでは、遅れが
  ウインドウ生成の時間（~300〜500ms）に近づく。
- 同じ理由で、プローブだけを遅らせる案も効かない。

参照元: `src-tauri/src/commands/startup.rs`（モジュール doc）、plan §1.5 / Task C3

## W5

**ファイル付き起動の窓は最大化で生成しない: 非最大化のまま、生成中（`WM_CREATE`）に最大化時の外枠の矩形へ置き、`.build()` の後で最大化する**

W3 の持ち上げ（起動元エクスプローラー窓が、前面は取らずに z だけ Spica の上へ来る）の
引き金は、**窓の最初の表示が `SW_MAXIMIZE` であること**（Issue #333、2026-09-26）。
PR #310 以降、ファイル付き起動では `.maximized(true)` で窓を生成しており、tao 0.35.3 は
非可視のまま `set_maximized(true)` を適用して `ShowWindow(SW_MAXIMIZE)` を呼ぶ。これがその窓の
最初の表示になり、続けて `SW_SHOW` → `SW_MAXIMIZE` と呼ぶ（`platform_impl/windows/window.rs`
`init` と `window_state.rs` `apply_diff`）。

実機での判別（新しい NAS フォルダへ移動した直後の起動、10 回ずつのブロックを交互に計測、
perf.log と 15ms ウォッチャー `scripts/zwatch.ps1` の結果が全ブロックで一致）:

| 最初の表示 | 持ち上げ |
|---|---|
| `SW_MAXIMIZE`（最大化生成＝#310 以降の現行） | 36 / 70 |
| `SW_SHOW`（非最大化。800×600 / 最大化サイズ / 表示 2ms 後〜0.5 秒後に最大化 など 6 通り） | 0 / 70 |

最初の表示が非最大化であれば、その 2ms 後に最大化しても持ち上げは起きない。したがって
「最大化すること」自体や、そのタイミングの早さは引き金ではない。持ち上げが起きる仕組み
（OS／エクスプローラー側で何が反応しているか）は未解明。

実装:
- `.maximized(true)` を使わない。`.build()` の間だけ、スレッドローカルの
  `WH_CALLWNDPROCRET` フックを仕掛ける。フックは、このスレッドで作られる最初の「キャプション
  付き・非子」ウインドウ（＝メインウインドウ。WebView2 の窓は子ウインドウで、tao のイベント用の
  窓は `.build()` より前に作られている）の `WM_CREATE` で、`SetWindowPos` を 1 回呼ぶ。移す先は、
  その窓が置かれたモニター（`MonitorFromWindow`）で最大化したときの外枠の矩形。フックは
  `WM_CREATE` をウインドウプロシージャの後、`CreateWindowEx` が戻る前に受け取るので、tao はまだ
  窓を表示していない。
- 最初の表示は `SW_SHOW` になる。そのときのクライアント領域は、最大化時と同じ位置・大きさ。
- `.build()` の後（`window_created` のトレースの後）に `maximize()` する。この時点で矩形はもう
  同じなので、見た目で変わるのはキャプションボタンの絵柄だけになる。フロントの
  `maximize_window` は、従来どおり no-op のまま。
- 最大化した直後に、戻り先（`rcNormalPosition`）を、設定サイズ 800×600 のクライアントを作業領域の
  中央に置いた矩形に書き換える。現行の最大化生成でも、戻り先は `CW_USEDEFAULT` で OS が決めた
  位置の 800×600 だった。書き換えないと、戻り先が最大化の矩形のままになり、タイトルバーの
  「元に戻す」を押しても何も変わらないように見える。

- **外枠の矩形は自前で置く必要がある**: tao は、初期位置がモニターの上端より上（y が負）だと
  その位置を捨てて `CW_USEDEFAULT` にする（`window.rs` `init` の monitor 判定）。最大化時の
  外枠は枠の太さだけ作業領域の外にはみ出す（100% で (-8,-8,2568,1400)）ので、ビルダーの
  `position` では指定できない。作業領域の左上に置いてクライアントの大きさだけ合わせる案では、
  最大化のときに窓全体が 8px 動き、ユーザーの目視で「気になる」とされた。
- **採らない案**:
  - 最初の表示の直後に `SW_MAXIMIZE` する（フック内で同期、または別スレッドから）。持ち上げは
    0/10 と 0/10 で消えた。ただ、フック内の `SW_MAXIMIZE` は矩形を動かすだけで、最大化の状態
    としては定着しなかった（`IsZoomed` は false のまま。原因は未調査）。別スレッドからの呼び出しは、
    メインスレッドの応答を待つ間の 40〜50ms、非最大化の状態が画面に出る。
  - DWM の遷移を止める（`DWMWA_TRANSITIONS_FORCEDISABLED`）。窓がフェードなしで一瞬で出て、
    目視で「少し違和感」とされた。
  - 非表示で生成し、WebView2 の初期化後に最大化で表示する。窓が出るのが ~0.47 秒遅れるうえ、
    最初の表示は `SW_MAXIMIZE` のままになる。

トレース: `first_show_rect`（`ok` / `rect` / `err`）と `startup_maximize`（`ok` / `err`）を
それぞれ 1 行ずつ出す。`window_created` の `z_above` は最大化の前に読む。持ち上げが再発した
ときに、最初の表示が残した状態のまま観測できるようにするため。

参照元: `src-tauri/src/commands/window.rs`（`FirstShowPlacement` / `maximize_born_window` /
`maximized_outer_rect` / `centered_restored_rect` / `native::first_show_hook`）、
`src-tauri/src/lib.rs`（`setup`）、Issue #333 のコメント（ブロックごとの計測）

## W6

**生成直後に WebView2 を隠し、ページのロード完了で表示する**

ファイル付き起動で、最初の画像が出る直前に暗い灰色の矩形が一瞬（約 3 フレーム）見える
（Issue #342）。矩形の色は録画で #131313、Chromium の about:blank をダーク配色で描いた色
（#121212、Edge 153 の headless で実測）と一致する。仕組み:

- wry（0.55）は `Navigate` の直後に WebView2 を可視化する。ナビゲーションが確定するまで
  WebView2 は初期ページ about:blank を描いている。
- tauri-runtime-wry は窓のテーマ（Windows の「アプリのモード」）を WebView2 プロファイルの
  `PreferredColorScheme` に写す。ダークのとき Chromium は about:blank を #121212 の不透明な
  キャンバスで描くので、設定の `backgroundColor: #000000`（`DefaultBackgroundColor` には届いて
  いる）は透けない。
- 窓は W1/W5 により生成時から見えているので、WebView2 の生成（`.build()` の戻り）から本アプリの
  HTML の最初の描画までの間だけ about:blank が露出する。手元の 1 画素サンプリングでは、起動
  743〜791ms が #121212、その前後は #000000（`scripts/startup-frames.ps1`）。

実装:
- `.build()` の直後に `Webview::hide()`（`hide_webview_until_loaded`）。wry は WebView2 を
  `WRY_WEBVIEW` クラスの子 HWND に入れているので、隠れるのは WebView2 だけで、トップレベルの窓
  （黒いブラシ）、W5 の配置、W3 の前面化は影響を受けない。`setup` はメインスレッドなので、
  tauri-runtime-wry はメッセージを同期に処理する（Chromium がフレームを出す前に隠れる）。
- `on_page_load` の `Finished`（`NavigationCompleted` ＝ document の load）で `show()` と
  `set_focus()`（`reveal_webview`）。load の時点でレンダーブロッキングの CSS は適用済みなので、
  表示後の最初のフレームは本アプリの黒になる。`Started`（`ContentLoading`）は CSS 適用前の
  可能性があるので使わない。
- 隠している間に動く本アプリの JS は、`main.tsx` の実行から load までの数 ms だけ
  （`app:script_start` → `page_load_finished` は 3ms）。非表示ページのタイマー抑制や rAF 停止が
  画像ロード（`open:request` 以降）に及ぶことはない。
- 保険: `WEBVIEW_REVEAL_FALLBACK`（3 秒）後に別スレッドから `reveal_webview`。ページロードが
  来ない（dev サーバー停止、ナビゲーション失敗）場合でも窓が黒いまま操作不能にならない。
  どちらが先でも 1 回だけ作用する（`first_reveal`）。
- ファイル付きかどうかによらず適用する。ウェルカム画面の起動でも同じ露出がある。

**採らない案**:
- 窓を非表示で生成し、ロード後に表示する（Tauri の定番）。W5 が避けた「最初の表示が
  `SW_MAXIMIZE`」に戻るうえ、窓が出るのが WebView2 の初期化分（約 0.5 秒）遅れる。
- WebView2 の配色を Light にする。about:blank が白になり、より目立つ。窓のテーマ（タイトルバー）
  とも連動している。
- 表示の引き金をフロント（最初の画像データの到着）にする。隠れている間に `setTimeout(0)` を
  使う画像ロードが動くことになり、非表示ページのタイマー抑制で遅れる恐れがある。

トレース: `webview_hidden`（`ok` / `err`）と `webview_shown`（`by`: `page_load_finished` /
`fallback`、`ok` / `err`）。

参照元: `src-tauri/src/commands/window.rs`（`hide_webview_until_loaded` / `reveal_webview` /
`WEBVIEW_REVEAL_FALLBACK`）、`src-tauri/src/lib.rs`（`setup`、`on_page_load`）、
`scripts/startup-frames.ps1`
