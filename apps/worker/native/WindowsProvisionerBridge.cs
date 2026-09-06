using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Acp.Worker;

// Private transport only. The trusted parent selects the original plan and
// fixed command; no worker/model receives these pipes or database authority.
// Native validation binds the ACK to this owner, but cannot authenticate a DB.
// Run is for the dedicated exiting bridge process only. A `closed` frame is
// provisional: the parent must ALSO await process/pipe closure before settling
// a native session, since disposal/exit settles remaining private I/O tasks.
public sealed class WindowsProvisionerBridge
{
    private readonly WindowsWorkerScope scope;
    private readonly BoundedReader reader = new BoundedReader(Console.OpenStandardInput());
    private WindowsWorkerJob job;
    private WindowsLaunchFence heldFence;
    private WindowsProvisionerBindingPins bindingPins;
    private readonly Action<string, string> observe;
    private static readonly List<WindowsProvisionerBindingPins> retainedUntilExit = new List<WindowsProvisionerBindingPins>();
    private string commonGitPath;
    private bool creationAttempted, treeEmptyConfirmed, stopSealed;
    private JsonElement plan, owner, fence, request;
    private string attemptId, directory, directoryIdentity, input;
    private long revision;
    private int maximumOutputBytes, outputBytes;
    private bool accepted, goConsumed, reported;

    private WindowsProvisionerBridge(WindowsWorkerScope scope, Action<string, string> observe) { this.scope = scope; this.observe = observe; }
    public static Task<int> Run(WindowsWorkerScope scope) => RunObserved(scope, null);
    // Same-assembly fixture observation only. No IPC field or public launch
    // option can select this hook; ordinary hosts always call Run above.
    internal static async Task<int> RunObserved(WindowsWorkerScope scope, Action<string, string> observe)
    {
        var bridge = new WindowsProvisionerBridge(scope, observe);
        try { await bridge.Execute(); return 0; }
        catch
        {
            // A protocol/native error may still yield exact physical closure,
            // but never an invented exit code or an unsealed stop receipt.
            try { bridge.StopAndSeal(true); }
            catch { if (!bridge.reported) Send(new { type = "unconfirmed" }); }
            return 1;
        }
        finally
        {
            bridge.Cleanup();
        }
    }

    private async Task Execute()
    {
        JsonElement launch = Parse(await reader.ReadLine());
        Exact(launch, "attemptId", "expectedPlan", "owner", "fencePlan", "machineFingerprint", "command", "bindings");
        attemptId = Id(launch, "attemptId", "wpa_");
        plan = launch.GetProperty("expectedPlan"); owner = launch.GetProperty("owner");
        Exact(plan, "reservationId", "reservationRevision", "deadlineAt", "provenanceId");
        Id(plan, "reservationId", "wtr_"); Id(plan, "provenanceId", "prv_");
        revision = Integer(plan, "reservationRevision", 1, int.MaxValue);
        DateTime deadline = Timestamp(plan, "deadlineAt");
        if (deadline <= DateTime.UtcNow || deadline > DateTime.UtcNow.AddSeconds(20)) throw new InvalidDataException("original deadline denied");
        Exact(owner, "hostIdentifier", "sessionId", "applicationVersion");
        Text(owner, "hostIdentifier"); Id(owner, "sessionId", "whs_"); Text(owner, "applicationVersion");
        if (Text(launch, "machineFingerprint") != scope.MachineFingerprint) throw new InvalidDataException("original machine denied");
        JsonElement intended = launch.GetProperty("fencePlan"); Exact(intended, "namespace", "directory");
        if (Text(intended, "namespace") != "acp-worktree-provisioner-v1") throw new InvalidDataException("fence namespace denied");
        directory = Text(intended, "directory");
        JsonElement command = launch.GetProperty("command");
        Exact(command, "executable", "arguments", "workspace", "environment", "input", "maximumOutputBytes");
        string executable = Text(command, "executable"), workspace = Text(command, "workspace");
        if (!Path.IsPathFullyQualified(executable) || !File.Exists(executable) || !Path.IsPathFullyQualified(workspace) || !Directory.Exists(workspace))
            throw new InvalidDataException("trusted command paths unavailable");
        string[] arguments = Strings(command.GetProperty("arguments"), 16), environment = Strings(command.GetProperty("environment"), 64);
        input = Text(command, "input", true);
        maximumOutputBytes = checked((int)Integer(command, "maximumOutputBytes", 1, 1048576));
        JsonElement bindings = launch.GetProperty("bindings"); Exact(bindings, "workspacePath", "reportedParent", "commonGitDirectory");
        JsonElement parent = bindings.GetProperty("reportedParent"), common = bindings.GetProperty("commonGitDirectory");
        Exact(parent, "path", "identity"); Exact(common, "path", "identity");
        string parentPath = Text(parent, "path"); commonGitPath = Text(common, "path");
        if (!string.Equals(workspace, parentPath, StringComparison.Ordinal)) throw new InvalidDataException("command workspace differs from original parent");
        bindingPins = WindowsProvisionerBindingPins.Open(scope, Text(launch, "machineFingerprint"), Text(bindings, "workspacePath"),
            parentPath, Text(parent, "identity"), commonGitPath, Text(common, "identity"));
        directoryIdentity = WindowsLaunchFence.DirectoryIdentity(directory);
        fence = Element(new { @namespace = "acp-worktree-provisioner-v1", directory, directoryIdentity,
            scope = new { machineFingerprint = scope.MachineFingerprint, bootedAt = scope.BootedAt, sessionId = scope.SessionId } });
        heldFence = OpenFence(); heldFence.Begin(); // Durable consumption precedes CreateProcess.
        // Factory failure may occur after partial creation; job == null is not
        // proof that no native root existed or that kill-on-close has finished.
        creationAttempted = true;
        job = WindowsWorkerJob.CreateWithProvisionerAdmission("Local\\ACP.Provisioner." + attemptId,
            executable, arguments, workspace, environment, deadline, attemptId, revision);
        heldFence.RecordRoot(job.ProcessId, job.ProcessStartToken, job.StartedAt);
        heldFence.Dispose(); heldFence = null;
        WindowsProvisionerAdmissionChallenge challenge = job.BeginProvisionerAdmissionChallenge();
        request = Element(new { attemptId, fence, root = Root(), challenge = new { nonce = challenge.Nonce, epoch = challenge.Epoch } });
        Send(new { type = "ready", request });

        Task<string> control = reader.ReadLine();
        byte[] buffer = new byte[8192], errorBuffer = new byte[8192];
        Task<int> output = job.Output.ReadAsync(buffer, 0, buffer.Length), errors = job.Error.ReadAsync(errorBuffer, 0, errorBuffer.Length);
        Task delivery = null; long errorBytes = 0; bool stopRequested = false;
        while (true)
        {
            if (control.IsCompleted)
            {
                string line = await control;
                if (line == null) { stopRequested = true; break; }
                JsonElement frame = Parse(line);
                string type = Text(frame, "type");
                if (type == "stop") { Exact(frame, "type"); stopRequested = true; break; }
                if (type == "admit")
                {
                    Exact(frame, "type", "acknowledgement");
                    if (accepted || goConsumed) throw new InvalidDataException("admission already consumed");
                    Accept(frame.GetProperty("acknowledgement")); accepted = true;
                    Send(new { type = "accepted", acceptance = new { attemptId, fence, root = Root(),
                        challenge = request.GetProperty("challenge"), reservationRevision = revision } });
                }
                else if (type == "go")
                {
                    Exact(frame, "type");
                    if (!accepted || goConsumed) throw new InvalidDataException("GO denied");
                    goConsumed = true;
                    heldFence = OpenFence(); heldFence.RequireRoot(job.ProcessId, job.ProcessStartToken);
                    try { job.GoProvisioner(); }
                    finally { heldFence.Dispose(); heldFence = null; }
                    delivery = job.BeginInput(Encoding.UTF8.GetBytes(input + "\n"));
                }
                else throw new InvalidDataException("private transition denied");
                control = reader.ReadLine();
            }
            if (job.DeadlineExpired || job.RootExited) break;
            if (delivery != null && delivery.IsCompleted) { await delivery; delivery = null; }
            if (output.IsCompleted)
            {
                int count = await output;
                if (count > 0) { Output(buffer, count); output = job.Output.ReadAsync(buffer, 0, buffer.Length); }
            }
            if (errors.IsCompleted)
            {
                int count = await errors;
                if (count > 0)
                {
                    errorBytes += count; if (errorBytes > 65536) throw new InvalidDataException("private stderr bound exceeded");
                    errors = job.Error.ReadAsync(errorBuffer, 0, errorBuffer.Length);
                }
            }
            await Task.Delay(10);
        }
        if (!job.TerminateAndWait(5000)) throw new InvalidOperationException("tree closure unconfirmed");
        treeEmptyConfirmed = true;
        // Stop all inherited writers before draining buffered stdout. The same
        // native watchdog bounds a blocked reader/output sink independently.
        while (true)
        {
            int count = await output; if (count == 0) break;
            Output(buffer, count); output = job.Output.ReadAsync(buffer, 0, buffer.Length);
        }
        StopAndSeal(stopRequested || job.DeadlineExpired || !goConsumed);
    }

    private void Accept(JsonElement ack)
    {
        Exact(ack, "attemptId", "fence", "root", "challenge", "fresh", "hostIdentifier", "ownerSessionId", "applicationVersion",
            "provenanceId", "treeIdentifier", "rootClaimOwnerId", "reservationId", "reservationRevision", "deadlineAt", "admittedAt", "durationMilliseconds");
        foreach (string name in new[] { "attemptId", "fence", "root", "challenge" }) Same(request.GetProperty(name), ack.GetProperty(name));
        if (ack.GetProperty("fresh").ValueKind != JsonValueKind.True || Text(ack, "hostIdentifier") != Text(owner, "hostIdentifier")
            || Text(ack, "ownerSessionId") != Text(owner, "sessionId") || Text(ack, "applicationVersion") != Text(owner, "applicationVersion")
            || Text(ack, "rootClaimOwnerId") != attemptId || Text(ack, "treeIdentifier") != "Local\\ACP.Provisioner." + attemptId)
            throw new InvalidDataException("fresh original owner denied");
        foreach (string name in new[] { "reservationId", "reservationRevision", "deadlineAt", "provenanceId" }) Same(plan.GetProperty(name), ack.GetProperty(name));
        long duration = Integer(ack, "durationMilliseconds", 251, 20000);
        DateTime deadline = Timestamp(ack, "deadlineAt"), admitted = Timestamp(ack, "admittedAt");
        if (admitted >= deadline || (deadline.Ticks - admitted.Ticks) / TimeSpan.TicksPerMillisecond != duration)
            throw new InvalidDataException("exact acknowledgement duration denied");
        JsonElement challenge = request.GetProperty("challenge");
        job.AcceptProvisionerAdmissionChallenge(Text(challenge, "nonce"), Integer(challenge, "epoch", 1, 1), attemptId, revision, duration);
    }
    private WindowsLaunchFence OpenFence() => WindowsLaunchFence.OpenProvisioner(directory, directoryIdentity, attemptId,
        scope.MachineFingerprint, scope.BootedAt, scope.SessionId, 1000);
    private object Root() => new { processId = job.ProcessId, processStartToken = job.ProcessStartToken, startedAt = job.StartedAt };
    private void StopAndSeal(bool failed)
    {
        if (reported) return;
        if (job == null || !job.TerminateAndWait(5000)) throw new InvalidOperationException("owned rooted closure unavailable");
        treeEmptyConfirmed = true; Observe("tree-empty-before-seal");
        heldFence?.Dispose(); heldFence = null;
        using (var seal = OpenFence())
        {
            if (seal.ProcessId != job.ProcessId || seal.ProcessStartToken != job.ProcessStartToken || seal.StartedAt != job.StartedAt)
                throw new InvalidOperationException("stopped root differs from permanent fence");
            seal.Seal();
            stopSealed = true; Observe("sealed");
        }
        int exitCode = job.ExitCode; // Actual held root, never a generic 137 substitution.
        // This provisional frame is usable only together with bridge-process
        // closure. Pending control/input/stderr tasks must not outlive a session.
        // Failure/authority loss is separate from valid physical stop evidence.
        // The parent must fence controller authority without discarding this stop.
        Send(new { type = "closed", failed, stop = new { attemptId, fence, observation = new { state = "terminated", @sealed = true,
            reason = "exact_owned_tree_terminated", root = Root(), exitCode } } });
        reported = true;
    }
    private void Cleanup()
    {
        Exception failure = null;
        void DisposeOne(IDisposable value) { try { value?.Dispose(); } catch (Exception error) { failure ??= error; } }
        DisposeOne(heldFence); DisposeOne(job);
        if (bindingPins != null)
        {
            if (!creationAttempted || (treeEmptyConfirmed && stopSealed))
            {
                try { bindingPins.Dispose(); Observe("pins-released"); }
                catch (Exception error) { failure ??= error; }
            }
            else
            {
                // Dedicated process exits after Run. Strong retention prevents
                // GC from releasing pins first on unconfirmed factory/stop/seal
                // paths. OS teardown still provides no relative handle ordering.
                lock (retainedUntilExit) retainedUntilExit.Add(bindingPins);
                Observe("pins-retained-until-exit");
            }
        }
        DisposeOne(reader);
        if (failure != null) throw failure;
    }
    private void Observe(string stage) { try { observe?.Invoke(stage, commonGitPath); } catch { /* Observation cannot change authority or cleanup. */ } }
    private void Output(byte[] bytes, int count)
    {
        outputBytes = checked(outputBytes + count);
        if (outputBytes > maximumOutputBytes) throw new InvalidDataException("private stdout bound exceeded");
        Send(new { type = "output", data = Convert.ToBase64String(bytes, 0, count) });
    }
    private static void Send(object value) { Console.Out.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush(); }
    private static JsonElement Element(object value) => JsonSerializer.SerializeToElement(value);
    private static JsonElement Parse(string text)
    {
        if (text == null) throw new InvalidDataException("private frame missing");
        using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 12 });
        return document.RootElement.Clone();
    }
    private static void Exact(JsonElement value, params string[] names)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new InvalidDataException("exact private object required");
        var expected = new HashSet<string>(names, StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject()) if (!expected.Remove(property.Name)) throw new InvalidDataException("unknown or duplicate private field");
        if (expected.Count != 0) throw new InvalidDataException("missing private field");
    }
    private static string Text(JsonElement value, string name, bool emptyAllowed = false)
    {
        string text = value.GetProperty(name).GetString();
        if (text == null || text.IndexOf('\0') >= 0 || (!emptyAllowed && string.IsNullOrWhiteSpace(text))) throw new InvalidDataException("private text denied");
        return text;
    }
    private static string Id(JsonElement value, string name, string prefix)
    {
        string text = Text(value, name);
        if (!Regex.IsMatch(text, "^" + prefix + @"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z"))
            throw new InvalidDataException("canonical private identity required");
        return text;
    }
    private static long Integer(JsonElement value, string name, long min, long max)
    {
        if (!value.GetProperty(name).TryGetInt64(out long number) || number < min || number > max) throw new InvalidDataException("private integer denied");
        return number;
    }
    private static DateTime Timestamp(JsonElement value, string name)
    {
        string text = Text(value, name);
        if (!DateTime.TryParseExact(text, "yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'", CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out DateTime time)) throw new InvalidDataException("canonical UTC6 required");
        return time;
    }
    private static string[] Strings(JsonElement value, int maximum)
    {
        if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() > maximum) throw new InvalidDataException("bounded private string array required");
        var result = new List<string>();
        foreach (JsonElement item in value.EnumerateArray())
        {
            string text = item.GetString(); if (text == null || text.IndexOf('\0') >= 0) throw new InvalidDataException("private array text denied");
            result.Add(text);
        }
        return result.ToArray();
    }
    private static void Same(JsonElement expected, JsonElement actual)
    {
        if (expected.ValueKind != actual.ValueKind) throw new InvalidDataException("private identity kind mismatch");
        if (expected.ValueKind == JsonValueKind.Object)
        {
            var names = new List<string>(); foreach (JsonProperty property in expected.EnumerateObject()) names.Add(property.Name);
            Exact(actual, names.ToArray());
            foreach (string name in names) Same(expected.GetProperty(name), actual.GetProperty(name));
        }
        else if (expected.ValueKind == JsonValueKind.String)
        { if (expected.GetString() != actual.GetString()) throw new InvalidDataException("private identity mismatch"); }
        else if (expected.ValueKind == JsonValueKind.Number)
        { if (!expected.TryGetInt64(out long left) || !actual.TryGetInt64(out long right) || left != right) throw new InvalidDataException("private integer identity mismatch"); }
        else throw new InvalidDataException("unsupported private identity");
    }

    private sealed class BoundedReader : IDisposable
    {
        private readonly StreamReader stream;
        private readonly char[] buffer = new char[2048];
        private int position, length;
        private bool reading;
        public BoundedReader(Stream input) { stream = new StreamReader(input, new UTF8Encoding(false, true), false); }
        public async Task<string> ReadLine()
        {
            if (reading) throw new InvalidOperationException("overlapping private read");
            reading = true;
            try
            {
                var line = new StringBuilder();
                while (true)
                {
                    if (position == length) { length = await stream.ReadAsync(buffer, 0, buffer.Length); position = 0; }
                    if (length == 0)
                    {
                        if (line.Length != 0) throw new InvalidDataException("partial private frame");
                        return null;
                    }
                    char character = buffer[position++];
                    if (character == '\n') return line.ToString();
                    if (line.Length >= 16384) throw new InvalidDataException("private frame too large");
                    line.Append(character);
                }
            }
            finally { reading = false; }
        }
        public void Dispose() { stream.Dispose(); }
    }
}
