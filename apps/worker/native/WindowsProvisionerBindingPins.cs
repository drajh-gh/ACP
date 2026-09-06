using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;

namespace Acp.Worker;

// Standalone pre-create namespace pins only: no target/branch absence claim,
// Git-content snapshot, write grant, sandbox or abrupt writer-stop ordering.
public sealed class WindowsProvisionerBindingPins : IDisposable
{
    private readonly List<WindowsFilesystemReadLease> retained = new List<WindowsFilesystemReadLease>();
    private readonly object lifetime = new object();
    private bool disposed;
    private WindowsProvisionerBindingPins() { }

    public static WindowsProvisionerBindingPins Open(WindowsWorkerScope actualScope, string expectedMachine,
        string workspacePath, string parentPath, string parentIdentity, string commonGitPath, string commonGitIdentity)
    {
        if (actualScope == null || expectedMachine == null || !Regex.IsMatch(expectedMachine, @"\A[0-9a-f]{64}\z")
            || actualScope.MachineFingerprint != expectedMachine) throw new InvalidOperationException("provisioner machine changed");
        WindowsFilesystemReadLease.ValidatePath(workspacePath);
        WindowsFilesystemReadLease.ValidatePath(parentPath);
        WindowsFilesystemReadLease.ValidatePath(commonGitPath);
        if (!string.Equals(Path.GetDirectoryName(workspacePath), parentPath, StringComparison.Ordinal)
            || parentIdentity == commonGitIdentity || Overlap(workspacePath, commonGitPath))
            throw new InvalidOperationException("exact separate provisioner bindings required");
        var pins = new WindowsProvisionerBindingPins();
        try
        {
            pins.Directory(parentPath, parentIdentity);
            pins.Directory(commonGitPath, commonGitIdentity);
            // Do not inspect or promise target absence: these handles permit
            // child creation and do not reserve optional Git metadata names.
            return pins;
        }
        catch { pins.Dispose(); throw; }
    }
    private void Directory(string path, string identity)
    {
        if (identity == null || !Regex.IsMatch(identity, @"\Awin32-dir:[0-9a-f]{8}:[0-9a-f]{16}\z"))
            throw new InvalidOperationException("exact native directory identity required");
        var lease = WindowsFilesystemReadLease.Directory(path);
        retained.Add(lease); // Any subsequent mismatch owns and closes this lease.
        if (lease.Identity != identity || !string.Equals(lease.Path, path, StringComparison.Ordinal))
            throw new InvalidOperationException("retained provisioner directory changed");
    }
    public void Dispose()
    {
        lock (lifetime)
        {
            if (disposed) return;
            disposed = true;
            Exception failure = null;
            for (int i = retained.Count - 1; i >= 0; i--)
                try { retained[i].Dispose(); } catch (Exception error) { failure ??= error; }
            retained.Clear();
            if (failure != null) throw failure;
        }
    }
    private static bool Overlap(string left, string right) => string.Equals(left, right, StringComparison.OrdinalIgnoreCase)
        || left.StartsWith(right + "\\", StringComparison.OrdinalIgnoreCase) || right.StartsWith(left + "\\", StringComparison.OrdinalIgnoreCase);
}
