using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Acp.Worker;

// A persistent, append-only creation/resume fence, not an authorization source.
// The trusted supervisor must durably authorize its exact directory and ID first.
// Never remove these files while a delayed launcher may still hold authority.
public sealed class WindowsLaunchFence : IDisposable
{
    private const string Magic = "ACP-LAUNCH-FENCE-1";
    private DirectoryLease directoryHandle;
    private FileStream file;
    private string header;
    private bool claimed, sealedLaunch;
    public int ProcessId { get; private set; }
    public string ProcessStartToken { get; private set; }
    public string StartedAt { get; private set; }
    public bool IsSealed => sealedLaunch;

    public static string DirectoryIdentity(string directory)
    {
        using var handle = OpenDirectory(directory);
        return handle.Identity;
    }

    public static WindowsLaunchFence Open(string directory, string expectedDirectoryIdentity,
        string workerProcessId, string machine, string boot, int session, int timeoutMs)
    {
        if (!Regex.IsMatch(workerProcessId, @"^wpr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z"))
            throw new ArgumentException("invalid launch fence identity");
        return OpenExact(directory, expectedDirectoryIdentity, workerProcessId, machine, boot, session, timeoutMs, Magic, ".launch");
    }

    // Native exclusion only. This does not authorize provisioning, certify a DB plan, or replace its stop journal.
    public static WindowsLaunchFence OpenProvisioner(string directory, string expectedDirectoryIdentity,
        string attemptId, string machine, string boot, int session, int timeoutMs)
    {
        if (!Regex.IsMatch(attemptId, @"^wpa_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z"))
            throw new ArgumentException("invalid provisioner fence identity");
        return OpenExact(directory, expectedDirectoryIdentity, attemptId, machine, boot, session, timeoutMs,
            "ACP-PROVISIONER-FENCE-1", ".provision");
    }

    private static WindowsLaunchFence OpenExact(string directory, string expectedDirectoryIdentity,
        string identity, string machine, string boot, int session, int timeoutMs, string magic, string suffix)
    {
        if (!Regex.IsMatch(machine, @"^[0-9a-f]{64}\z") || session < 0 || timeoutMs < 1 || timeoutMs > 5000)
            throw new ArgumentException("invalid launch fence scope");
        string canonicalBoot = DateTimeOffset.Parse(boot, CultureInfo.InvariantCulture).UtcDateTime.ToString("O");
        var fence = new WindowsLaunchFence();
        try
        {
            fence.directoryHandle = OpenDirectory(directory);
            if (fence.directoryHandle.Identity != expectedDirectoryIdentity) throw new InvalidOperationException("launch fence directory identity changed");
            string path = Path.Combine(Path.GetFullPath(directory), identity + suffix);
            var elapsed = Stopwatch.StartNew();
            while (true)
            {
                // OPEN_ALWAYS, no sharing (including delete), never follow a final reparse point.
                var handle = CreateFile(path, 0xC0000000, 0, IntPtr.Zero, 4, 0x80200080, IntPtr.Zero);
                if (!handle.IsInvalid)
                {
                    try
                    {
                        if (!GetFileInformationByHandle(handle, out FileInformation info)) Fail("inspect launch fence");
                        if ((info.Attributes & (0x400u | 0x10u)) != 0 || info.NumberOfLinks != 1)
                            throw new InvalidOperationException("launch fence must be a single non-reparse file");
                        fence.file = new FileStream(handle, FileAccess.ReadWrite, 4096, false);
                    }
                    catch { handle.Dispose(); throw; }
                    break;
                }
                int error = Marshal.GetLastWin32Error(); handle.Dispose();
                if (error != 32 && error != 33) throw new Win32Exception(error, "open launch fence failed");
                if (elapsed.ElapsedMilliseconds >= timeoutMs) throw new TimeoutException("launch fence busy");
                Thread.Sleep(10);
            }
            fence.header = string.Join("\n", magic, identity, machine, canonicalBoot,
                session.ToString(CultureInfo.InvariantCulture)) + "\n";
            fence.Read();
            return fence;
        }
        catch { fence.Dispose(); throw; }
    }

    public void Begin()
    {
        // A partial/nonempty claim can never become unused after a crash.
        if (file.Length != 0) throw new InvalidOperationException("launch identity already consumed");
        Append(header + "claimed\n"); claimed = true;
    }

    public void RecordRoot(int pid, string token, string startedAt)
    {
        if (!claimed || sealedLaunch || ProcessId != 0) throw new InvalidOperationException("launch cannot record another root");
        ValidateRoot(pid, token, startedAt);
        Append("root\t" + pid.ToString(CultureInfo.InvariantCulture) + "\t" + token + "\t" + startedAt + "\n");
        ProcessId = pid; ProcessStartToken = token; StartedAt = startedAt;
    }

    public void RequireRoot(int pid, string token)
    {
        if (!claimed || sealedLaunch || ProcessId == 0 || ProcessId != pid || ProcessStartToken != token)
            throw new InvalidOperationException("launch release was sealed or its identity changed");
    }

    public void Seal()
    {
        if (sealedLaunch) return;
        Append((file.Length == 0 ? header : "") + "sealed\n");
        sealedLaunch = true;
    }

    private void Append(string value)
    {
        byte[] bytes = new UTF8Encoding(false, true).GetBytes(value);
        if (file.Length + bytes.Length > 4096) throw new InvalidOperationException("launch fence overflow");
        file.Position = file.Length;
        file.Write(bytes, 0, bytes.Length);
        file.Flush(true); // Durable consumption/seal must precede CreateProcess/absence observation.
    }

    private void Read()
    {
        if (file.Length == 0) return;
        if (file.Length > 4096) throw new InvalidOperationException("invalid launch fence size");
        byte[] bytes = new byte[(int)file.Length]; file.ReadExactly(bytes);
        string text = new UTF8Encoding(false, true).GetString(bytes);
        if (!text.StartsWith(header, StringComparison.Ordinal) || !text.EndsWith("\n", StringComparison.Ordinal))
            throw new InvalidOperationException("launch fence identity or record is incomplete");
        string[] entries = text.Substring(header.Length).Split('\n');
        for (int index = 0; index < entries.Length - 1; index++)
        {
            string entry = entries[index];
            if (sealedLaunch) throw new InvalidOperationException("record after permanent launch seal");
            if (entry == "claimed" && !claimed && ProcessId == 0 && index == 0) { claimed = true; continue; }
            if (entry == "sealed") { sealedLaunch = true; continue; }
            string[] root = entry.Split('\t');
            if (!claimed || ProcessId != 0 || root.Length != 4 || root[0] != "root"
                || !int.TryParse(root[1], NumberStyles.None, CultureInfo.InvariantCulture, out int pid))
                throw new InvalidOperationException("invalid launch fence transition");
            ValidateRoot(pid, root[2], root[3]);
            ProcessId = pid; ProcessStartToken = root[2]; StartedAt = root[3];
        }
        if (!claimed && !sealedLaunch) throw new InvalidOperationException("missing launch fence transition");
    }

    private static void ValidateRoot(int pid, string token, string startedAt)
    {
        if (pid < 1 || !Regex.IsMatch(token, "^win32-filetime:[0-9]{16,20}$")
            || !long.TryParse(token.Substring(15), NumberStyles.None, CultureInfo.InvariantCulture, out long creation)
            || DateTimeOffset.Parse(startedAt, CultureInfo.InvariantCulture).UtcDateTime != DateTime.FromFileTimeUtc(creation))
            throw new ArgumentException("invalid fenced root identity");
    }

    private sealed class DirectoryLease : IDisposable
    {
        public readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
        public string Identity;
        public void Dispose() { for (int i = Handles.Count - 1; i >= 0; i--) Handles[i].Dispose(); }
    }

    private static DirectoryLease OpenDirectory(string directory)
    {
        if (!OperatingSystem.IsWindows() || !Path.IsPathFullyQualified(directory)) throw new ArgumentException("absolute Windows launch directory required");
        string full = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar);
        string drive = Path.GetPathRoot(full);
        if (full.TrimEnd('\\') == drive.TrimEnd('\\') || full.StartsWith(@"\\", StringComparison.Ordinal)
            || new DriveInfo(drive).DriveType != DriveType.Fixed) throw new ArgumentException("local dedicated launch directory required");
        var paths = new List<string>();
        for (var item = new DirectoryInfo(full); item != null; item = item.Parent) paths.Add(item.FullName);
        paths.Reverse();
        var lease = new DirectoryLease();
        try
        {
            // Anchor every ancestor without DELETE sharing before descending.
            // A leaf handle alone does not anchor a replaceable parent namespace.
            foreach (string path in paths)
            {
                // FILE_LIST_DIRECTORY participates in sharing; zero-access
                // metadata handles do not prevent an empty directory rename.
                var handle = CreateFile(path, 1, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                if (handle.IsInvalid) { handle.Dispose(); Fail("open launch directory"); }
                lease.Handles.Add(handle);
                if (!GetFileInformationByHandle(handle, out FileInformation info)) Fail("inspect launch directory");
                if ((info.Attributes & 0x400u) != 0 || (info.Attributes & 0x10u) == 0) throw new InvalidOperationException("invalid launch directory");
                lease.Identity = "win32-dir:" + info.VolumeSerialNumber.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8");
            }
            return lease;
        }
        catch { lease.Dispose(); throw; }
    }

    public void Dispose() { file?.Dispose(); directoryHandle?.Dispose(); }
    private static void Fail(string operation) => throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation
    {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh,
            VolumeSerialNumber, SizeHigh, SizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFile(
        string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation info);
}
