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

public sealed class WindowsFilesystemLeaseChallenge
{
    public string Nonce { get; }
    public long Epoch { get; }
    internal WindowsFilesystemLeaseChallenge(string nonce, long epoch) { Nonce = nonce; Epoch = epoch; }
}

public sealed class WindowsProvisionerAdmissionChallenge
{
    public string Nonce { get; }
    public long Epoch => 1;
    internal WindowsProvisionerAdmissionChallenge(string nonce) { Nonce = nonce; }
}

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
    private enum AdmissionMode { None, FilesystemLease, Provisioner }
    private AdmissionMode admissionMode;
    private bool filesystemLeaseRequired => admissionMode == AdmissionMode.FilesystemLease;
    private bool stopping, filesystemLeaseAccepted;
    private string leaseId, leaseRunId, leaseWorkerProcessId, challengeNonce;
    private long runDeadlineTicks, bootstrapDeadlineTicks, leaseDeadlineTicks, challengeIssuedTicks, challengeEpoch, leaseRevision;
    private string provisionerAttemptId, provisionerNonce;
    private long provisionerRevision, provisionerChallengeTicks, provisionerDeadlineTicks;
    private bool provisionerChallenged, provisionerAccepted, provisionerGoConsumed;
    public bool DeadlineExpired => deadlineExpired;
    public int ProcessId { get; private set; }
    public string ProcessStartToken { get; private set; }
    public string StartedAt { get; private set; }
    public AnonymousPipeServerStream Input { get; private set; }
    public AnonymousPipeServerStream Output { get; private set; }
    public AnonymousPipeServerStream Error { get; private set; }

    public static WindowsWorkerJob Create(string name, string executable, string[] arguments,
        string workspace, string[] environment, DateTime deadlineUtc)
        => CreateCore(name, executable, arguments, workspace, environment, deadlineUtc, null, null, null);

    // Private bridge protocol only: the trusted daemon must obtain a fresh DB
    // ACK after each challenge. The native process has no database credential.
    public static WindowsWorkerJob CreateWithFilesystemLease(string name, string executable, string[] arguments,
        string workspace, string[] environment, DateTime deadlineUtc, string leaseId, string runId, string workerProcessId)
    {
        if (!Stopwatch.IsHighResolution) throw new PlatformNotSupportedException("native lease watchdog requires QPC");
        RequireId(leaseId, "lea_"); RequireId(runId, "run_"); RequireId(workerProcessId, "wpr_");
        if (name != "Local\\ACP.Worker." + workerProcessId) throw new ArgumentException("lease job identity mismatch");
        return CreateCore(name, executable, arguments, workspace, environment, deadlineUtc, leaseId, runId, workerProcessId);
    }

    // Native-only one-shot prerequisite, not a DB authenticator or a filesystem
    // grant. The private bridge must separately bind the complete original plan
    // and permanent WPA fence; this class never creates or seals that fence.
    public static WindowsWorkerJob CreateWithProvisionerAdmission(string name, string executable, string[] arguments,
        string workspace, string[] environment, DateTime deadlineUtc, string attemptId, long reservationRevision)
    {
        if (!Stopwatch.IsHighResolution) throw new PlatformNotSupportedException("native admission watchdog requires QPC");
        RequireId(attemptId, "wpa_");
        if (name != "Local\\ACP.Provisioner." + attemptId || reservationRevision < 1 || reservationRevision > int.MaxValue)
            throw new ArgumentException("original provisioner identity and revision required");
        long began = Stopwatch.GetTimestamp();
        double remaining = (deadlineUtc.ToUniversalTime() - DateTime.UtcNow).TotalMilliseconds;
        if (remaining <= 0 || remaining > 20000) throw new ArgumentException("original provisioner deadline must be within twenty seconds");
        long originalDeadline = checked(began + MillisecondTicks(remaining));
        long bootstrapDeadline = checked(began + MillisecondTicks(15000));
        return CreateCore(name, executable, arguments, workspace, environment, deadlineUtc, null, null, null,
            attemptId, reservationRevision, originalDeadline, bootstrapDeadline);
    }
    private static WindowsWorkerJob CreateCore(string name, string executable, string[] arguments,
        string workspace, string[] environment, DateTime deadlineUtc, string leaseId, string runId, string workerProcessId,
        string provisionerAttemptId = null, long provisionerRevision = 0,
        long provisionerOriginalDeadline = 0, long provisionerBootstrapDeadline = 0)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        var owner = new WindowsWorkerJob();
        owner.admissionMode = provisionerAttemptId != null ? AdmissionMode.Provisioner : leaseId != null ? AdmissionMode.FilesystemLease : AdmissionMode.None;
        owner.leaseId = leaseId; owner.leaseRunId = runId; owner.leaseWorkerProcessId = workerProcessId;
        owner.provisionerAttemptId = provisionerAttemptId; owner.provisionerRevision = provisionerRevision;
        if (owner.admissionMode == AdmissionMode.Provisioner)
        {
            owner.runDeadlineTicks = provisionerOriginalDeadline; owner.bootstrapDeadlineTicks = provisionerBootstrapDeadline;
        }
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
        lock (lifetime)
        {
            RequireLiveLocked();
            if (admissionMode == AdmissionMode.Provisioner) throw DenyProvisionerLocked();
            if (filesystemLeaseRequired && !filesystemLeaseAccepted) throw DenyLeaseLocked();
            if (thread == IntPtr.Zero) throw new InvalidOperationException("runner already resumed");
            if (ResumeThread(thread) == uint.MaxValue) Fail("ResumeThread");
            CloseHandle(thread); thread = IntPtr.Zero;
        }
    }

    public WindowsProvisionerAdmissionChallenge BeginProvisionerAdmissionChallenge()
    {
        lock (lifetime)
        {
            RequireProvisionerLiveLocked();
            if (admissionMode != AdmissionMode.Provisioner || provisionerChallenged) throw DenyProvisionerLocked();
            provisionerChallenged = true;
            provisionerNonce = Guid.NewGuid().ToString("N");
            provisionerChallengeTicks = Stopwatch.GetTimestamp();
            return new WindowsProvisionerAdmissionChallenge(provisionerNonce);
        }
    }
    public void AcceptProvisionerAdmissionChallenge(string nonce, long epoch, string attemptId,
        long reservationRevision, long durationMilliseconds)
    {
        lock (lifetime)
        {
            RequireProvisionerLiveLocked(); // Neither an expired original plan nor bootstrap can be revived.
            if (admissionMode != AdmissionMode.Provisioner || !provisionerChallenged || provisionerAccepted
                || nonce != provisionerNonce || epoch != 1 || attemptId != provisionerAttemptId || reservationRevision != provisionerRevision
                || durationMilliseconds <= 250 || durationMilliseconds > 20000) throw DenyProvisionerLocked();
            long deadline = checked(provisionerChallengeTicks + MillisecondTicks(durationMilliseconds - 250));
            long received = Stopwatch.GetTimestamp();
            if (received >= EffectiveDeadlineTicks() || received >= deadline) throw DenyProvisionerLocked();
            provisionerDeadlineTicks = deadline; provisionerAccepted = true; provisionerNonce = null;
        }
    }
    public void GoProvisioner()
    {
        lock (lifetime)
        {
            RequireProvisionerLiveLocked();
            if (admissionMode != AdmissionMode.Provisioner || !provisionerAccepted || provisionerGoConsumed || thread == IntPtr.Zero)
                throw DenyProvisionerLocked();
            // Consume before the syscall. An uncertain ResumeThread failure is
            // a permanent stop, never an opportunity to issue another GO.
            provisionerGoConsumed = true;
            if (ResumeThread(thread) == uint.MaxValue) throw DenyProvisionerLocked();
            CloseHandle(thread); thread = IntPtr.Zero;
        }
    }

    public WindowsFilesystemLeaseChallenge BeginFilesystemLeaseChallenge()
    {
        lock (lifetime)
        {
            RequireLiveLocked();
            if (!filesystemLeaseRequired || challengeNonce != null) throw DenyLeaseLocked();
            challengeNonce = Guid.NewGuid().ToString("N");
            challengeIssuedTicks = Stopwatch.GetTimestamp();
            challengeEpoch = checked(challengeEpoch + 1);
            return new WindowsFilesystemLeaseChallenge(challengeNonce, challengeEpoch);
        }
    }
    public void AcceptFilesystemLeaseChallenge(string nonce, long epoch, string leaseId, string runId,
        string workerProcessId, long revision, long durationMilliseconds)
    {
        lock (lifetime)
        {
            RequireLiveLocked(); // OLD deadline always wins before considering a new ACK.
            if (!filesystemLeaseRequired || challengeNonce == null || nonce != challengeNonce || epoch != challengeEpoch
                || leaseId != this.leaseId || runId != leaseRunId || workerProcessId != leaseWorkerProcessId
                || revision <= leaseRevision || revision > 9007199254740991L || durationMilliseconds <= 250 || durationMilliseconds > 20000)
                throw DenyLeaseLocked();
            // Challenge issuance precedes the fresh database heartbeat. Message
            // queues and COMMIT latency spend budget instead of replenishing it.
            long deadline = checked(challengeIssuedTicks + MillisecondTicks(durationMilliseconds - 250));
            long received = Stopwatch.GetTimestamp();
            if (received >= EffectiveDeadlineTicks() || received >= deadline) throw DenyLeaseLocked();
            leaseDeadlineTicks = deadline; leaseRevision = revision;
            filesystemLeaseAccepted = true; challengeNonce = null;
        }
    }
    private void RequireLiveLocked()
    {
        if (disposed || stopping || deadlineExpired) throw new InvalidOperationException("owned worker no longer live");
        if (Stopwatch.GetTimestamp() >= EffectiveDeadlineTicks()) { ExpireLocked(); throw new InvalidOperationException("owned deadline expired"); }
        if (WaitForSingleObject(process, 0) == 0)
        {
            if (admissionMode == AdmissionMode.Provisioner) ExpireLocked();
            throw new InvalidOperationException("owned root already exited");
        }
    }
    private void RequireProvisionerLiveLocked()
    {
        try { RequireLiveLocked(); }
        catch { if (!disposed) ExpireLocked(); throw; }
    }
    private InvalidOperationException DenyLeaseLocked()
    {
        ExpireLocked(); return new InvalidOperationException("filesystem lease epoch denied");
    }
    private InvalidOperationException DenyProvisionerLocked()
    {
        ExpireLocked(); return new InvalidOperationException("one-shot provisioner admission denied");
    }
    private void ExpireLocked()
    {
        deadlineExpired = true; stopping = true;
        if (job != IntPtr.Zero) TerminateJobObject(job, 137);
    }
    private long EffectiveDeadlineTicks() => admissionMode == AdmissionMode.Provisioner
        ? Math.Min(runDeadlineTicks, provisionerAccepted ? provisionerDeadlineTicks : bootstrapDeadlineTicks)
        : filesystemLeaseRequired ? Math.Min(runDeadlineTicks, filesystemLeaseAccepted ? leaseDeadlineTicks : bootstrapDeadlineTicks) : runDeadlineTicks;
    private static long MillisecondTicks(double milliseconds) => checked((long)(milliseconds * Stopwatch.Frequency / 1000.0));
    private static void RequireId(string value, string prefix)
    {
        if (value == null || value.Length != prefix.Length + 36 || !value.StartsWith(prefix, StringComparison.Ordinal)
            || !Guid.TryParseExact(value.Substring(prefix.Length), "D", out Guid parsed)
            || value[prefix.Length + 14] != '4' || "89ab".IndexOf(value[prefix.Length + 19]) < 0
            || prefix + parsed.ToString("D") != value) throw new ArgumentException("canonical lease identity required");
    }

    // The bridge is a dedicated process. Deadline enforcement must not depend
    // on its PowerShell loop or on either side draining a pipe. Even if control
    // output is blocked, the owned tree dies and the bridge exits after grace.
    private void ArmDeadline(DateTime deadlineUtc)
    {
        if (admissionMode == AdmissionMode.Provisioner)
        {
            // Original/bootstrap clocks were captured before CreateProcess.
            // Creation and later wall-clock changes cannot replenish them.
            if (Stopwatch.GetTimestamp() >= EffectiveDeadlineTicks()) throw new ArgumentException("provisioner creation exceeded original deadline");
        }
        else
        {
            double remaining = (deadlineUtc.ToUniversalTime() - DateTime.UtcNow).TotalMilliseconds;
            if (remaining <= 0 || remaining > 86400000) throw new ArgumentException("invalid deadline");
            long began = Stopwatch.GetTimestamp();
            runDeadlineTicks = checked(began + MillisecondTicks(remaining));
            bootstrapDeadlineTicks = checked(began + MillisecondTicks(15000));
        }
        var watchdog = new Thread(() =>
        {
            while (true)
            {
                int wait;
                lock (lifetime)
                {
                    if (disposed) return;
                    long left = EffectiveDeadlineTicks() - Stopwatch.GetTimestamp();
                    if (deadlineExpired || left <= 0) { ExpireLocked(); break; }
                    // Recheck native monotonic time after wake, including sleep/
                    // hibernate. Never block on IPC, database access or stdout.
                    wait = (int)Math.Min(100, Math.Max(1, Math.Ceiling(left * 1000.0 / Stopwatch.Frequency)));
                }
                if (ownerClosed.Wait(wait)) return;
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
        lock (lifetime)
        {
            if (disposed) throw new ObjectDisposedException(nameof(WindowsWorkerJob));
            stopping = true;
            if (!TerminateJobObject(job, 137)) Fail("TerminateJobObject");
        }
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
