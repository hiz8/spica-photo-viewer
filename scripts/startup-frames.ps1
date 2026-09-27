# Screen sampler for the launch-time about:blank flash (Issue #342, docs/code-rationale.md W6).
# Launches Spica with an image and, for $Ms ms, captures one screen row across Spica's window
# as fast as GDI allows (one BitBlt per sample, ~15-20 ms apart), reads two pixels from it,
# then prints how long each colour stayed and the time spent near Chromium's dark about:blank
# (#121212 +/- $Tolerance per channel, for colour management or dithering offsets). A screen
# recording shows the flash but cannot time it; Spica's own perf.log cannot see what the
# compositor put on screen. Each run also prints its median sample gap: a flash shorter than
# that can fall between two samples, so judge by the total over -Runs, not by one run.
#
#   powershell -ExecutionPolicy Bypass -File scripts\startup-frames.ps1 -File <image> [-Exe <exe>] [-Runs 10]
#
# The window is located by its process each sample until it exists (it lands on whichever
# monitor the launch decides), then the row is $Inset px below its top and the two pixels are
# $Inset px inside its left and right edges, i.e. in the image area of a maximized window.
# Keep the desktop still while it runs: it kills the launched process at the end but never
# sends input. A switched-off or locked display reads #000000 everywhere; then the result
# means nothing.
param(
  [Parameter(Mandatory)][string]$File,
  [string]$Exe = "",
  [int]$Runs = 5,
  [int]$Ms = 1500,
  [int]$Inset = 400,
  [string]$Flash = "#121212",
  [int]$Tolerance = 8
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

$flashRgb = [System.Drawing.ColorTranslator]::FromHtml($Flash)
function Test-Flash([System.Drawing.Color]$c) {
  return ([Math]::Abs($c.R - $flashRgb.R) -le $Tolerance -and
          [Math]::Abs($c.G - $flashRgb.G) -le $Tolerance -and
          [Math]::Abs($c.B - $flashRgb.B) -le $Tolerance)
}
function Format-Rgb([System.Drawing.Color]$c) { return ("#{0:X2}{1:X2}{2:X2}" -f $c.R, $c.G, $c.B) }

$totals = New-Object System.Collections.Generic.List[int]
$warm = New-Object System.Drawing.Bitmap 1, 1
# The first GDI capture of the process is slow (hundreds of ms); take it before the clock starts.
[System.Drawing.Graphics]::FromImage($warm).CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size 1, 1))

for ($run = 1; $run -le $Runs; $run++) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $Exe -ArgumentList "`"$File`"" -PassThru
  $rows = New-Object System.Collections.Generic.List[object]
  $rect = $null; $row = $null; $g = $null; $width = 0
  while ($sw.ElapsedMilliseconds -lt $Ms) {
    if ($null -eq $rect) {
      $p.Refresh()
      $h = $p.MainWindowHandle
      if ($h -ne [IntPtr]::Zero) {
        $r = New-Object StartupFramesNative+RECT
        if ([StartupFramesNative]::GetWindowRect($h, [ref]$r) -and ($r.Right - $r.Left) -gt 2 * $Inset) {
          $rect = $r
          $width = $r.Right - $r.Left
          $row = New-Object System.Drawing.Bitmap $width, 1
          $g = [System.Drawing.Graphics]::FromImage($row)
          $rows.Add([pscustomobject]@{ t = [int]$sw.ElapsedMilliseconds; a = "window"; b = "$($r.Left),$($r.Top)-$($r.Right),$($r.Bottom)"; flash = $false })
        }
      }
      if ($null -eq $rect) { Start-Sleep -Milliseconds 5; continue }
    }
    $g.CopyFromScreen($rect.Left, $rect.Top + $Inset, 0, 0, (New-Object System.Drawing.Size $width, 1))
    $ca = $row.GetPixel($Inset, 0)
    $cb = $row.GetPixel($width - $Inset, 0)
    $rows.Add([pscustomobject]@{
      t = [int]$sw.ElapsedMilliseconds
      a = Format-Rgb $ca
      b = Format-Rgb $cb
      flash = ((Test-Flash $ca) -or (Test-Flash $cb))
    })
  }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  if ($null -ne $g) { $g.Dispose(); $row.Dispose() }
  # Wait for the window to go so the next run starts from the bare desktop.
  Start-Sleep -Milliseconds 500

  $gaps = @()
  for ($i = 2; $i -lt $rows.Count; $i++) { $gaps += ($rows[$i].t - $rows[$i - 1].t) }
  $gap = if ($gaps.Count -gt 0) { ($gaps | Sort-Object)[[int]($gaps.Count / 2)] } else { 0 }
  "--- run $run ($($rows.Count) samples, median gap ${gap}ms)"
  $prev = $null; $start = 0; $flashMs = 0
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $r = $rows[$i]
    $key = "$($r.a) $($r.b)"
    if ($key -ne $prev) {
      if ($null -ne $prev) { "{0,5}-{1,5}ms  {2}" -f $start, $r.t, $prev }
      $prev = $key; $start = $r.t
    }
    if ($r.flash -and $i + 1 -lt $rows.Count) { $flashMs += $rows[$i + 1].t - $r.t }
  }
  if ($null -ne $prev) { "{0,5}-{1,5}ms  {2}" -f $start, $Ms, $prev }
  "flash ($Flash +/-$Tolerance) visible: ${flashMs}ms"
  $totals.Add($flashMs)
}

""
"flash ms per run: " + ($totals -join ", ")
"runs with flash: $(@($totals | Where-Object { $_ -gt 0 }).Count) / $Runs"
