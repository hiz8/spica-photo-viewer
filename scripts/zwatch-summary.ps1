# Per launch in a scripts\zwatch.ps1 log: whether an Explorer frame was ever above Spica while
# Spica was the foreground window, when that started (ms after the window was first seen) and
# how long it lasted. A launch is one Spica HWND; the 0x0 event-target HWND is never foreground
# and so never counts.
#
#   powershell -ExecutionPolicy Bypass -File scripts\zwatch-summary.ps1 -Watch watch.log [-SinceWall <unix ms>]
param([Parameter(Mandatory)][string]$Watch, [double]$SinceWall = 0)

$rows = @(Get-Content $Watch | ForEach-Object {
  $f = $_ -split "`t", 3
  [pscustomobject]@{ wall = [int64]$f[0]; state = $f[2] }
} | Where-Object { $_.wall -gt $SinceWall })

$launches = [ordered]@{}
for ($i = 0; $i -lt $rows.Count; $i++) {
  $m = [regex]::Match($rows[$i].state, ' spica=(0x[0-9A-F]+)')
  if (-not $m.Success) { continue }
  $h = $m.Groups[1].Value
  if (-not $launches.Contains($h)) {
    $launches[$h] = [pscustomobject]@{ hwnd = $h; first = $rows[$i].wall; fg = $false; raised_at = $null; covered_ms = 0 }
  }
  $L = $launches[$h]
  if ($rows[$i].state -notlike '*SPICA_IS_FG*') { continue }
  $L.fg = $true
  if ($rows[$i].state -match 'above=\[[^\]]*explorer:CabinetWClass') {
    $next = if ($i + 1 -lt $rows.Count) { $rows[$i + 1].wall } else { $rows[$i].wall }
    if ($null -eq $L.raised_at) { $L.raised_at = $rows[$i].wall - $L.first }
    $L.covered_ms += $next - $rows[$i].wall
  }
}
$all = @($launches.Values | Where-Object { $_.fg })
$hit = @($all | Where-Object { $null -ne $_.raised_at })
"launches (Spica windows ever foreground): $($all.Count)  with Explorer above while foreground: $($hit.Count)"
$hit | ForEach-Object {
  $t = [DateTimeOffset]::FromUnixTimeMilliseconds($_.first).ToLocalTime().ToString('HH:mm:ss')
  "  $t $($_.hwnd): raised +$($_.raised_at) ms after first seen, covered ~$($_.covered_ms) ms"
}
