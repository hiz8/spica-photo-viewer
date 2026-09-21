# Foreground / activation state probe for the "Spica opens behind Explorer and
# clicks do not raise it" report. Polls the desktop's foreground state and
# Spica's top-level window and prints one JSON object per sample on stdout,
# so it can be run while the bug is on screen (or around a launch) and the
# output pasted into an issue.
#
#   powershell -ExecutionPolicy Bypass -File scripts\diagnose-foreground.ps1 [-Seconds 10] [-IntervalMs 250]
#
# Read-only: it never activates, moves or sends input to any window.

param(
  [int]$Seconds = 10,
  [int]$IntervalMs = 250
)

$ErrorActionPreference = "Stop"

Add-Type -Namespace Win32 -Name Probe -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder s, int n);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr hWnd, int nIndex);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
[DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr SendMessageTimeoutW(IntPtr hWnd, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
[StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
  public uint cbSize; public uint flags; public IntPtr hwndActive; public IntPtr hwndFocus;
  public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret; }
[DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO info);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
'@

$GWL_STYLE = -16; $GWL_EXSTYLE = -20
$GW_HWNDNEXT = 2; $GW_OWNER = 4
$WS_DISABLED = 0x08000000
$WS_EX_TOPMOST = 0x8; $WS_EX_NOACTIVATE = 0x08000000; $WS_EX_TOOLWINDOW = 0x80; $WS_EX_LAYERED = 0x80000
$SMTO_ABORTIFHUNG = 0x2

function Text($h) { $sb = New-Object System.Text.StringBuilder 256; [void][Win32.Probe]::GetWindowTextW($h, $sb, 256); $sb.ToString() }
function ClassName($h) { $sb = New-Object System.Text.StringBuilder 256; [void][Win32.Probe]::GetClassNameW($h, $sb, 256); $sb.ToString() }
function ProcName($procId) { try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { "?" } }
function Long($h, $i) { [Win32.Probe]::GetWindowLongPtrW($h, $i).ToInt64() -band 0xFFFFFFFF }

function Describe($h) {
  if ($h -eq [IntPtr]::Zero) { return $null }
  $procId = 0; $tid = [Win32.Probe]::GetWindowThreadProcessId($h, [ref]$procId)
  $style = Long $h $GWL_STYLE; $ex = Long $h $GWL_EXSTYLE
  $r = New-Object Win32.Probe+RECT; [void][Win32.Probe]::GetWindowRect($h, [ref]$r)
  $gti = New-Object Win32.Probe+GUITHREADINFO
  $gti.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][Win32.Probe+GUITHREADINFO])
  $gtiOk = [Win32.Probe]::GetGUIThreadInfo($tid, [ref]$gti)
  # Main-thread responsiveness: WM_NULL round trip with a short timeout.
  $res = [IntPtr]::Zero
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $ok = [Win32.Probe]::SendMessageTimeoutW($h, 0, [IntPtr]::Zero, [IntPtr]::Zero, $SMTO_ABORTIFHUNG, 200, [ref]$res)
  $sw.Stop()
  [ordered]@{
    hwnd = ("0x{0:X}" -f $h.ToInt64()); pid = $procId; proc = (ProcName $procId); tid = $tid
    class = (ClassName $h); title = (Text $h)
    visible = [Win32.Probe]::IsWindowVisible($h); enabled = [Win32.Probe]::IsWindowEnabled($h)
    iconic = [Win32.Probe]::IsIconic($h); zoomed = [Win32.Probe]::IsZoomed($h)
    hung = [Win32.Probe]::IsHungAppWindow($h)
    pump_ok = $ok -ne [IntPtr]::Zero; pump_ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
    ws_disabled = (($style -band $WS_DISABLED) -ne 0)
    ex_topmost = (($ex -band $WS_EX_TOPMOST) -ne 0); ex_noactivate = (($ex -band $WS_EX_NOACTIVATE) -ne 0)
    ex_toolwindow = (($ex -band $WS_EX_TOOLWINDOW) -ne 0); ex_layered = (($ex -band $WS_EX_LAYERED) -ne 0)
    owner = ("0x{0:X}" -f [Win32.Probe]::GetWindow($h, $GW_OWNER).ToInt64())
    rect = "$($r.L),$($r.T)-$($r.R),$($r.B)"
    gui_flags = $(if ($gtiOk) { ("0x{0:X}" -f $gti.flags) } else { $null })  # 0x1 caret, 0x2 MOVESIZE, 0x4 INMENUMODE, 0x8 SYSTEMMENUMODE, 0x10 POPUPMENUMODE
    gui_active = $(if ($gtiOk) { ("0x{0:X}" -f $gti.hwndActive.ToInt64()) } else { $null })
    gui_focus = $(if ($gtiOk) { ("0x{0:X}" -f $gti.hwndFocus.ToInt64()) } else { $null })
    gui_capture = $(if ($gtiOk) { ("0x{0:X}" -f $gti.hwndCapture.ToInt64()) } else { $null })
    gui_menu_owner = $(if ($gtiOk) { ("0x{0:X}" -f $gti.hwndMenuOwner.ToInt64()) } else { $null })
  }
}

# Spica's top-level windows: visible, unowned, belonging to spica-photo-viewer.exe.
function SpicaWindows {
  $out = @()
  $pids = @(Get-Process -Name "spica-photo-viewer" -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($pids.Count -eq 0) { return $out }
  $h = [Win32.Probe]::GetTopWindow([IntPtr]::Zero)
  while ($h -ne [IntPtr]::Zero) {
    $procId = 0; [void][Win32.Probe]::GetWindowThreadProcessId($h, [ref]$procId)
    if (($pids -contains $procId) -and [Win32.Probe]::IsWindowVisible($h) -and ([Win32.Probe]::GetWindow($h, $GW_OWNER) -eq [IntPtr]::Zero)) {
      $out += $h
    }
    $h = [Win32.Probe]::GetWindow($h, $GW_HWNDNEXT)
  }
  $out
}

# Visible top-level windows above `$target` in z-order (what could be covering it).
function Above($target) {
  $list = @()
  $h = [Win32.Probe]::GetTopWindow([IntPtr]::Zero)
  while ($h -ne [IntPtr]::Zero -and $h -ne $target) {
    if ([Win32.Probe]::IsWindowVisible($h) -and ((Long $h $GWL_EXSTYLE) -band $WS_EX_TOOLWINDOW) -eq 0) {
      $procId = 0; [void][Win32.Probe]::GetWindowThreadProcessId($h, [ref]$procId)
      $r = New-Object Win32.Probe+RECT; [void][Win32.Probe]::GetWindowRect($h, [ref]$r)
      if (($r.R - $r.L) -gt 0 -and ($r.B - $r.T) -gt 0) {
        $list += ("{0}:{1}:{2}" -f (ProcName $procId), (ClassName $h), (Text $h))
      }
    }
    $h = [Win32.Probe]::GetWindow($h, $GW_HWNDNEXT)
  }
  $list
}

Write-Output (@{ t = 0; os = [Environment]::OSVersion.Version.ToString() } | ConvertTo-Json -Compress)

$t0 = Get-Date
do {
  $t = [math]::Round(((Get-Date) - $t0).TotalMilliseconds)
  $fg = [Win32.Probe]::GetForegroundWindow()
  $sample = [ordered]@{ t = $t; foreground = (Describe $fg); spica = @() }
  foreach ($h in (SpicaWindows)) {
    $d = Describe $h
    $d.is_foreground = ($h -eq $fg)
    $d.above = @(Above $h)
    $sample.spica += $d
  }
  Write-Output ($sample | ConvertTo-Json -Compress -Depth 5)
  Start-Sleep -Milliseconds $IntervalMs
} while (((Get-Date) - $t0).TotalSeconds -lt $Seconds)
