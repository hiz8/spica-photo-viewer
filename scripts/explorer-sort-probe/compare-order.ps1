<#
.SYNOPSIS
Compares Explorer's display order (GetItem) with the app's order
(get_folder_images) for a folder. Exit 0 = identical (spec §7.3 items 1-3).
Folders/non-images in the Explorer dump are filtered to the app's extension set.
#>
param([Parameter(Mandatory)][string]$Folder)
$ErrorActionPreference = "Stop"
$explorer = & (Join-Path $PSScriptRoot "probe.ps1") order $Folder
$app = & (Join-Path $PSScriptRoot "probe.ps1") app $Folder
$exts = ".jpg", ".jpeg", ".png", ".webp", ".gif"
$explorerImages = @($explorer | Where-Object { $exts -contains [IO.Path]::GetExtension($_).ToLower() })
$app = @($app)
if ($explorerImages.Count -ne $app.Count) {
    Write-Host "COUNT MISMATCH explorer=$($explorerImages.Count) app=$($app.Count)"
}
$diff = Compare-Object -ReferenceObject $explorerImages -DifferenceObject $app -SyncWindow 0
if ($null -eq $diff) {
    Write-Host "MATCH ($($app.Count) files)"
    exit 0
}
Write-Host "DIFF:"
$diff | Format-Table | Out-String | Write-Host
exit 1
