using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using Acp.Worker;

namespace Acp.Integration;

// Exact disposable fixture only: no production observer uses this mutation probe.
public static class SyntheticDirectoryPinProbe
{
    public static string Run(string path)
    {
        bool priorDeleteDenied = false, renameDenied, ancestorDenied, deleteDenied, childAllowed;
        using (var prior = CreateFile(path,0x10000,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero))
        {
            if (prior.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            try { using var unexpected = WindowsFilesystemReadLease.Directory(path); }
            catch (Win32Exception error) when (error.NativeErrorCode == 32) { priorDeleteDenied = true; }
        }
        string ancestor = Path.GetDirectoryName(path);
        using (var lease = WindowsFilesystemReadLease.Directory(path))
        {
            // No child file is open: descendant-file locks cannot mask the seam.
            renameDenied = Denied(() => Directory.Move(path,path+"-moved")) && Directory.Exists(path) && !Directory.Exists(path+"-moved");
            ancestorDenied = Denied(() => Directory.Move(ancestor,ancestor+"-moved")) && Directory.Exists(ancestor) && !Directory.Exists(ancestor+"-moved");
            deleteDenied = Denied(() => Directory.Delete(path)) && Directory.Exists(path);
            string child = Path.Combine(path,"not-a-reservation");
            Directory.CreateDirectory(child); childAllowed = Directory.Exists(child); Directory.Delete(child);
        }
        Directory.Move(path,path+"-released");
        bool released = !Directory.Exists(path) && Directory.Exists(path+"-released");
        Directory.Move(path+"-released",path);
        return JsonSerializer.Serialize(new { priorDeleteDenied,renameDenied,ancestorDenied,deleteDenied,childAllowed,released });
    }
    private static bool Denied(Action action)
    {
        try { action(); return false; }
        catch (IOException error) when ((error.HResult & 0xffff) == 32) { return true; }
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
    private static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
}
