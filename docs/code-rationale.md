# コード根拠集（code rationale）

`docs/superpowers/specs/` 配下の設計ドキュメントが日付付きの設計記録であるのに対し、
このファイルは実装に張り付いた根拠を蓄積する生きたドキュメントである。
コードのコメントから 1 行で参照される。

各節はコードから `— docs/code-rationale.md#<anchor>` の形で参照される。
節を削除・改名するときは参照元も同時に直すこと。

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

（`preview.rs:144-155`、`icc_applies` の doc コメント全文）

同じ判断が参照されている補足箇所:

- `preview.rs:91-93`（`Decoded::original_color` フィールドの説明）:

  > The source file's color type *before* decoding converted it (X1) — a CMYK/YCCK
  > JPEG is already RGB pixels in `image` by the time it's a `DynamicImage`, but
  > `original_color` still says `Cmyk8`.

- `preview.rs:109`（`decode_oriented` 内。`from_decoder` が decoder を消費する前に読む必要があるという注記）:

  > X1: must be read before `from_decoder` consumes the decoder.

- `preview.rs:252-255`（`generate` 内。coordinator follow-up の注記）:

  > X1 + coordinator follow-up: the decoder's original color type is checked (correct
  > for formats whose decoders do report CMYK, e.g. TIFF), AND the profile's own
  > header is checked, because `image` 0.25's JPEG decoder reports CMYK/YCCK sources
  > as RGB regardless.

- `preview.rs:346-348`（テスト `icc_applies_only_to_rgb_like_color_types` 内）:

  > X1: this is the case that motivated switching from the decoded `DynamicImage`'s
  > color (always RGB8 post-decode) to the source's original color type — a
  > CMYK/YCCK JPEG must not carry its profile.

- `preview.rs:437-439`（テスト `generate_drops_cmyk_icc_profiles` 内）:

  > The decoded pixels are RGB either way (X1's caveat: `image` 0.25's JPEG decoder
  > reports CMYK/YCCK sources as RGB too), so this profile header is the only signal
  > that stops it being carried through.

参照元: `src-tauri/src/utils/preview.rs`

## X2

**エンコーダが拒否する ICC プロファイル長は、失敗させず無視して続行する**

- `preview.rs:218-220`（`encode_jpeg` 内）:

  > X2: a profile the encoder refuses (e.g. > 254 APP2 chunks, so over ~15.9 MB) must
  > not fail the whole preview — degrade to no ICC rather than lose the bar thumbnail
  > generated alongside it.

- `preview.rs:456-462`（テスト `generate_degrades_gracefully_when_the_icc_profile_is_too_large_to_attach` 内）:

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

（`preview.rs:123-126`、`flatten_to_rgb8` の doc コメントより）

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

（`preview.rs:177-183`、`resize_rgb8` の doc コメントより）

参照元: `src-tauri/src/utils/preview.rs`
