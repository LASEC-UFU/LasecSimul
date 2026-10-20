param([int]$ProcessId, [string]$TitleLike, [string]$NotTitleLike = "", [ValidateSet("maximize","minimize","restore","list","move")][string]$Action,
      [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0)
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SpikeWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static string Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return r.Left + "," + r.Top + " " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top); }
  public static List<IntPtr> Windows(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
}
"@
$targets = [SpikeWin]::Windows([uint32]$ProcessId) | Where-Object { $t = [SpikeWin]::Title($_); $t -like $TitleLike -and ($NotTitleLike -eq "" -or -not ($t -like $NotTitleLike)) }
foreach ($h in $targets) {
  $title = [SpikeWin]::Title($h)
  switch ($Action) {
    "maximize" { [void][SpikeWin]::ShowWindow($h, 3) }
    "minimize" { [void][SpikeWin]::ShowWindow($h, 6) }
    "restore"  { [void][SpikeWin]::ShowWindow($h, 9) }
    "move"     { [void][SpikeWin]::ShowWindow($h, 9); [void][SpikeWin]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, $W, $H, 0x0014) }
  }
  Start-Sleep -Milliseconds 300
  "{0}|zoomed={1}|iconic={2}|rect={3}" -f $title, [SpikeWin]::IsZoomed($h), [SpikeWin]::IsIconic($h), [SpikeWin]::Rect($h)
}
