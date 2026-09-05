using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

namespace Acp.Worker;

public sealed class WindowsRecoveryObservation
{
    public string State { get; set; } = "unconfirmed";
    public string Reason { get; set; } = "identity_or_access_unconfirmed";
    public int? ExitCode { get; set; }
}

public static class WindowsWorkerRecovery
{
    public static WindowsRecoveryObservation Stop(string name, int pid, string token,
        string expectedMachine, string expectedBoot, int expectedSession, WindowsWorkerScope actual, int timeoutMs)
    {
        var unknown = new WindowsRecoveryObservation();
        if (actual.MachineFingerprint != expectedMachine) return unknown;
        var boot = DateTimeOffset.Parse(expectedBoot, CultureInfo.InvariantCulture);
        var currentBoot = DateTimeOffset.Parse(actual.BootedAt, CultureInfo.InvariantCulture);
        // A wall-clock-derived boot timestamp is a namespace guard, not proof
        // that a prior kernel boot ended. Any change fails closed.
        if (currentBoot != boot || actual.SessionId != expectedSession) return unknown;
        IntPtr job = IntPtr.Zero, root = IntPtr.Zero;
        try
        {
            job = OpenJobObject(0x0004 | 0x0008, false, name); // QUERY | TERMINATE; no inheritance.
            int jobError = job == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            if (job == IntPtr.Zero && jobError != 2) return unknown; // Only FILE_NOT_FOUND is absence.
            root = OpenProcess(0x1000 | 0x100000, false, (uint)pid); // query + synchronize, never PID kill.
            int rootError = root == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
            if (root == IntPtr.Zero && rootError != 87) return unknown;
            bool sameRoot = false;
            if (root != IntPtr.Zero)
            {
                if (!GetProcessTimes(root, out long creation, out long exit, out long kernel, out long user)) return unknown;
                sameRoot = token == "win32-filetime:" + creation.ToString(CultureInfo.InvariantCulture);
            }
            bool rootExited = !sameRoot || WaitForSingleObject(root, 0) == 0;
            // Same host/boot/namespace + missing immutable job + old root gone:
            // Windows destroys a job only after its processes terminate.
            if (job == IntPtr.Zero) return rootExited
                ? new WindowsRecoveryObservation { State = "lost", Reason = "owned_job_and_original_root_absent" } : unknown;
            if (Active(job) == 0 && rootExited)
                return new WindowsRecoveryObservation { State = "lost", Reason = "owned_job_empty" };
            // Do not touch a reused PID or a newly colliding job name. A root
            // missing while descendants remain is deliberately unconfirmed.
            if (!sameRoot || !IsProcessInJob(root, job, out bool member) || !member) return unknown;
            if (!TerminateJobObject(job, 137)) return unknown;
            var elapsed = Stopwatch.StartNew();
            while (Active(job) != 0 || WaitForSingleObject(root, 0) != 0)
            {
                if (elapsed.ElapsedMilliseconds >= timeoutMs) return unknown;
                Thread.Sleep(10);
            }
            if (!GetExitCodeProcess(root, out uint code)) return unknown;
            return new WindowsRecoveryObservation { State = "terminated", Reason = "exact_owned_tree_terminated", ExitCode = unchecked((int)code) };
        }
        finally { if (root != IntPtr.Zero) CloseHandle(root); if (job != IntPtr.Zero) CloseHandle(job); }
    }
    private static uint Active(IntPtr job)
    {
        if (!QueryInformationJobObject(job, 1, out Accounting info, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return info.ActiveProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Accounting
    { public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
}
