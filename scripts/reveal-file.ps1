param([Parameter(Mandatory=$true)][string]$LiteralPath)
$ErrorActionPreference='Stop'
$item=Get-Item -LiteralPath $LiteralPath
if ($item.PSIsContainer) { throw 'Expected an existing file.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AigcFileSelection {
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
[AigcFileSelection]::Reveal($item.FullName)
