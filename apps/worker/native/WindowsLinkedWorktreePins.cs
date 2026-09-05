using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;

namespace Acp.Worker;

// Standalone identity-pin prerequisite. Not a lease, sandbox, branch/HEAD
// assertion or permission to execute. In-place directory-metadata mutation and
// abrupt pin-owner death ordering require a separate restricted-access contract.
public sealed class WindowsLinkedWorktreePins : IDisposable
{
    private readonly List<IDisposable> retained = new List<IDisposable>();
    private readonly object lifetime = new object();
    private bool disposed;

    private WindowsLinkedWorktreePins() { }

    public static WindowsLinkedWorktreePins Open(WindowsWorkerScope actualScope, string expectedMachine,
        string checkoutPath, string checkoutIdentity, string commonPath, string commonIdentity,
        string workspacePath, string workspaceIdentity, string metadataPath, string metadataIdentity)
    {
        if (actualScope == null || expectedMachine == null || !Regex.IsMatch(expectedMachine, "^[0-9a-f]{64}$")
            || actualScope.MachineFingerprint != expectedMachine) throw new InvalidOperationException("worktree machine changed");
        var pins = new WindowsLinkedWorktreePins();
        try
        {
            var checkout = pins.Directory(checkoutPath, checkoutIdentity);
            var common = pins.Directory(commonPath, commonIdentity);
            if (checkout.Identity == common.Identity || !Equal(common.Path, Path.Combine(checkout.Path, ".git")))
                throw new InvalidOperationException("ordinary repository metadata required");
            var workspace = pins.Directory(workspacePath, workspaceIdentity);
            if (workspace.Identity == checkout.Identity || workspace.Identity == common.Identity
                || Nested(workspace.Path, checkout.Path) || Nested(checkout.Path, workspace.Path))
                throw new InvalidOperationException("isolated linked workspace required");

            // Freeze only structural pointers. HEAD/index/refs/object content and
            // configuration policy are intentionally outside this identity scope.
            var dotGit = pins.File(workspace, ".git");
            string forward = Line(WindowsFilesystemReadLease.ReadText(dotGit));
            if (!forward.StartsWith("gitdir: ", StringComparison.Ordinal)) throw new InvalidOperationException("linked worktree pointer required");
            string pointedMetadata = Path.GetFullPath(forward.Substring(8), workspace.Path);
            if (!Equal(pointedMetadata, metadataPath) || !Equal(Path.GetDirectoryName(metadataPath), Path.Combine(common.Path, "worktrees")))
                throw new InvalidOperationException("worktree metadata target changed");
            var metadata = pins.Directory(metadataPath, metadataIdentity);
            if (metadata.Identity == workspace.Identity || metadata.Identity == checkout.Identity || metadata.Identity == common.Identity)
                throw new InvalidOperationException("separate linked metadata required");
            var reverse = pins.File(metadata, "gitdir");
            var commonPointer = pins.File(metadata, "commondir");
            if (!Equal(Path.GetFullPath(Line(WindowsFilesystemReadLease.ReadText(reverse)), metadata.Path), Path.Combine(workspace.Path, ".git"))
                || !Equal(Path.GetFullPath(Line(WindowsFilesystemReadLease.ReadText(commonPointer)), metadata.Path), common.Path))
                throw new InvalidOperationException("worktree structural pointers disagree");
            return pins;
        }
        catch { pins.Dispose(); throw; }
    }

    private WindowsFilesystemReadLease Directory(string path, string identity)
    {
        if (identity == null || !Regex.IsMatch(identity, "^win32-dir:[0-9a-f]{8}:[0-9a-f]{16}$"))
            throw new InvalidOperationException("exact native directory identity required");
        var value = WindowsFilesystemReadLease.Directory(path);
        retained.Add(value); // Every subsequent failure owns and closes this handle.
        if (value.Identity != identity || !string.Equals(value.Path, path, StringComparison.Ordinal))
            throw new InvalidOperationException("retained directory binding changed");
        return value;
    }

    private FileStream File(WindowsFilesystemReadLease directory, string leaf)
    {
        var value = directory.PinFile(leaf); retained.Add(value); return value;
    }

    public void Dispose()
    {
        lock (lifetime)
        {
            if (disposed) return;
            disposed = true;
            // Dispose every acquired handle even if one close reports an error.
            Exception failure = null;
            for (int i = retained.Count - 1; i >= 0; i--)
                try { retained[i].Dispose(); } catch (Exception error) { failure ??= error; }
            retained.Clear();
            if (failure != null) throw failure;
        }
    }

    private static bool Equal(string left, string right) => string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);
    private static bool Nested(string child, string parent) => child.StartsWith(parent + "\\", StringComparison.OrdinalIgnoreCase);
    private static string Line(string value)
    {
        string line = value.TrimEnd('\r', '\n');
        if (line.Length == 0 || line.IndexOfAny(new[] { '\r', '\n', '\0' }) >= 0) throw new InvalidOperationException("single structural pointer line required");
        return line;
    }
}
