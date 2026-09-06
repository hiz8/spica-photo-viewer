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
（フォールバック）。フロントは `windowed` を IPC の**前**に立て、IPC 完了より先に届く
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
