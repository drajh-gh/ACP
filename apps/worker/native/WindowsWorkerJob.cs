using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Acp.Worker;

// Only the trusted bridge owns this handle. It is never inherited by the SDK
// runner; closing the owner kills its nested tree without bypassing parent jobs.
public sealed class WindowsWorkerJob : IDisposable
{
    private IntPtr job;
    private IntPtr process;
    private IntPtr thread;
    private bool disposed;
    private readonly object lifetime = new object();
    private readonly ManualResetEventSlim ownerClosed = new ManualResetEventSlim(false);
    private volatile bool deadlineExpired;
    public bool DeadlineExpired => deadlineExpired;
    public int ProcessId { get; private set; }
    public string ProcessStartToken { get; private set; }
    public string StartedAt { get; private set; }
    public AnonymousPipeServerStream Input { get; private set; }
    public AnonymousPipeServerStream Output { get; private set; }
    public AnonymousPipeServerStream Error { get; private set; }

    public static WindowsWorkerJob Create(string name, string executable, string[] arguments,
        string workspace, string[] environment, DateTime deadlineUtc)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var owner = new WindowsWorkerJob();
        IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, jobs = IntPtr.Zero, environmentBlock = IntPtr.Zero;
        bool attributesInitialized = false;
        try
        {
            owner.job = CreateJobObject(IntPtr.Zero, name);
            if (owner.job == IntPtr.Zero) Fail("CreateJobObject");
            if (Marshal.GetLastWin32Error() == 183) throw new InvalidOperationException("job identity already exists");
            var limits = new ExtendedLimits();
            limits.Basic.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE; no breakaway.
            if (!SetInformationJobObject(owner.job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>())) Fail("SetInformationJobObject");

            owner.Input = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
            owner.Output = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
            owner.Error = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
            var startup = new StartupInfoEx();
            startup.Startup.Size = Marshal.SizeOf<StartupInfoEx>();
            startup.Startup.Flags = 0x100; // STARTF_USESTDHANDLES.
            startup.Startup.StandardInput = owner.Input.ClientSafePipeHandle.DangerousGetHandle();
            startup.Startup.StandardOutput = owner.Output.ClientSafePipeHandle.DangerousGetHandle();
            startup.Startup.StandardError = owner.Error.ClientSafePipeHandle.DangerousGetHandle();
            IntPtr length = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref length);
            if (length == IntPtr.Zero) Fail("attribute-list size");
            attributes = Marshal.AllocHGlobal(length);
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref length)) Fail("InitializeProcThreadAttributeList");
            attributesInitialized = true;
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handles, 0, startup.Startup.StandardInput);
            Marshal.WriteIntPtr(handles, IntPtr.Size, startup.Startup.StandardOutput);
            Marshal.WriteIntPtr(handles, IntPtr.Size * 2, startup.Startup.StandardError);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles,
                new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) Fail("UpdateProcThreadAttribute");
            jobs = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobs, owner.job);
            // Windows 10+: ownership is attached by CreateProcess itself. There
            // is no create→assign gap in which owner death could orphan a root.
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobs,
                new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) Fail("job-list attribute");
            startup.Attributes = attributes;

            Array.Sort(environment, StringComparer.OrdinalIgnoreCase);
            environmentBlock = Marshal.StringToHGlobalUni(string.Join("\0", environment) + "\0\0");
            var command = new StringBuilder(Quote(executable));
            foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
            // Suspended + hidden + Unicode environment + explicit handle list.
            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                0x08000000 | 0x00000004 | 0x00000400 | 0x00080000, environmentBlock,
                workspace, ref startup, out ProcessInformation info)) Fail("CreateProcess");
            owner.process = info.Process;
            owner.thread = info.Thread;
            owner.ProcessId = checked((int)info.ProcessId);
            if (!GetProcessTimes(owner.process, out long creation, out long exit, out long kernel, out long user)) Fail("GetProcessTimes");
            owner.ProcessStartToken = "win32-filetime:" + creation.ToString(System.Globalization.CultureInfo.InvariantCulture);
            owner.StartedAt = DateTime.FromFileTimeUtc(creation).ToString("O");
            owner.Input.DisposeLocalCopyOfClientHandle();
            owner.Output.DisposeLocalCopyOfClientHandle();
            owner.Error.DisposeLocalCopyOfClientHandle();
            owner.ArmDeadline(deadlineUtc);
            return owner;
        }
        catch { owner.Dispose(); throw; }
        finally
        {
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
            if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
            if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
        }
    }

    public void Resume()
    {
        if (thread == IntPtr.Zero) throw new InvalidOperationException("runner already resumed");
        if (ResumeThread(thread) == uint.MaxValue) Fail("ResumeThread");
        CloseHandle(thread); thread = IntPtr.Zero;
    }

    // The bridge is a dedicated process. Deadline enforcement must not depend
    // on its PowerShell loop or on either side draining a pipe. Even if control
    // output is blocked, the owned tree dies and the bridge exits after grace.
    private void ArmDeadline(DateTime deadlineUtc)
    {
        double remaining = (deadlineUtc.ToUniversalTime() - DateTime.UtcNow).TotalMilliseconds;
        if (remaining <= 0 || remaining > 86400000) throw new ArgumentException("invalid deadline");
        var watchdog = new Thread(() =>
        {
            if (ownerClosed.Wait((int)Math.Ceiling(remaining))) return;
            lock (lifetime)
            {
                if (disposed) return;
                deadlineExpired = true;
                TerminateJobObject(job, 137);
            }
            if (!ownerClosed.Wait(6000)) Environment.Exit(137);
        });
        watchdog.IsBackground = true;
        watchdog.Name = "ACP owned-worker deadline";
        watchdog.Start();
    }

    public Task BeginInput(byte[] bytes) => Task.Run(() =>
    {
        try { Input.Write(bytes, 0, bytes.Length); }
        finally { Input.Dispose(); }
    });

    public bool RootExited => WaitForSingleObject(process, 0) == 0;
    public int ExitCode
    {
        get
        {
            if (!RootExited) throw new InvalidOperationException("root still running");
            if (!GetExitCodeProcess(process, out uint code)) Fail("GetExitCodeProcess");
            return unchecked((int)code);
        }
    }
    public uint ActiveProcesses
    {
        get
        {
            if (!QueryInformationJobObject(job, 1, out Accounting info, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero)) Fail("QueryInformationJobObject");
            return info.ActiveProcesses;
        }
    }
    public bool TerminateAndWait(int milliseconds)
    {
        if (!TerminateJobObject(job, 137)) Fail("TerminateJobObject");
        var elapsed = Stopwatch.StartNew();
        // Accounting can reach zero just before the root process handle is
        // signalled. Both facts must hold; that transient is not a failure.
        while (ActiveProcesses != 0 || !RootExited)
        {
            if (elapsed.ElapsedMilliseconds >= milliseconds) return false;
            Thread.Sleep(10);
        }
        return true;
    }
    public void Dispose()
    {
        lock (lifetime)
        {
            if (disposed) return;
            disposed = true;
            ownerClosed.Set();
            // Last owner close is fail-safe, but callers still require explicit
            // ActiveProcesses == 0 before reporting confirmed tree termination.
            if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
        }
        if (thread != IntPtr.Zero) { CloseHandle(thread); thread = IntPtr.Zero; }
        if (process != IntPtr.Zero) { CloseHandle(process); process = IntPtr.Zero; }
        Input?.Dispose(); Output?.Dispose(); Error?.Dispose();
        GC.SuppressFinalize(this);
    }
    private static void Fail(string operation) => throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    private static string Quote(string value)
    {
        if (value.IndexOf('\0') >= 0) throw new ArgumentException("NUL in argument");
        var output = new StringBuilder("\""); int slashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\') { slashes++; continue; }
            output.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes);
            output.Append(ch); slashes = 0;
        }
        return output.Append('\\', slashes * 2).Append('"').ToString();
    }

    [StructLayout(LayoutKind.Sequential)] private struct Accounting
    {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters
    { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        public long ProcessTime, JobTime; public uint LimitFlags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
    { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
    {
        public int Size; public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public ushort ShowWindow, Reserved2Length; public IntPtr Reserved2, StandardInput, StandardOutput, StandardError;
    }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
}
