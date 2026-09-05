using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Acp.Worker;

// Trusted local observation only. No Git writes, transport, credentials or leases.
public sealed class WindowsRepositoryObserver
{
    private readonly string executable;
    private readonly DateTime deadline;
    private readonly Action<int> report;
    public WindowsRepositoryObserver(string gitExecutable, DateTime deadlineUtc, Action<int> onSpawn)
    {
        WindowsFilesystemReadLease.ValidatePath(gitExecutable);
        if (!string.Equals(Path.GetFileName(gitExecutable), "git.exe", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("trusted absolute git.exe required");
        executable = gitExecutable; deadline = deadlineUtc.ToUniversalTime(); report = onSpawn;
        if (deadline <= DateTime.UtcNow || deadline > DateTime.UtcNow.AddSeconds(20)) throw new ArgumentException("bounded observation deadline required");
    }
    public string Repository(string checkoutPath, string machine)
    {
        using var checkout = WindowsFilesystemReadLease.Directory(checkoutPath);
        using var common = WindowsFilesystemReadLease.Directory(Path.Combine(checkout.Path, ".git"));
        using var head = common.PinFile("HEAD");
        using var configuration = common.PinFile("config");
        using var objectInfo = SupportedLayout(common,configuration);
        Topology(checkout, common, common);
        return JsonSerializer.Serialize(new { state = "confirmed", kind = "repository", machineFingerprint = machine,
            checkout = Binding(checkout), commonGitDirectory = Binding(common), observedAt = Now() });
    }
    public string Worktree(string checkoutPath, string checkoutIdentity, string commonPath, string commonIdentity,
        string workspacePath, string machine)
    {
        using var checkout = WindowsFilesystemReadLease.Directory(checkoutPath);
        using var common = WindowsFilesystemReadLease.Directory(commonPath);
        if (checkout.Identity != checkoutIdentity || common.Identity != commonIdentity || !Equal(common.Path, Path.Combine(checkout.Path, ".git"))) throw new InvalidOperationException("repository binding changed");
        using var configuration = common.PinFile("config");
        using var objectInfo = SupportedLayout(common,configuration);
        using var workspace = WindowsFilesystemReadLease.Directory(workspacePath);
        if (workspace.Identity == checkout.Identity || workspace.Identity == common.Identity
            || Nested(workspace.Path,checkout.Path) || Nested(checkout.Path,workspace.Path)) throw new InvalidOperationException("isolated workspace required");
        using var dotGit = workspace.PinFile(".git");
        string forward = Line(WindowsFilesystemReadLease.ReadText(dotGit));
        if (!forward.StartsWith("gitdir: ",StringComparison.Ordinal)) throw new InvalidOperationException("linked worktree pointer required");
        string metadataPath = Path.GetFullPath(forward.Substring(8),workspace.Path);
        string metadataParent = Path.Combine(common.Path,"worktrees");
        if (!Equal(Path.GetDirectoryName(metadataPath),metadataParent)) throw new InvalidOperationException("exact linked metadata required");
        using var metadata = WindowsFilesystemReadLease.Directory(metadataPath);
        metadata.RequireAbsent("config.worktree");
        using var reverse = metadata.PinFile("gitdir");
        using var commonPointer = metadata.PinFile("commondir");
        using var head = metadata.PinFile("HEAD");
        if (!Equal(Path.GetFullPath(Line(WindowsFilesystemReadLease.ReadText(reverse)),metadata.Path),Path.Combine(workspace.Path,".git"))
            || !Equal(Path.GetFullPath(Line(WindowsFilesystemReadLease.ReadText(commonPointer)),metadata.Path),common.Path)) throw new InvalidOperationException("worktree pointers disagree");
        string symbolicHead = Line(WindowsFilesystemReadLease.ReadText(head));
        if (!symbolicHead.StartsWith("ref: refs/heads/",StringComparison.Ordinal)) throw new InvalidOperationException("attached worktree HEAD required");
        string branch = symbolicHead.Substring(5);
        Topology(workspace,metadata,common);
        if (Git(workspace.Path,"symbolic-ref","--quiet","HEAD") != branch) throw new InvalidOperationException("symbolic HEAD changed");
        Git(workspace.Path,"check-ref-format",branch);
        string revision = Git(workspace.Path,"rev-parse","--verify","--end-of-options","HEAD^{commit}");
        if (!Regex.IsMatch(revision,"^[0-9a-f]{40}([0-9a-f]{24})?$")) throw new InvalidOperationException("full commit required");
        return JsonSerializer.Serialize(new { state = "confirmed", kind = "worktree", machineFingerprint = machine,
            workspace = Binding(workspace), gitDirectory = Binding(metadata), branchRef = branch, headRevision = revision, observedAt = Now() });
    }
    private void Topology(WindowsFilesystemReadLease workspace, WindowsFilesystemReadLease metadata, WindowsFilesystemReadLease common)
    {
        string[] lines = Git(workspace.Path,"rev-parse","--path-format=absolute","--show-toplevel","--git-dir","--git-common-dir").Split('\n');
        if (lines.Length != 3 || !Equal(lines[0],workspace.Path) || !Equal(lines[1],metadata.Path) || !Equal(lines[2],common.Path)) throw new InvalidOperationException("Git topology disagrees with native handles");
        using var reportedWorkspace = WindowsFilesystemReadLease.Directory(Path.GetFullPath(lines[0]));
        using var reportedMetadata = WindowsFilesystemReadLease.Directory(Path.GetFullPath(lines[1]));
        using var reportedCommon = WindowsFilesystemReadLease.Directory(Path.GetFullPath(lines[2]));
        if (reportedWorkspace.Identity != workspace.Identity || reportedMetadata.Identity != metadata.Identity || reportedCommon.Identity != common.Identity)
            throw new InvalidOperationException("Git topology native identities changed");
    }
    private static WindowsFilesystemReadLease SupportedLayout(WindowsFilesystemReadLease common,FileStream configuration)
    {
        // Intentionally narrow first layout. Parsing only an allowlist avoids
        // invoking Git to discover includes that Git itself might already follow.
        string section = "";
        var allowed = new Dictionary<string,string[]> {
            ["core"] = new[] { "repositoryformatversion","filemode","bare","logallrefupdates","ignorecase","precomposeunicode","symlinks","fsmonitor","hookspath" },
            ["extensions"] = new[] { "objectformat","partialclone" },
            ["remote"] = new[] { "url","fetch","promisor","partialclonefilter" },
            ["branch"] = new[] { "remote","merge" },
            ["user"] = new[] { "name","email" }
        };
        foreach (string raw in WindowsFilesystemReadLease.ReadText(configuration).Split('\n'))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("#") || line.StartsWith(";")) continue;
            var header = Regex.Match(line,"^\\[(core|extensions|remote|branch|user)(?: \"[^\"\\\\\\r\\n]+\")?\\]$",RegexOptions.IgnoreCase);
            if (header.Success) { section=header.Groups[1].Value.ToLowerInvariant(); continue; }
            var item = Regex.Match(line,"^([A-Za-z][A-Za-z0-9-]*)[ \\t]*=[ \\t]*(.*)$");
            if (!item.Success || !allowed.ContainsKey(section) || !allowed[section].Contains(item.Groups[1].Value.ToLowerInvariant())
                || line.EndsWith("\\",StringComparison.Ordinal)) throw new InvalidOperationException("unsupported repository configuration");
        }
        common.RequireAbsent("config.worktree");
        var info = WindowsFilesystemReadLease.Directory(Path.Combine(common.Path,"objects","info"));
        try { info.RequireAbsent("alternates"); info.RequireAbsent("http-alternates"); return info; }
        catch { info.Dispose(); throw; }
    }
    private string Git(string workspace, params string[] command)
    {
        if (DateTime.UtcNow >= deadline) throw new TimeoutException();
        var args = new[] { "--no-pager", "--no-optional-locks", "--no-replace-objects", "--no-lazy-fetch",
            "-c", "core.fsmonitor=false", "-c", "core.hooksPath=NUL", "-C", workspace }.Concat(command).ToArray();
        var env = new List<string>();
        foreach (string key in new[] { "SystemRoot", "WINDIR", "TEMP", "TMP" })
        { string value = Environment.GetEnvironmentVariable(key); if (value != null) env.Add(key+"="+value); }
        env.AddRange(new[] { "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=NUL", "GIT_CONFIG_SYSTEM=NUL", "GIT_CONFIG_COUNT=0",
            "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "GIT_NO_LAZY_FETCH=1", "GIT_NO_REPLACE_OBJECTS=1", "GIT_ATTR_NOSYSTEM=1" });
        using var job = WindowsWorkerJob.Create("Local\\ACP.GitObserve."+Guid.NewGuid().ToString("D"), executable,args,workspace,env.ToArray(),deadline);
        report?.Invoke(job.ProcessId);
        Task<byte[]> output = ReadBounded(job.Output), error = ReadBounded(job.Error);
        try
        {
            job.Input.Dispose(); job.Resume();
            while (!job.RootExited)
            {
                if (DateTime.UtcNow >= deadline || output.IsFaulted || error.IsFaulted) throw new InvalidOperationException("Git observation unavailable");
                Thread.Sleep(5);
            }
            int exit = job.ExitCode;
            // A completed root is insufficient: close and confirm all descendants.
            if (!job.TerminateAndWait(2000)) throw new InvalidOperationException("Git tree cleanup unconfirmed");
            if (!Task.WaitAll(new Task[] { output,error },2000)) throw new TimeoutException("Git pipe cleanup unconfirmed");
            if (exit != 0) throw new InvalidOperationException("Git read failed");
            return new UTF8Encoding(false,true).GetString(output.Result).TrimEnd('\r','\n');
        }
        finally
        {
            if (!job.TerminateAndWait(2000)) throw new InvalidOperationException("Git tree cleanup unconfirmed");
        }
    }
    private static async Task<byte[]> ReadBounded(Stream stream)
    {
        using var output = new MemoryStream(); byte[] buffer = new byte[4096]; int count;
        while ((count = await stream.ReadAsync(buffer,0,buffer.Length)) > 0)
        { if (output.Length + count > 16384) throw new InvalidOperationException("Git output exceeded bound"); output.Write(buffer,0,count); }
        return output.ToArray();
    }
    private static object Binding(WindowsFilesystemReadLease lease) => new { path = lease.Path, identity = lease.Identity };
    private static bool Equal(string left,string right) => string.Equals(Path.GetFullPath(left),Path.GetFullPath(right),StringComparison.OrdinalIgnoreCase);
    private static bool Nested(string child,string parent) => child.StartsWith(parent+"\\",StringComparison.OrdinalIgnoreCase);
    private static string Now() => DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ");
    private static string Line(string value)
    {
        string line = value.TrimEnd('\r','\n');
        if (line.Length == 0 || line.IndexOfAny(new[] { '\r','\n','\0' }) >= 0) throw new InvalidOperationException("single metadata line required");
        return line;
    }
}
