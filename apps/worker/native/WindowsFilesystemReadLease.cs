using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace Acp.Worker;

// Read-only namespace pin. This is not a writer lease or a content snapshot.
public sealed class WindowsFilesystemReadLease : IDisposable
{
    private readonly List<SafeFileHandle> handles = new List<SafeFileHandle>();
    public string Path { get; private set; }
    public string Identity { get; private set; }

    public static WindowsFilesystemReadLease Directory(string input)
    {
        ValidatePath(input);
        string drive = System.IO.Path.GetPathRoot(input);
        if (new DriveInfo(drive).DriveType != DriveType.Fixed) throw new ArgumentException("fixed local volume required");
        var paths = new List<string>();
        for (var directory = new DirectoryInfo(input); directory != null; directory = directory.Parent) paths.Add(directory.FullName);
        paths.Reverse();
        var lease = new WindowsFilesystemReadLease();
        try
        {
            foreach (string path in paths)
            {
                // OPEN_REPARSE_POINT, BACKUP_SEMANTICS; no DELETE sharing on any ancestor.
                var handle = CreateFile(path, 0, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                if (handle.IsInvalid) { handle.Dispose(); Fail(); }
                lease.handles.Add(handle);
                if (!GetFileInformationByHandle(handle, out FileInformation info)) Fail();
                if ((info.Attributes & 0x400u) != 0 || (info.Attributes & 0x10u) == 0) throw new InvalidOperationException("non-reparse directory required");
                // Registry reservations use Windows case-insensitive path keys.
                // Per-directory case-sensitive namespaces require another contract.
                if (!GetFileInformationByHandleEx(handle, 23, out CaseSensitiveInformation caseInfo, 4)) Fail();
                if (caseInfo.Flags != 0) throw new InvalidOperationException("case-sensitive directory layout is unsupported");
                lease.Identity = "win32-dir:" + info.VolumeSerialNumber.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8");
                var final = new StringBuilder(32768);
                uint length = GetFinalPathNameByHandle(handle, final, (uint)final.Capacity, 0);
                if (length == 0 || length >= final.Capacity) Fail();
                string canonical = final.ToString();
                if (!canonical.StartsWith(@"\\?\", StringComparison.Ordinal)) throw new InvalidOperationException("local canonical directory required");
                lease.Path = canonical.Substring(4);
            }
            ValidatePath(lease.Path);
            // Deny short-name/namespace aliases rather than admitting a second spelling.
            if (!string.Equals(input, lease.Path, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("directory spelling is not canonical");
            return lease;
        }
        catch { lease.Dispose(); throw; }
    }

    public static void ValidatePath(string value)
    {
        if (!OperatingSystem.IsWindows() || value == null || value.Length < 4 || value.Length > 4096
            || !Regex.IsMatch(value, @"^[A-Za-z]:\\") || System.IO.Path.GetFullPath(value) != value
            || Regex.IsMatch(value.Substring(3), "[:/<>\"|?*\\x00-\\x1f\\x7f]")) throw new ArgumentException("canonical Windows path required");
        foreach (string part in value.Substring(3).Split('\\'))
            if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ")
                || Regex.IsMatch(part, @"^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)", RegexOptions.IgnoreCase)) throw new ArgumentException("ambiguous Windows path");
    }

    // The caller must already pin the file's parent directory. Sharing READ only
    // rejects a pre-existing writer and prevents replace/write while inspected.
    public FileStream PinFile(string leaf)
    {
        if (string.IsNullOrEmpty(leaf) || leaf.IndexOfAny(new[] { '\\', '/', ':' }) >= 0 || leaf == "." || leaf == "..") throw new ArgumentException("one metadata filename required");
        var handle = CreateFile(System.IO.Path.Combine(Path, leaf), 0x80000000, 1, IntPtr.Zero, 3, 0x00200080, IntPtr.Zero);
        if (handle.IsInvalid) { handle.Dispose(); Fail(); }
        try
        {
            if (!GetFileInformationByHandle(handle, out FileInformation info)) Fail();
            if ((info.Attributes & (0x400u | 0x10u)) != 0 || info.NumberOfLinks != 1 || info.SizeHigh != 0 || info.SizeLow > 4096)
                throw new InvalidOperationException("bounded single-link metadata file required");
            return new FileStream(handle, FileAccess.Read, 4096, false);
        }
        catch { handle.Dispose(); throw; }
    }

    public void RequireAbsent(string leaf)
    {
        if (string.IsNullOrEmpty(leaf) || leaf.IndexOfAny(new[] { '\\','/',':' }) >= 0) throw new ArgumentException("one metadata filename required");
        uint attributes = GetFileAttributes(System.IO.Path.Combine(Path,leaf));
        if (attributes != uint.MaxValue) throw new InvalidOperationException("unsupported filesystem redirection metadata");
        if (Marshal.GetLastWin32Error() != 2) Fail(); // Only exact file absence, never access-denied inference.
    }

    public static string ReadText(FileStream file)
    {
        if (file.Length > 4096) throw new InvalidOperationException("metadata size exceeded");
        byte[] bytes = new byte[(int)file.Length]; file.Position = 0; file.ReadExactly(bytes);
        string text = new UTF8Encoding(false, true).GetString(bytes);
        if (text.IndexOf('\0') >= 0) throw new InvalidOperationException("invalid metadata text");
        return text;
    }
    public void Dispose() { for (int i = handles.Count - 1; i >= 0; i--) handles[i].Dispose(); handles.Clear(); }
    private static void Fail() => throw new Win32Exception(Marshal.GetLastWin32Error(), "filesystem observation unavailable");
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation
    { public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh, VolumeSerialNumber, SizeHigh, SizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow; }
    [StructLayout(LayoutKind.Sequential)] private struct CaseSensitiveInformation { public uint Flags; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out CaseSensitiveInformation info, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFileAttributes(string name);
}
