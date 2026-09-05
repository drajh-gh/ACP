using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Acp.Integration;

public sealed class WindowsKillOnCloseJob : IDisposable
{
    private const uint CreateSuspended = 0x00000004;
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const uint WaitObject0 = 0x00000000;
    private const uint WaitTimeout = 0x00000102;
    private const int ExtendedLimitInformationClass = 9;

    private IntPtr jobHandle;
    private IntPtr processHandle;
    private bool disposed;

    private WindowsKillOnCloseJob(IntPtr jobHandle, IntPtr processHandle, uint processId)
    {
        this.jobHandle = jobHandle;
        this.processHandle = processHandle;
        ProcessId = checked((int)processId);
    }

    public int ProcessId { get; }

    public static WindowsKillOnCloseJob Start(
        string executablePath,
        string commandLine,
        string workingDirectory)
    {
        if (!OperatingSystem.IsWindows())
        {
            throw new PlatformNotSupportedException("Windows Job Objects require Windows.");
        }

        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed");
        }

        var limits = new JobObjectExtendedLimitInformation();
        limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
        int length = Marshal.SizeOf<JobObjectExtendedLimitInformation>();
        IntPtr limitsPointer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(limits, limitsPointer, false);
            if (!SetInformationJobObject(
                job,
                ExtendedLimitInformationClass,
                limitsPointer,
                (uint)length))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "SetInformationJobObject failed");
            }

            var startup = new StartupInfo { Size = Marshal.SizeOf<StartupInfo>() };
            if (!CreateProcess(
                executablePath,
                new StringBuilder(commandLine),
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CreateSuspended,
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out ProcessInformation process))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess failed");
            }

            try
            {
                if (!AssignProcessToJobObject(job, process.Process))
                {
                    TerminateProcess(process.Process, 193);
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error(),
                        "AssignProcessToJobObject failed");
                }
                if (ResumeThread(process.Thread) == uint.MaxValue)
                {
                    TerminateProcess(process.Process, 194);
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
                }
                return new WindowsKillOnCloseJob(job, process.Process, process.ProcessId);
            }
            catch
            {
                CloseHandle(process.Process);
                throw;
            }
            finally
            {
                CloseHandle(process.Thread);
            }
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(limitsPointer);
        }
    }

    public bool WaitForExit(int timeoutMilliseconds)
    {
        ThrowIfDisposed();
        uint result = WaitForSingleObject(processHandle, checked((uint)timeoutMilliseconds));
        if (result == WaitObject0) return true;
        if (result == WaitTimeout) return false;
        throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed");
    }

    public int GetExitCode()
    {
        ThrowIfDisposed();
        if (!GetExitCodeProcess(processHandle, out uint exitCode))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
        }
        return unchecked((int)exitCode);
    }

    // Root exit alone is insufficient before removing an owned fixture tree.
    public bool WaitForEmpty(int timeoutMilliseconds)
    {
        ThrowIfDisposed();
        if (timeoutMilliseconds < 0 || timeoutMilliseconds > 60000) throw new ArgumentOutOfRangeException(nameof(timeoutMilliseconds));
        var elapsed = Stopwatch.StartNew();
        do
        {
            if (!QueryInformationJobObject(jobHandle, 1, out Accounting info, (uint)Marshal.SizeOf<Accounting>(), IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "QueryInformationJobObject failed");
            if (info.ActiveProcesses == 0 && WaitForExit(0)) return true;
            if (elapsed.ElapsedMilliseconds >= timeoutMilliseconds) return false;
            Thread.Sleep(10);
        } while (true);
    }

    public void Terminate(int exitCode)
    {
        ThrowIfDisposed();
        if (!TerminateJobObject(jobHandle, unchecked((uint)exitCode)))
        {
            int error = Marshal.GetLastWin32Error();
            if (error != 5)
            {
                throw new Win32Exception(error, "TerminateJobObject failed");
            }
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        if (processHandle != IntPtr.Zero)
        {
            CloseHandle(processHandle);
            processHandle = IntPtr.Zero;
        }
        if (jobHandle != IntPtr.Zero)
        {
            CloseHandle(jobHandle);
            jobHandle = IntPtr.Zero;
        }
        GC.SuppressFinalize(this);
    }

    private void ThrowIfDisposed()
    {
        if (disposed) throw new ObjectDisposedException(nameof(WindowsKillOnCloseJob));
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting
    {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint Faults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved;
        public string Desktop;
        public string Title;
        public uint X;
        public uint Y;
        public uint XSize;
        public uint YSize;
        public uint XCountChars;
        public uint YCountChars;
        public uint FillAttribute;
        public uint Flags;
        public ushort ShowWindow;
        public ushort Reserved2Length;
        public IntPtr Reserved2;
        public IntPtr StandardInput;
        public IntPtr StandardOutput;
        public IntPtr StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public uint ProcessId;
        public uint ThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int informationClass, out Accounting info, uint length, IntPtr returned);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
