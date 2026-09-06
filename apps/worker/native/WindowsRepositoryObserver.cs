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
        => JsonSerializer.Serialize(WorktreeObservation(checkoutPath,checkoutIdentity,commonPath,commonIdentity,workspacePath,machine,false,null));

    public string StoppedProvisionerWorktree(string checkoutPath, string checkoutIdentity, string commonPath, string commonIdentity,
        string workspacePath, string parentPath, string parentIdentity, string machine)
    {
        WindowsFilesystemReadLease.ValidatePath(workspacePath);
        using var parent = WindowsFilesystemReadLease.Directory(parentPath);
        if (parent.Path != parentPath || parent.Identity != parentIdentity || Path.GetDirectoryName(workspacePath) != parent.Path)
            throw new InvalidOperationException("original provisioner parent changed");
        return JsonSerializer.Serialize(WorktreeObservation(checkoutPath,checkoutIdentity,commonPath,commonIdentity,workspacePath,machine,true,parent));
    }

    private object WorktreeObservation(string checkoutPath, string checkoutIdentity, string commonPath, string commonIdentity,
        string workspacePath, string machine, bool strict, WindowsFilesystemReadLease parent)
    {
        using var checkout = WindowsFilesystemReadLease.Directory(checkoutPath);
        using var common = WindowsFilesystemReadLease.Directory(commonPath);
        if (checkout.Identity != checkoutIdentity || common.Identity != commonIdentity || !SamePath(common.Path,Path.Combine(checkout.Path,".git"),strict)
            || (strict && (checkout.Path != checkoutPath || common.Path != commonPath || parent.Identity == checkout.Identity || parent.Identity == common.Identity)))
            throw new InvalidOperationException("repository binding changed");
        using var configuration = common.PinFile("config");
        using var objectInfo = SupportedLayout(common,configuration);
        using var workspace = WindowsFilesystemReadLease.Directory(workspacePath);
        if (workspace.Identity == checkout.Identity || workspace.Identity == common.Identity
            || Nested(workspace.Path,checkout.Path) || Nested(checkout.Path,workspace.Path)
            || (strict && (workspace.Path != workspacePath || workspace.Identity == parent.Identity))) throw new InvalidOperationException("isolated workspace required");
        using var dotGit = workspace.PinFile(".git");
        string forward = Line(WindowsFilesystemReadLease.ReadText(dotGit));
        if (!forward.StartsWith("gitdir: ",StringComparison.Ordinal)) throw new InvalidOperationException("linked worktree pointer required");
        string metadataPath = Path.GetFullPath(forward.Substring(8),workspace.Path);
        string metadataParent = Path.Combine(common.Path,"worktrees");
        if (!SamePath(Path.GetDirectoryName(metadataPath),metadataParent,strict)) throw new InvalidOperationException("exact linked metadata required");
        using var metadata = WindowsFilesystemReadLease.Directory(metadataPath);
        if (strict && (metadata.Path != metadataPath || new[] {checkout.Identity,common.Identity,parent.Identity,workspace.Identity}.Contains(metadata.Identity)))
            throw new InvalidOperationException("exact distinct worktree metadata required");
        metadata.RequireAbsent("config.worktree");
        using var reverse = metadata.PinFile("gitdir");
        using var commonPointer = metadata.PinFile("commondir");
        using var head = metadata.PinFile("HEAD");
        if (!SamePath(Path.GetFullPath(Line(WindowsFilesystemReadLease.ReadText(reverse)),metadata.Path),Path.Combine(workspace.Path,".git"),strict)
            || !SamePath(Path.GetFullPath(Line(WindowsFilesystemReadLease.ReadText(commonPointer)),metadata.Path),common.Path,strict)) throw new InvalidOperationException("worktree pointers disagree");
        string symbolicHead = Line(WindowsFilesystemReadLease.ReadText(head));
        if (!symbolicHead.StartsWith("ref: refs/heads/",StringComparison.Ordinal)) throw new InvalidOperationException("attached worktree HEAD required");
        string branch = symbolicHead.Substring(5);
        Topology(workspace,metadata,common,strict,strict);
        if (GitOutput(workspace.Path,strict,new[] {"symbolic-ref","--quiet","HEAD"}) != branch) throw new InvalidOperationException("symbolic HEAD changed");
        string format = GitOutput(workspace.Path,strict,new[] {"check-ref-format",branch});
        if (strict && format != "") throw new InvalidOperationException("unexpected ref validation output");
        string revision = GitOutput(workspace.Path,strict,new[] {"rev-parse","--verify","--end-of-options","HEAD^{commit}"});
        if (!Regex.IsMatch(revision,"^[0-9a-f]{40}([0-9a-f]{24})?$")) throw new InvalidOperationException("full commit required");
        if (strict) {
            ValidateBranch(branch);
            if (DateTime.UtcNow >= deadline) throw new TimeoutException();
            return new { state = "observed", kind = "provisioner_worktree", scope = "observation_only", machineFingerprint = machine,
                checkout = Binding(checkout), commonGitDirectory = Binding(common), parent = Binding(parent),
                workspace = Binding(workspace), gitDirectory = Binding(metadata), branchRef = branch, headRevision = revision, observedAt = Now() };
        }
        return new { state = "confirmed", kind = "worktree", machineFingerprint = machine,
            workspace = Binding(workspace), gitDirectory = Binding(metadata), branchRef = branch, headRevision = revision, observedAt = Now() };
    }
    // Sequential first-discovery facts only. These handles are all released
    // before the caller receives an observation; this grants no Git authority.
    public string ProvisionerTarget(string checkoutPath, string checkoutIdentity, string commonPath, string commonIdentity,
        string workspacePath, string branchRef, string baseRevision, string machine)
    {
        WindowsFilesystemReadLease.ValidatePath(workspacePath);
        string parentPath = Path.GetDirectoryName(workspacePath);
        WindowsFilesystemReadLease.ValidatePath(parentPath);
        ValidateBranch(branchRef);
        if (baseRevision == null || !Regex.IsMatch(baseRevision,@"\A[0-9a-f]{40}([0-9a-f]{24})?\z")) throw new ArgumentException("full exact commit required");
        using var checkout = WindowsFilesystemReadLease.Directory(checkoutPath);
        using var common = WindowsFilesystemReadLease.Directory(commonPath);
        if (checkout.Identity != checkoutIdentity || common.Identity != commonIdentity || checkout.Identity == common.Identity
            || checkout.Path != checkoutPath || common.Path != commonPath || common.Path != Path.Combine(checkout.Path,".git")
            || Equal(workspacePath,checkout.Path) || Nested(workspacePath,checkout.Path) || Nested(checkout.Path,workspacePath)
            || Equal(workspacePath,common.Path) || Nested(workspacePath,common.Path) || Nested(common.Path,workspacePath)) throw new InvalidOperationException("isolated exact repository binding required");
        using var head = common.PinFile("HEAD");
        using var configuration = common.PinFile("config");
        using var objectInfo = SupportedLayout(common,configuration);
        using var parent = WindowsFilesystemReadLease.Directory(parentPath);
        if (parent.Path != parentPath || parent.Identity == checkout.Identity || parent.Identity == common.Identity) throw new InvalidOperationException("canonical separate parent required");
        using var packed = common.PinFileOrAbsent("packed-refs",16384);
        var prefixes = new List<WindowsFilesystemReadLease>();
        try
        {
            parent.RequireAbsent(Path.GetFileName(workspacePath));
            Topology(checkout,common,common,true);
            if (GitStrict(checkout.Path,"check-ref-format",branchRef) != "") throw new InvalidOperationException("unexpected ref-format output");
            ObserveAbsentBranch(checkout,common,branchRef,prefixes);
            if (GitStrict(checkout.Path,"rev-parse","--verify","--end-of-options",baseRevision+"^{commit}") != baseRevision)
                throw new InvalidOperationException("base is not the exact existing commit object");
            ObserveAbsentBranch(checkout,common,branchRef,prefixes);
            if (packed == null) common.RequireAbsent("packed-refs");
            parent.RequireAbsent(Path.GetFileName(workspacePath));
            if (DateTime.UtcNow >= deadline) throw new TimeoutException();
            return JsonSerializer.Serialize(new { state = "observed", kind = "provisioner_target", scope = "observation_only", machineFingerprint = machine,
                checkout = Binding(checkout), commonGitDirectory = Binding(common), parent = Binding(parent), workspacePath, branchRef, baseRevision,
                targetAbsent = true, branchAbsent = true, observedAt = Now() });
        }
        finally { for (int i=prefixes.Count-1;i>=0;i--) prefixes[i].Dispose(); }
    }
    private void ObserveAbsentBranch(WindowsFilesystemReadLease checkout, WindowsFilesystemReadLease common, string branch, List<WindowsFilesystemReadLease> pins)
    {
        string output = GitStrict(checkout.Path,"for-each-ref","--count=201","--sort=refname","--format=%(refname)","refs/heads/");
        string[] refs = output.Length == 0 ? Array.Empty<string>() : output.Split('\n');
        if (refs.Length > 200 || refs.Distinct(StringComparer.Ordinal).Count() != refs.Length) throw new InvalidOperationException("bounded distinct head inventory required");
        foreach (string existing in refs)
        {
            ValidateBranch(existing);
            string[] left = branch.Split('/'), right = existing.Split('/');
            int i=0;
            for (;i<Math.Min(left.Length,right.Length);i++)
            {
                if (!string.Equals(left[i],right[i],StringComparison.OrdinalIgnoreCase)) break;
                if (left[i] != right[i]) throw new InvalidOperationException("branch component case collision");
            }
            if (i == Math.Min(left.Length,right.Length)) throw new InvalidOperationException("branch already exists or has a prefix collision");
        }
        // Enumeration can omit malformed/dangling loose refs. Walk actual
        // native components too, pinning every existing prefix until return.
        string[] parts = branch.Split('/'); var directory = common;
        for (int i=0;i<parts.Length-1;i++)
        {
            var child = directory.DirectoryChildOrAbsent(parts[i]);
            if (child == null) return;
            pins.Add(child);
            if (child.Path != Path.Combine(directory.Path,parts[i])) throw new InvalidOperationException("loose branch spelling is not ordinal canonical");
            directory = child;
        }
        directory.RequireAbsent(parts[parts.Length-1]);
    }
    private static void ValidateBranch(string branch)
    {
        if (branch == null || !branch.StartsWith("refs/heads/",StringComparison.Ordinal) || branch.Length > 1024
            || Regex.IsMatch(branch,@"[\x00-\x20\x7f~^:?*\[\\]") || branch.Contains("..") || branch.Contains("@{")) throw new ArgumentException("bounded exact branch required");
        string[] parts = branch.Substring(11).Split('/');
        if (parts.Length > 16 || parts.Any(part => part.Length == 0 || part.StartsWith(".",StringComparison.Ordinal) || part.EndsWith(".lock",StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("unsupported branch components");
        WindowsFilesystemReadLease.ValidatePath("C:\\"+string.Join("\\",parts));
    }
    private void Topology(WindowsFilesystemReadLease workspace, WindowsFilesystemReadLease metadata, WindowsFilesystemReadLease common, bool strict = false, bool ordinal = false)
    {
        string[] lines = GitOutput(workspace.Path,strict,new[] { "rev-parse","--path-format=absolute","--show-toplevel","--git-dir","--git-common-dir" }).Split('\n');
        if (lines.Length != 3 || !SamePath(lines[0],workspace.Path,ordinal) || !SamePath(lines[1],metadata.Path,ordinal) || !SamePath(lines[2],common.Path,ordinal)) throw new InvalidOperationException("Git topology disagrees with native handles");
        using var reportedWorkspace = WindowsFilesystemReadLease.Directory(Path.GetFullPath(lines[0]));
        using var reportedMetadata = WindowsFilesystemReadLease.Directory(Path.GetFullPath(lines[1]));
        using var reportedCommon = WindowsFilesystemReadLease.Directory(Path.GetFullPath(lines[2]));
        if (reportedWorkspace.Identity != workspace.Identity || reportedMetadata.Identity != metadata.Identity || reportedCommon.Identity != common.Identity)
            throw new InvalidOperationException("Git topology native identities changed");
    }
    private static bool SamePath(string left, string right, bool ordinal) => ordinal
        ? string.Equals(Path.GetFullPath(left),Path.GetFullPath(right),StringComparison.Ordinal) : Equal(left,right);
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
        => GitOutput(workspace,false,command);
    private string GitStrict(string workspace, params string[] command)
        => GitOutput(workspace,true,command);
    private string GitOutput(string workspace, bool strict, string[] command)
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
            if (exit != 0 || (strict && error.Result.Length != 0)) throw new InvalidOperationException("Git read failed or warned");
            string text = new UTF8Encoding(false,true).GetString(output.Result);
            if (!strict) return text.TrimEnd('\r','\n');
            text = text.Replace("\r\n","\n");
            if (text.IndexOfAny(new[] { '\r','\0' }) >= 0) throw new InvalidOperationException("invalid Git output");
            return text.EndsWith("\n",StringComparison.Ordinal) ? text.Substring(0,text.Length-1) : text;
        }
        finally
        {
            // A deadline or faulted bounded reader skips the normal exit path.
            // Even a thrown stop call must attempt bounded reader settlement.
            try
            {
                if (!job.TerminateAndWait(2000)) throw new InvalidOperationException("Git tree cleanup unconfirmed");
            }
            finally
            {
                var readers = Task.WhenAll(output,error);
                bool settled;
                try { settled = readers.Wait(2000); }
                catch (AggregateException) { settled = readers.IsCompleted; }
                if (!settled) throw new InvalidOperationException("Git pipe cleanup unconfirmed");
                if (readers.IsFaulted || readers.IsCanceled) throw new InvalidOperationException("Git pipe observation failed");
            }
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
