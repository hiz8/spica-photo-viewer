# Explorer ファイルタイプアイコンの分離 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本アプリを画像ファイルの既定アプリにしたとき、エクスプローラーのファイルアイコンだけをアプリ本体のアイコンと別のものにする。スタートメニュー・デスクトップ・タスクバーは現在のアイコンのまま維持する。

**Architecture:** exe に 2 個目のアイコングループ（リソース ID 32513）を `tauri-build` の `append_rc_content` で埋め込み、NSIS の `installerHooks` で各 ProgID と `Applications\<exe>` の `DefaultIcon` を `"...exe",-32513` に書き換える。ショートカットはアイコン引数なしで作られ exe の最小 ID（32512）を拾うため、自動的に分離される。

**Tech Stack:** Node.js + sharp（.ico 生成）、Rust build script（`tauri-build` 2.6 の `WindowsAttributes::append_rc_content`）、NSIS（`installerHooks`）、PowerShell（検証スクリプト）

**Spec:** `docs/superpowers/specs/2026-09-12-file-type-icon-design.md`

## Global Constraints

これらは全タスクの要件に暗黙に含まれる。値は spec からそのまま写している。

- ファイルタイプアイコンのリソース ID は **32513**。`tauri-build` が本体アイコンに使う 32512 より**大きい**値でなければならない（F1）
- `DefaultIcon` は序数ではなく負値のリソース ID 指定 `"...exe",-32513` を使う（F2）
- 対象拡張子は `jpg` / `jpeg` / `png` / `webp` / `gif` の 5 つ
- ProgID 名は `SpicaPhotoViewer.jpeg`（jpg と jpeg で共有）/ `SpicaPhotoViewer.png` / `SpicaPhotoViewer.webp` / `SpicaPhotoViewer.gif`
- description は `JPEG Image` / `PNG Image` / `WebP Image` / `GIF Image`
- `.ico` に入れるサイズは 16 / 24 / 32 / 48 / 64 / 256 の 6 種
- `tauri-build` の依存要求は `"2.6"` 以上（`append_rc_content` は 2.5.6 に無い）（F11）
- バンドルターゲットは NSIS のみ（F9）
- `.nsh` のトップレベルで `${MAINBINARYNAME}` を参照しない。マクロ本体の中でのみ参照する（F10）
- コミット前に `npm run lint:fix` と `npm run format:fix` を実行する（CLAUDE.md）

---

## File Structure

| ファイル | 責務 |
|---|---|
| `scripts/build-file-icon.mjs`（新規） | SVG → 6 サイズの PNG → ICO コンテナ組み立て。純粋関数 `buildIco` と CLI |
| `scripts/__tests__/build-file-icon.test.mjs`（新規） | `buildIco` のバイナリレイアウト検証 |
| `src-tauri/icons/file-type.svg`（新規） | ファイルタイプアイコンの原図 |
| `src-tauri/icons/file-type.ico`（新規、生成物だが commit） | exe に埋め込む .ico |
| `src-tauri/build.rs`（変更） | `append_rc_content` で 32513 を埋め込む |
| `src-tauri/Cargo.toml`（変更） | `tauri-build` 要求を `"2.6"` へ |
| `src-tauri/tauri.conf.json`（変更） | `targets` / `fileAssociations` / `installerHooks` |
| `src-tauri/installer-hooks.nsh`（新規） | `DefaultIcon` の上書きと後片付け |
| `scripts/verify-file-type-icon.ps1`（新規） | exe のアイコン ID とレジストリ 5 箇所の検証 |
| `package.json`（変更） | `build:file-icon` と そのテストのスクリプト |
| `PROJECT_SPEC.md`（変更） | Installer Creation 節を NSIS 前提に更新 |

---

## Setup（Task 1 の前に 1 回だけ）

- [ ] **worktree に依存をインストールする**

```bash
npm install
```

これをやらないと Task 1 の `sharp` も Task 4 の `npm run tauri build`（`beforeBuildCommand` が `tsc` と `vite build` を走らせる）も動かない。`package-lock.json` に改行コードだけの差分が出た場合は戻す。

**時間の見積もり**: この worktree には Rust の `target/` が無いので、Task 3 の `cargo build --release` は依存込みのフルビルドになり数分から十数分かかる。止まったように見えても待つこと。

**e2e への副作用**: Task 4 の `npm run tauri build` は release バイナリを上書きするため、この worktree で e2e を回す予定があるなら後で `npm run bench:build` を実行して計測用 exe を作り直すこと。

---

## Task 1: ICO ビルダー

`.ico` コンテナを組み立てる純粋関数と CLI。アートワークに依存しないので最初に片付ける。

**Files:**
- Create: `scripts/build-file-icon.mjs`
- Create: `scripts/__tests__/build-file-icon.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: なし
- Produces:
  - `ICON_SIZES: number[]` — `[16, 24, 32, 48, 64, 256]`
  - `buildIco(images: { size: number, png: Buffer }[]): Buffer`
  - `renderIco(svgPath: string, icoPath: string): Promise<{ size: number, png: Buffer }[]>`
  - CLI: `node scripts/build-file-icon.mjs <input.svg> <output.ico>`

- [ ] **Step 1: 失敗するテストを書く**

`scripts/__tests__/build-file-icon.test.mjs` を作る:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildIco, ICON_SIZES } from "../build-file-icon.mjs";

function readDirectory(ico) {
  const count = ico.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + 16 * i;
    entries.push({
      width: ico.readUInt8(o),
      height: ico.readUInt8(o + 1),
      paletteCount: ico.readUInt8(o + 2),
      planes: ico.readUInt16LE(o + 4),
      bitCount: ico.readUInt16LE(o + 6),
      bytesInRes: ico.readUInt32LE(o + 8),
      imageOffset: ico.readUInt32LE(o + 12),
    });
  }
  return { reserved: ico.readUInt16LE(0), type: ico.readUInt16LE(2), count, entries };
}

test("the header declares an icon file with one entry per image", () => {
  const ico = buildIco([
    { size: 16, png: Buffer.from("a") },
    { size: 32, png: Buffer.from("bb") },
  ]);
  const dir = readDirectory(ico);
  assert.equal(dir.reserved, 0);
  assert.equal(dir.type, 1);
  assert.equal(dir.count, 2);
});

test("256 is written as 0 because the field is one byte wide", () => {
  const [entry] = readDirectory(buildIco([{ size: 256, png: Buffer.from("a") }])).entries;
  assert.equal(entry.width, 0);
  assert.equal(entry.height, 0);
});

test("sizes below 256 are written verbatim", () => {
  const [entry] = readDirectory(buildIco([{ size: 48, png: Buffer.from("a") }])).entries;
  assert.equal(entry.width, 48);
  assert.equal(entry.height, 48);
});

test("each entry points at its own payload", () => {
  const first = Buffer.from("first");
  const second = Buffer.from("second-payload");
  const ico = buildIco([
    { size: 16, png: first },
    { size: 32, png: second },
  ]);
  const [a, b] = readDirectory(ico).entries;
  assert.equal(a.bytesInRes, first.length);
  assert.equal(b.bytesInRes, second.length);
  assert.deepEqual(ico.subarray(a.imageOffset, a.imageOffset + a.bytesInRes), first);
  assert.deepEqual(ico.subarray(b.imageOffset, b.imageOffset + b.bytesInRes), second);
});

test("the first payload starts immediately after the directory", () => {
  const ico = buildIco([
    { size: 16, png: Buffer.from("a") },
    { size: 32, png: Buffer.from("b") },
  ]);
  assert.equal(readDirectory(ico).entries[0].imageOffset, 6 + 16 * 2);
});

test("entries declare truecolor so Windows keeps the alpha channel", () => {
  const [entry] = readDirectory(buildIco([{ size: 16, png: Buffer.from("a") }])).entries;
  assert.equal(entry.paletteCount, 0);
  assert.equal(entry.planes, 1);
  assert.equal(entry.bitCount, 32);
});

test("the icon ships every size Explorer asks for", () => {
  assert.deepEqual(ICON_SIZES, [16, 24, 32, 48, 64, 256]);
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `node --test scripts/__tests__/build-file-icon.test.mjs`
Expected: FAIL — `Cannot find module '../build-file-icon.mjs'`

- [ ] **Step 3: 実装する**

`scripts/build-file-icon.mjs` を作る:

```js
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

// 16 は詳細/一覧/小アイコン表示が、256 は拡大アイコン表示が使う。
// 既存 src-tauri/icons/icon.ico と同じ構成に揃えている。
export const ICON_SIZES = [16, 24, 32, 48, 64, 256];

const HEADER_BYTES = 6;
const DIR_ENTRY_BYTES = 16;

export function buildIco(images) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16LE(1, 2); // 1 = アイコン (2 はカーソル)
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(DIR_ENTRY_BYTES * images.length);
  let offset = HEADER_BYTES + directory.length;
  images.forEach((image, i) => {
    const o = DIR_ENTRY_BYTES * i;
    // 幅と高さは 1 バイトしかないので、256 は 0 で表すのが ICO の約束。
    const dimension = image.size === 256 ? 0 : image.size;
    directory.writeUInt8(dimension, o);
    directory.writeUInt8(dimension, o + 1);
    directory.writeUInt16LE(1, o + 4);
    directory.writeUInt16LE(32, o + 6);
    directory.writeUInt32LE(image.png.length, o + 8);
    directory.writeUInt32LE(offset, o + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

export async function renderIco(svgPath, icoPath) {
  const svg = await readFile(svgPath);
  const images = await Promise.all(
    ICON_SIZES.map(async (size) => ({
      size,
      png: await sharp(svg)
        .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer(),
    })),
  );
  await writeFile(icoPath, buildIco(images));
  return images;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: node scripts/build-file-icon.mjs <input.svg> <output.ico>");
    process.exit(1);
  }
  const images = await renderIco(input, output);
  const summary = images.map((i) => `${i.size}px ${i.png.length}B`).join(", ");
  console.log(`wrote ${output} (${summary})`);
}
```

`package.json` の `scripts` に 2 行足す（`bench:corpus` の下あたり、既存の `verify:comments:test` と同じ流儀）:

```json
"build:file-icon": "node scripts/build-file-icon.mjs src-tauri/icons/file-type.svg src-tauri/icons/file-type.ico",
"build:file-icon:test": "node --test scripts/__tests__/build-file-icon.test.mjs",
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npm run build:file-icon:test`
Expected: PASS（7 tests）

- [ ] **Step 5: コミット**

```bash
npm run lint:fix && npm run format:fix
git add scripts/build-file-icon.mjs scripts/__tests__/build-file-icon.test.mjs package.json
git commit -m "build(icons): add an ICO builder for the file-type icon"
```

---

## Task 2: アートワーク

原図を描き、`.ico` を生成する。**このタスクには人間の選定が入る。**

**Files:**
- Create: `src-tauri/icons/file-type.svg`
- Create: `src-tauri/icons/file-type.ico`

**Interfaces:**
- Consumes: Task 1 の `renderIco(svgPath, icoPath)` と `npm run build:file-icon`
- Produces: `src-tauri/icons/file-type.ico`（Task 3 が埋め込む）

- [ ] **Step 1: 叩き台を 3 案描く**

`public/icon.svg`（1024×1024、菱形＋レンズ）を下敷きに、紙／写真のメタファを主役にした案を 3 つ、`.scratch/icons/draft-a.svg` / `draft-b.svg` / `draft-c.svg` として書く。viewBox は `0 0 1024 1024` に揃える。`.scratch/` は commit しない作業用ディレクトリで、Task 2 の最後に削除する。

- [ ] **Step 2: 各案を 16px と 32px にラスタライズして比較する**

素の sharp で PNG を出す。16px は等倍だと判断しづらいので、最近傍で 8 倍に拡大したものも並べる:

```bash
node -e "
const sharp = require('sharp');
(async () => {
  for (const name of ['a', 'b', 'c']) {
    const src = '.scratch/icons/draft-' + name + '.svg';
    for (const size of [16, 32]) {
      await sharp(src).resize(size, size).png().toFile('.scratch/icons/draft-' + name + '-' + size + '.png');
    }
    const small = await sharp(src).resize(16, 16).png().toBuffer();
    await sharp(small).resize(128, 128, { kernel: 'nearest' }).png()
      .toFile('.scratch/icons/draft-' + name + '-16-zoom.png');
  }
})();
"
```

生成した PNG を SendUserFile で提示し、どの案にするか選んでもらう。**16px で形が潰れる案は選択肢から外す。**

- [ ] **Step 3: 選ばれた案を `src-tauri/icons/file-type.svg` として確定する**

選定された SVG を配置する。選定時に出た修正指示（線を太く、要素を減らす等）があればここで反映する。

- [ ] **Step 4: `.ico` を生成する**

Run: `npm run build:file-icon`
Expected: `wrote src-tauri/icons/file-type.ico (16px ...B, 24px ...B, 32px ...B, 48px ...B, 64px ...B, 256px ...B)`

- [ ] **Step 5: 生成物のレイアウトを確認する**

```bash
node -e "
const d = require('node:fs').readFileSync('src-tauri/icons/file-type.ico');
const count = d.readUInt16LE(4);
console.log('type', d.readUInt16LE(2), 'count', count);
for (let i = 0; i < count; i++) {
  const o = 6 + 16 * i;
  const w = d.readUInt8(o) || 256;
  const isPng = d.readUInt32BE(d.readUInt32LE(o + 12)) === 0x89504e47;
  console.log(w + 'x' + w, d.readUInt16LE(o + 6) + 'bpp', d.readUInt32LE(o + 8) + 'B', isPng ? 'PNG' : 'BMP');
}
"
```
Expected: `type 1 count 6` と、16 / 24 / 32 / 48 / 64 / 256 の 6 行がすべて `32bpp` / `PNG`

- [ ] **Step 6: 作業用ディレクトリを消してコミット**

```bash
rm -rf .scratch
git add src-tauri/icons/file-type.svg src-tauri/icons/file-type.ico
git commit -m "feat(icons): add the Explorer file-type icon artwork"
```

`git status` に `.scratch/` が残っていないことを確認する。

---

## Task 3: exe への埋め込み

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/build.rs`
- Create: `scripts/verify-file-type-icon.ps1`

**Interfaces:**
- Consumes: `src-tauri/icons/file-type.ico`（Task 2）
- Produces: リソース ID 32513 のアイコングループを持つ `spica-photo-viewer.exe`、および検証スクリプト `scripts/verify-file-type-icon.ps1`（Task 4 がレジストリ検証を追記する）

- [ ] **Step 1: 検証スクリプトを書く（この時点では失敗する）**

`scripts/verify-file-type-icon.ps1` を作る:

```powershell
# Spec: docs/superpowers/specs/2026-09-12-file-type-icon-design.md
#
# ビルド済み exe に本体アイコン (32512) とファイルタイプアイコン (32513) の
# 両方が入っていることを確認する。LoadImage はシェルと同じ RT_GROUP_ICON の
# 解決を行うので、ID の指定ミスをそのまま検出できる。
param(
  [Parameter(Mandatory = $true)][string]$ExePath
)

$sig = @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern IntPtr LoadLibraryExW(string lpFileName, IntPtr hFile, uint dwFlags);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool FreeLibrary(IntPtr hModule);
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern IntPtr LoadImageW(IntPtr hInst, IntPtr name, uint type, int cx, int cy, uint fuLoad);
[DllImport("shell32.dll", CharSet=CharSet.Unicode)]
public static extern int ExtractIconExW(string lpszFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, int nIcons);
'@
$api = Add-Type -MemberDefinition $sig -Name FileTypeIcon -Namespace Spica -PassThru

$LOAD_LIBRARY_AS_DATAFILE = 0x00000002
$IMAGE_ICON = 1

$exe = (Resolve-Path $ExePath).Path
$failures = @()

$groups = $api::ExtractIconExW($exe, -1, $null, $null, 0)
if ($groups -ne 2) { $failures += "アイコングループ数が $groups (期待値 2)" }

$module = $api::LoadLibraryExW($exe, [IntPtr]::Zero, $LOAD_LIBRARY_AS_DATAFILE)
if ($module -eq [IntPtr]::Zero) { throw "LoadLibraryExW に失敗: $exe" }
try {
  foreach ($id in 32512, 32513) {
    $icon = $api::LoadImageW($module, [IntPtr]$id, $IMAGE_ICON, 16, 16, 0)
    if ($icon -eq [IntPtr]::Zero) { $failures += "リソース ID $id のアイコンが無い" }
  }
} finally {
  [void]$api::FreeLibrary($module)
}

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Output "NG: $_" }
  exit 1
}
Write-Output "OK: 32512 (アプリ) と 32513 (ファイルタイプ) の 2 グループを確認"
```

- [ ] **Step 2: 現在の exe で失敗することを確認**

既存のビルド済み exe があればそれを、無ければ先に `cd src-tauri && cargo build --release` してから:

Run: `powershell -ExecutionPolicy Bypass -File scripts/verify-file-type-icon.ps1 -ExePath src-tauri/target/release/spica-photo-viewer.exe`
Expected: FAIL（exit 1）— `NG: アイコングループ数が 1 (期待値 2)` と `NG: リソース ID 32513 のアイコンが無い`

- [ ] **Step 3: 依存要求とビルドスクリプトを変更する**

`src-tauri/Cargo.toml` の `[build-dependencies]`:

```toml
[build-dependencies]
# append_rc_content は 2.5 系に無い (ファイルタイプアイコンの埋め込みに使う)
tauri-build = { version = "2.6", features = [] }
```

`src-tauri/build.rs` を全面的に置き換える:

```rust
// Spec: docs/superpowers/specs/2026-09-12-file-type-icon-design.md
fn main() {
    let ico = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("icons/file-type.ico");
    // tauri-build はウィンドウアイコンに rerun-if-changed を出さないので自前で出す (F8)
    println!("cargo:rerun-if-changed={}", ico.display());

    // 32513 は tauri-build がアプリ本体に使う 32512 より大きくする必要がある。
    // シェルは最小 ID のグループを exe の顔として採るため (F1)。
    // .rc の文字列リテラルなのでバックスラッシュのエスケープが要る。
    let rc = format!(
        r#"32513 ICON "{}""#,
        ico.display().to_string().replace('\\', r"\\")
    );

    tauri_build::try_build(
        tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new().append_rc_content(rc),
        ),
    )
    .expect("failed to run tauri-build");
}
```

- [ ] **Step 4: ビルドして検証スクリプトが通ることを確認**

```bash
cd src-tauri && cargo build --release
```

Run: `powershell -ExecutionPolicy Bypass -File scripts/verify-file-type-icon.ps1 -ExePath src-tauri/target/release/spica-photo-viewer.exe`
Expected: PASS — `OK: 32512 (アプリ) と 32513 (ファイルタイプ) の 2 グループを確認`

- [ ] **Step 5: 既存テストの退行が無いことを確認**

```bash
cd src-tauri && cargo test --lib
```
Expected: 全件 PASS

- [ ] **Step 6: コミット**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/build.rs scripts/verify-file-type-icon.ps1
git commit -m "feat(icons): embed the file-type icon as resource 32513"
```

---

## Task 4: 関連付けとインストーラフック

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Create: `src-tauri/installer-hooks.nsh`
- Modify: `scripts/verify-file-type-icon.ps1`

**Interfaces:**
- Consumes: Task 3 の exe（リソース 32513）と `scripts/verify-file-type-icon.ps1`
- Produces: `-CheckRegistry` スイッチ付きの検証スクリプト、および関連付けを登録する NSIS インストーラ

- [ ] **Step 1: レジストリ検証を検証スクリプトに足す（この時点では失敗する）**

`scripts/verify-file-type-icon.ps1` の `param` ブロックを差し替える:

```powershell
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [switch]$CheckRegistry,
  [string]$InstallDir
)
```

`if ($failures.Count -gt 0)` の判定ブロックの**直前**に足す（判定より後ろに置くとレジストリの失敗が報告されない）:

```powershell
if ($CheckRegistry) {
  if (-not $InstallDir) { $InstallDir = Split-Path -Parent $exe }
  $expected = '"{0}\spica-photo-viewer.exe",-32513' -f $InstallDir
  $keys = @(
    "Software\Classes\SpicaPhotoViewer.jpeg\DefaultIcon",
    "Software\Classes\SpicaPhotoViewer.png\DefaultIcon",
    "Software\Classes\SpicaPhotoViewer.webp\DefaultIcon",
    "Software\Classes\SpicaPhotoViewer.gif\DefaultIcon",
    "Software\Classes\Applications\spica-photo-viewer.exe\DefaultIcon"
  )
  foreach ($key in $keys) {
    # インストーラは SHCTX に書く。installMode の既定は currentUser なので HKCU。
    $path = "Registry::HKEY_CURRENT_USER\$key"
    if (-not (Test-Path $path)) {
      $failures += "$key が無い"
      continue
    }
    $actual = (Get-ItemProperty $path).'(default)'
    if ($actual -ne $expected) { $failures += "$key = '$actual' (期待値 '$expected')" }
  }
}
```

`$failures` は同じスクリプトスコープなので、アイコン側の失敗とレジストリ側の失敗が 1 回の実行でまとめて出る。

- [ ] **Step 2: 未インストール状態で失敗することを確認**

Run: `powershell -ExecutionPolicy Bypass -File scripts/verify-file-type-icon.ps1 -ExePath src-tauri/target/release/spica-photo-viewer.exe -CheckRegistry`
Expected: FAIL（exit 1）— `NG: Software\Classes\SpicaPhotoViewer.png\DefaultIcon が無い` を含む 5 件

- [ ] **Step 3: フックと設定を書く**

`src-tauri/installer-hooks.nsh` を作る:

```nsh
; Spec: docs/superpowers/specs/2026-09-12-file-type-icon-design.md
;
; Tauri の APP_ASSOCIATE は DefaultIcon を "exe,0" 固定で書く。設定で変える
; 手段が無いので、関連付け作成の後に走る POSTINSTALL で上書きする。
;
; (F10) ${MAINBINARYNAME} はこの .nsh の !include より後で !define される。
; トップレベルでは解決できないが、マクロ本体は !insertmacro 時に展開される。
!macro SPICA_WRITE_FILE_TYPE_ICON KEY
  WriteRegStr SHCTX "${KEY}\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",-32513'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\SpicaPhotoViewer.jpeg"
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\SpicaPhotoViewer.png"
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\SpicaPhotoViewer.webp"
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\SpicaPhotoViewer.gif"
  ; 「プログラムから開く」で既定にされた場合、UserChoice はこの ProgID を指す。
  !insertmacro SPICA_WRITE_FILE_TYPE_ICON "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  ; (F4) テンプレートは SHChangeNotify を発行しないので自前で呼ぶ。
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; (F3) ProgID 側は APP_UNASSOCIATE がキーごと消すので触らない。
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon"
  !insertmacro UPDATEFILEASSOC
!macroend
```

`src-tauri/tauri.conf.json` の `bundle` を次の形にする（`icon` 配列は現状のまま残す）:

```json
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "fileAssociations": [
      { "ext": ["jpg", "jpeg"], "name": "SpicaPhotoViewer.jpeg", "description": "JPEG Image" },
      { "ext": ["png"], "name": "SpicaPhotoViewer.png", "description": "PNG Image" },
      { "ext": ["webp"], "name": "SpicaPhotoViewer.webp", "description": "WebP Image" },
      { "ext": ["gif"], "name": "SpicaPhotoViewer.gif", "description": "GIF Image" }
    ],
    "windows": {
      "nsis": {
        "installerHooks": "installer-hooks.nsh"
      }
    }
  }
```

- [ ] **Step 4: インストーラをビルドする**

```bash
npm run tauri build
```
Expected: `src-tauri/target/release/bundle/nsis/Spica Photo Viewer_1.0.0_x64-setup.exe` が生成され、`bundle/msi/` は作られない

生成された `src-tauri/target/release/nsis/x64/installer.nsi` を開き、`!insertmacro APP_ASSOCIATE` が 5 行（jpg / jpeg / png / webp / gif）出ていること、`!include` した hooks が `!define MAINBINARYNAME` より前にあることを目視確認する。

- [ ] **Step 5: インストールして検証スクリプトが通ることを確認**

既存の `C:\Program Files\Spica Photo Viewer\`（MSI 版）が残っていれば先にアンインストールする。その後インストーラを実行し:

Run: `powershell -ExecutionPolicy Bypass -File scripts/verify-file-type-icon.ps1 -ExePath "$env:LOCALAPPDATA\Spica Photo Viewer\spica-photo-viewer.exe" -CheckRegistry`
Expected: PASS — `OK: 32512 (アプリ) と 32513 (ファイルタイプ) の 2 グループを確認`

- [ ] **Step 6: コミット**

```bash
git add src-tauri/tauri.conf.json src-tauri/installer-hooks.nsh scripts/verify-file-type-icon.ps1
git commit -m "feat(icons): point the file associations at the file-type icon"
```

---

## Task 5: 手動検証とドキュメント

**Files:**
- Modify: `PROJECT_SPEC.md:513-517`
- Create: `docs/superpowers/plans/2026-09-12-file-type-icon-checklist.md`

**Interfaces:**
- Consumes: Task 4 でインストールされたアプリ
- Produces: PR 本文に貼る手動チェックリスト

- [ ] **Step 1: 手動チェックリストを実施して結果を記録する**

`docs/superpowers/plans/2026-09-12-file-type-icon-checklist.md` を作り、実施しながら埋める:

```markdown
# ファイルタイプアイコン 手動検証チェックリスト

対象: NSIS インストーラ版。実施前に旧 MSI 版をアンインストールして環境を揃える。
アイコンが古いまま見える場合は `ie4uinit.exe -show` でアイコンキャッシュを更新する。

- [ ] 1. `scripts/verify-file-type-icon.ps1 -CheckRegistry` が OK を返す（exe のアイコン 2 グループ＋レジストリ 5 箇所）
- [ ] 2. タスクバー / スタートメニュー / デスクトップのショートカットが**従来のアイコンのまま**
- [ ] 3. png / jpg / webp / gif を**詳細**表示にすると新しいアイコンになる
- [ ] 4. **一覧**表示と**小アイコン**表示でも新しいアイコンになる
- [ ] 5. **中アイコン以上ではサムネイルが出続ける**（退行していない）
- [ ] 6. 「プログラムから開く > 別のアプリを選択」で本アプリを既定にしてもアイコンが変わる
- [ ] 7. 画像ファイルをダブルクリックするとその画像が開く（argv 経路の退行確認）
- [ ] 8. アンインストール後、`Software\Classes\SpicaPhotoViewer.*` と `Applications\spica-photo-viewer.exe\DefaultIcon` が消え、`.png` の既定値が元に戻る

アンインストール後の確認コマンド:

    reg query "HKCU\Software\Classes\SpicaPhotoViewer.png"
    reg query "HKCU\Software\Classes\Applications\spica-photo-viewer.exe\DefaultIcon"
    reg query "HKCU\Software\Classes\.png" /ve

前 2 つは「見つかりません」、3 つ目はインストール前の値に戻っていること。
```

- [ ] **Step 2: `PROJECT_SPEC.md` を更新する**

`### Installer Creation` 節（513-517 行）を差し替える:

```markdown
### Installer Creation

- Use Tauri's NSIS integration (`bundle.targets` is `["nsis"]`; the WiX/MSI target is not supported)
- Configure file associations for .jpg, .jpeg, .png, .webp, .gif
- Set registry entries for default image viewer
- Give Explorer a dedicated file-type icon via `installerHooks`, separate from the app icon
  (see `docs/superpowers/specs/2026-09-12-file-type-icon-design.md`)
```

- [ ] **Step 3: 全テストが通ることを確認**

```bash
npm test
npm run type-check
npm run build:file-icon:test
cd src-tauri && cargo test --lib
```
Expected: 全件 PASS

- [ ] **Step 4: コミット**

```bash
npm run lint:fix && npm run format:fix
git add PROJECT_SPEC.md docs/superpowers/plans/2026-09-12-file-type-icon-checklist.md
git commit -m "docs(icons): record the manual checklist and switch the spec to NSIS"
```

---

## Self-Review 結果

**Spec coverage:**

| Spec | 対応タスク |
|---|---|
| §4.1 アイコン生成パイプライン | Task 1, Task 2 |
| §4.2 exe へのリソース埋め込み | Task 3 |
| §4.3 `tauri.conf.json` | Task 4 |
| §4.4 レジストリの分担 / `installer-hooks.nsh` | Task 4 |
| §5 (F1)(F2) リソース ID と負値指定 | Task 3 Step 3、Task 4 Step 3 |
| §5 (F3) POSTUNINSTALL で ProgID を触らない | Task 4 Step 3 |
| §5 (F4) `UPDATEFILEASSOC` | Task 4 Step 3 |
| §5 (F5) `name` 必須 | Task 4 Step 3 |
| §5 (F6) `SHCTX` | Task 4 Step 3 |
| §5 (F7) `.ico` を commit | Task 2 Step 6 |
| §5 (F8) `rerun-if-changed` | Task 3 Step 3 |
| §5 (F9) `targets` を nsis に | Task 4 Step 3 |
| §5 (F10) `${MAINBINARYNAME}` の参照位置 | Task 4 Step 3 |
| §5 (F11) `tauri-build` 2.6 | Task 3 Step 3 |
| §6 検証計画 8 項目 | Task 3・Task 4 の検証スクリプト（項目 1）、Task 5 Step 1（項目 2〜8） |
| §7 ドキュメント | Task 5 Step 2 |
