<#
.SYNOPSIS
Changes an Explorer window's sort by switching to Details view and clicking a
column header via UI Automation. Deliberately avoids IFolderView2::SetSortColumns
(spec R10). Requires the window to already show $Path.
.EXAMPLE
./set-sort-via-ui.ps1 -Path C:\tmp\sort-test -Column サイズ -Clicks 2   # size desc
#>
param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Column,
    [int]$Clicks = 1
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$shell = New-Object -ComObject Shell.Application
$win = @($shell.Windows()) | Where-Object {
    try { $_.Document.Folder.Self.Path -eq $Path } catch { $false }
} | Select-Object -First 1
if (-not $win) { throw "no Explorer window shows $Path" }
$hwnd = [IntPtr]$win.HWND

# Bring the window forward, switch to Details view (Ctrl+Shift+6) so headers exist
$wsh = New-Object -ComObject WScript.Shell
$null = $wsh.AppActivate((Split-Path $Path -Leaf))
Start-Sleep -Milliseconds 500
$wsh.SendKeys("^+6")
Start-Sleep -Milliseconds 800

$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::HeaderItem)
$headers = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
$target = @($headers) | Where-Object { $_.Current.Name -eq $Column } | Select-Object -First 1
if (-not $target) {
    $names = (@($headers) | ForEach-Object { $_.Current.Name }) -join ", "
    throw "header '$Column' not found (available: $names)"
}
for ($i = 0; $i -lt $Clicks; $i++) {
    ($target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
    Start-Sleep -Milliseconds 500
}
Write-Host "clicked '$Column' x$Clicks"
