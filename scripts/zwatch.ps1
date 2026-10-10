# z-order watcher for the launch-time Explorer raise (Issue #333, docs/code-rationale.md W3).
# Polls every $PollMs ms and appends a line whenever the state changes: the foreground window
# and the visible windows above Spica's topmost window in z-order. Compiled code keeps a poll
# at ~15 ms, so the raise (+22..54 ms after Spica appears) can be timed against the window
# appearing, which Spica's own perf.log cannot see (its first trace is window_created).
#
#   powershell -ExecutionPolicy Bypass -File scripts\zwatch.ps1 -Out watch.log [-Seconds 900]
#   powershell -ExecutionPolicy Bypass -File scripts\zwatch-summary.ps1 -Watch watch.log
#
# Read-only: it never activates, moves or sends input to any window. The log holds HWNDs,
# process and class names only (no titles or paths).
#
# Keep it running only while measuring: -Proc matches tao's 0x0 event-target window as well,
# so each launch shows two Spica HWNDs (the summary counts the one that is ever foreground).
param([int]$Seconds = 900, [int]$PollMs = 15, [Parameter(Mandatory)][string]$Out, [string]$Proc = "spica-photo-viewer")

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class ZWatch {
  [DllImport("user32.dll")] static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtrW(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const uint GW_HWNDNEXT = 2;
  const int GWL_EXSTYLE = -20;
  const long WS_EX_TOOLWINDOW = 0x80;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

  public static string TargetProc = "spica-photo-viewer";
  // Keyed by (pid, creation time): every launch starts new processes, and a
  // reused pid must not inherit an exited process's name.
  static readonly Dictionary<KeyValuePair<uint, long>, string> names = new Dictionary<KeyValuePair<uint, long>, string>();
  static long CreatedAt(uint pid) {
    IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (h == IntPtr.Zero) return 0;
    long created, exited, kernel, user;
    bool ok = GetProcessTimes(h, out created, out exited, out kernel, out user);
    CloseHandle(h);
    return ok ? created : 0;
  }
  static string Proc(uint pid) {
    long created = CreatedAt(pid);
    // Unreadable (exited, or protected): look it up but do not cache.
    if (created == 0) {
      try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; }
    }
    var key = new KeyValuePair<uint, long>(pid, created);
    string n;
    if (names.TryGetValue(key, out n)) return n;
    try { n = Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; }
    names[key] = n; return n;
  }
  static string Cls(IntPtr h) { var sb = new StringBuilder(64); GetClassNameW(h, sb, 64); return sb.ToString(); }
  static string Hex(IntPtr h) { return "0x" + h.ToInt64().ToString("X"); }

  static string Snapshot() {
    IntPtr fg = GetForegroundWindow();
    uint fpid; GetWindowThreadProcessId(fg, out fpid);
    IntPtr spica = IntPtr.Zero;
    var above = new List<string>();
    IntPtr h = GetTopWindow(IntPtr.Zero);
    int guard = 0;
    while (h != IntPtr.Zero && guard++ < 1000) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (IsWindowVisible(h) && Proc(pid) == TargetProc) { spica = h; break; }
      if (IsWindowVisible(h) && !IsIconic(h)) {
        long ex = GetWindowLongPtrW(h, GWL_EXSTYLE).ToInt64();
        RECT r; GetWindowRect(h, out r);
        if ((ex & WS_EX_TOOLWINDOW) == 0 && r.R - r.L > 0 && r.B - r.T > 0) {
          string p = Proc(pid);
          // The IME host keeps a visible, sized window near the top that never covers anything.
          if (p != "TextInputHost") above.Add(Hex(h) + ":" + p + ":" + Cls(h));
        }
      }
      h = GetWindow(h, GW_HWNDNEXT);
    }
    if (spica == IntPtr.Zero) return "no_spica fg=" + Hex(fg) + ":" + Proc(fpid) + ":" + Cls(fg);
    if (above.Count > 6) above = above.GetRange(0, 6);
    return "fg=" + Hex(fg) + ":" + Proc(fpid) + ":" + Cls(fg) + " spica=" + Hex(spica) + (fg == spica ? " SPICA_IS_FG" : "") + " above=[" + string.Join(", ", above) + "]";
  }

  public static void Run(string path, int seconds, int pollMs) {
    var sw = Stopwatch.StartNew();
    string prev = null;
    while (sw.Elapsed.TotalSeconds < seconds) {
      string s = Snapshot();
      if (s != prev) {
        long wall = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        File.AppendAllText(path, wall + "\t" + sw.ElapsedMilliseconds + "\t" + s + "\n");
        prev = s;
      }
      Thread.Sleep(pollMs);
    }
  }
}
'@

[ZWatch]::TargetProc = $Proc
[ZWatch]::Run([IO.Path]::GetFullPath($Out), $Seconds, $PollMs)
