param([Parameter(Mandatory=$true)][string]$LiteralPath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$item=Get-Item -LiteralPath $LiteralPath
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AigcFileSelection {
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    public static bool Focus(IntPtr window) {
        ShowWindow(window, IsIconic(window) ? 9 : 5);
        if (SetForegroundWindow(window)) return true;
        uint current=GetCurrentThreadId();
        uint foreground=GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
        bool attached=foreground!=0 && foreground!=current && AttachThreadInput(current, foreground, true);
        try { SetForegroundWindow(window); }
        finally { if (attached) AttachThreadInput(current, foreground, false); }
        return GetForegroundWindow()==window;
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
    private static extern int SHParseDisplayName(string name, IntPtr context, out IntPtr pidl, uint attributes, out uint result);
    [DllImport("shell32.dll")]
    private static extern int SHOpenFolderAndSelectItems(IntPtr pidl, uint count, IntPtr items, uint flags);
    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr reserved, uint flags);
    [DllImport("ole32.dll")]
    private static extern void CoUninitialize();
    public static void Reveal(string path) {
        int initialized=CoInitializeEx(IntPtr.Zero, 2);
        IntPtr pidl=IntPtr.Zero;
        try {
            uint attributes;
            Marshal.ThrowExceptionForHR(SHParseDisplayName(path, IntPtr.Zero, out pidl, 0, out attributes));
            Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(pidl, 0, IntPtr.Zero, 0));
        } finally {
            if (pidl!=IntPtr.Zero) Marshal.FreeCoTaskMem(pidl);
            if (initialized>=0) CoUninitialize();
        }
    }
}
'@
$shell=New-Object -ComObject Shell.Application
$folder=if($item.PSIsContainer){$item.FullName}else{$item.DirectoryName}
function Find-FolderWindow {
    foreach($window in $shell.Windows()) {
        try { if($window.Document.Folder.Self.Path -eq $folder){return $window} } catch {}
    }
}
$window=Find-FolderWindow
$reused=[bool]$window
if($item.PSIsContainer) {
    if(!$window){$shell.Explore($folder)}
} else {
    [AigcFileSelection]::Reveal($item.FullName)
}
for($attempt=0;!$window -and $attempt -lt 30;$attempt++) {
    Start-Sleep -Milliseconds 100
    $window=Find-FolderWindow
}
if(!$window){throw ('Explorer did not open: '+$folder)}
$window.Visible=$true
$focused=[AigcFileSelection]::Focus([IntPtr]$window.HWND)
[PSCustomObject]@{path=$item.FullName;focused=$focused;reused=$reused} | ConvertTo-Json -Compress
