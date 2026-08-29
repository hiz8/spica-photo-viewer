<#
.SYNOPSIS
Explorer sort probe wrapper (spec §7.3). Builds and runs the Rust example.
.EXAMPLE
./probe.ps1 list
./probe.ps1 order C:\tmp\sort-test
./probe.ps1 app C:\tmp\sort-test -Hwnd 123456
#>
param(
    [Parameter(Mandatory, Position = 0)][ValidateSet("list", "order", "app")][string]$Cmd,
    [Parameter(Position = 1)][string]$Folder = "",
    [long]$Hwnd = 0
)
$ErrorActionPreference = "Stop"
$srcTauri = Join-Path $PSScriptRoot "..\..\src-tauri"
$probeArgs = @($Cmd)
if ($Folder) { $probeArgs += $Folder }
if ($Hwnd -ne 0) { $probeArgs += @("--hwnd", "$Hwnd") }
Push-Location $srcTauri
try {
    cargo run --quiet --example explorer_sort_probe -- @probeArgs
} finally {
    Pop-Location
}
