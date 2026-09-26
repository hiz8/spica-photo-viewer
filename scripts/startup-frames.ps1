# Screen sampler for the launch-time about:blank flash (Issue #342, docs/code-rationale.md W6).
# Launches Spica with an image and, for $Ms ms, reads one screen pixel at two points inside
# Spica's window as fast as GDI allows (~30 samples/s), then prints how long each colour stayed
# and the time spent on Chromium's dark about:blank (#121212). A screen recording shows the
# flash but cannot time it; Spica's own perf.log cannot see what the compositor put on screen.
#
#   powershell -ExecutionPolicy Bypass -File scripts\startup-frames.ps1 -File <image> [-Exe <exe>] [-Runs 10]
#
# The window is located by its process each sample until it exists (it lands on whichever
# monitor the launch decides), then the points are $Inset px inside its left and right edges
# at $Inset px below its top, i.e. in the image area of a maximized window. Keep the desktop
# still while it runs: it kills the launched process at the end but never sends input.
param(
  [Parameter(Mandatory)][string]$File,
  [string]$Exe = "",
  [int]$Runs = 5,
  [int]$Ms = 1500,
  [int]$Inset = 400,
  [string]$Flash = "#121212"
)

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class StartupFramesNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
# Without this a non-DPI-aware PowerShell gets scaled coordinates on a >100% monitor.
[void][StartupFramesNative]::SetProcessDPIAware()

# $PSScriptRoot is empty while parameter defaults are evaluated under -File, so resolve here.
if ($Exe -eq "") {
  $Exe = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\src-tauri\target\release\spica-photo-viewer.exe"
}
if (-not (Test-Path $Exe)) { throw "exe missing: $Exe (run: npm run bench:build)" }
if (-not (Test-Path $File)) { throw "image missing: $File" }

$bmp = New-Object System.Drawing.Bitmap 1, 1
$g = [System.Drawing.Graphics]::FromImage($bmp)
$one = New-Object System.Drawing.Size 1, 1
$totals = New-Object System.Collections.Generic.List[int]
# The first GDI capture of the process is slow (hundreds of ms); take it before the clock starts.
$g.CopyFromScreen(0, 0, 0, 0, $one)

function Read-Pixel([int]$x, [int]$y) {
  $g.CopyFromScreen($x, $y, 0, 0, $one)
  $c = $bmp.GetPixel(0, 0)
  return ("#{0:X2}{1:X2}{2:X2}" -f $c.R, $c.G, $c.B)
}

for ($run = 1; $run -le $Runs; $run++) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $Exe -ArgumentList "`"$File`"" -PassThru
  $rows = New-Object System.Collections.Generic.List[object]
  $rect = $null
  while ($sw.ElapsedMilliseconds -lt $Ms) {
    if ($null -eq $rect) {
      $p.Refresh()
      $h = $p.MainWindowHandle
      if ($h -ne [IntPtr]::Zero) {
        $r = New-Object StartupFramesNative+RECT
        if ([StartupFramesNative]::GetWindowRect($h, [ref]$r) -and ($r.Right - $r.Left) -gt 2 * $Inset) {
          $rect = $r
          $rows.Add([pscustomobject]@{ t = [int]$sw.ElapsedMilliseconds; a = "window"; b = "$($r.Left),$($r.Top)-$($r.Right),$($r.Bottom)" })
        }
      }
      if ($null -eq $rect) { Start-Sleep -Milliseconds 5; continue }
    }
    $rows.Add([pscustomobject]@{
      t = [int]$sw.ElapsedMilliseconds
      a = Read-Pixel ($rect.Left + $Inset) ($rect.Top + $Inset)
      b = Read-Pixel ($rect.Right - $Inset) ($rect.Top + $Inset)
    })
  }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  # Wait for the window to go so the next run starts from the bare desktop.
  Start-Sleep -Milliseconds 500

  "--- run $run ($($rows.Count) samples)"
  $prev = $null; $start = 0; $flashMs = 0
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $r = $rows[$i]
    $key = "$($r.a) $($r.b)"
    if ($key -ne $prev) {
      if ($null -ne $prev) { "{0,5}-{1,5}ms  {2}" -f $start, $r.t, $prev }
      $prev = $key; $start = $r.t
    }
    if ($i + 1 -lt $rows.Count -and ($r.a -eq $Flash -or $r.b -eq $Flash)) {
      $flashMs += $rows[$i + 1].t - $r.t
    }
  }
  if ($null -ne $prev) { "{0,5}-{1,5}ms  {2}" -f $start, $Ms, $prev }
  "flash ($Flash) visible: ${flashMs}ms"
  $totals.Add($flashMs)
}

""
"flash ms per run: " + ($totals -join ", ")
"runs with flash: $(@($totals | Where-Object { $_ -gt 0 }).Count) / $Runs"
