using System;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace Acp.Worker;

public sealed class WindowsWorkerScope
{
    public string MachineFingerprint { get; private set; }
    public string BootedAt { get; private set; }
    public int SessionId { get; private set; }

    public static WindowsWorkerScope Read(DateTime bootedAt)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        // Read only this non-credential OS installation identifier. Persist its
        // hash, not the raw identifier. Never infer identity from a host label.
        using var registry = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);
        using var identity = registry.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography", false);
        string machine = identity?.GetValue("MachineGuid") as string;
        if (string.IsNullOrWhiteSpace(machine)) throw new InvalidOperationException("OS identity unavailable");
        using var self = Process.GetCurrentProcess();
        DateTime boot = bootedAt.ToUniversalTime();
        if (boot > DateTime.UtcNow || boot.Year < 2000) throw new InvalidOperationException("boot identity unavailable");
        return new WindowsWorkerScope {
            MachineFingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(machine))).ToLowerInvariant(),
            BootedAt = boot.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
            SessionId = self.SessionId
        };
    }
}
