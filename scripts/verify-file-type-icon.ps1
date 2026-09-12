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
