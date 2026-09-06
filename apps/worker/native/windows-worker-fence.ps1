$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$fence = $null
try {
  $line = [Console]::ReadLine()
  if ($null -eq $line -or $line.Length -gt 8192) { throw 'Invalid launch fence frame' }
  $request = $line | ConvertFrom-Json -AsHashtable
  Add-Type -Path @((Join-Path $PSScriptRoot 'WindowsWorkerScope.cs'),
    (Join-Path $PSScriptRoot 'WindowsWorkerRecovery.cs'), (Join-Path $PSScriptRoot 'WindowsLaunchFence.cs'))
  $os = Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime -OperationTimeoutSec 3
  $actual = [Acp.Worker.WindowsWorkerScope]::Read($os.LastBootUpTime)
  if ($request.operation -eq 'describe') {
    $identity = [Acp.Worker.WindowsLaunchFence]::DirectoryIdentity($request.directory)
    [Console]::WriteLine((@{ directory = [IO.Path]::GetFullPath($request.directory).TrimEnd('\'); directoryIdentity = $identity;
      scope = @{ machineFingerprint = $actual.MachineFingerprint; bootedAt = $actual.BootedAt; sessionId = $actual.SessionId } } | ConvertTo-Json -Compress -Depth 5))
  } elseif ($request.operation -in @('seal', 'seal-provisioner')) {
    $expected = $request.fence
    $provisioner = $request.operation -eq 'seal-provisioner'
    if ($provisioner -and $expected.namespace -cne 'acp-worktree-provisioner-v1') { throw 'Invalid provisioner fence namespace' }
    $boot = ([DateTimeOffset]$expected.scope.bootedAt).ToUniversalTime().ToString('O')
    if ($expected.scope.machineFingerprint -cne $actual.MachineFingerprint -or
        ([DateTimeOffset]$boot) -ne ([DateTimeOffset]$actual.BootedAt) -or $expected.scope.sessionId -ne $actual.SessionId) { throw 'Launch scope mismatch' }
    $remaining = [Math]::Floor((([DateTimeOffset]$request.deadlineAt).UtcDateTime - [DateTime]::UtcNow).TotalMilliseconds)
    if ($remaining -le 0 -or $remaining -gt 15000) { throw 'Invalid fence deadline' }
    if ($provisioner) {
      $fence = [Acp.Worker.WindowsLaunchFence]::OpenProvisioner($expected.directory, $expected.directoryIdentity, $request.attemptId,
        $actual.MachineFingerprint, $boot, $actual.SessionId, [Math]::Min(1000, $remaining))
      $job = 'Local\ACP.Provisioner.' + $request.attemptId
    } else {
      $fence = [Acp.Worker.WindowsLaunchFence]::Open($expected.directory, $expected.directoryIdentity, $request.workerProcessId,
        $actual.MachineFingerprint, $boot, $actual.SessionId, [Math]::Min(1000, $remaining))
      $job = 'Local\ACP.Worker.' + $request.workerProcessId
    }
    $fence.Seal()
    if ($fence.ProcessId -gt 0) {
      $observation = [Acp.Worker.WindowsWorkerRecovery]::Stop($job, $fence.ProcessId, $fence.ProcessStartToken,
        $actual.MachineFingerprint, $boot, $actual.SessionId, $actual, [Math]::Min(5000, $remaining))
      $root = @{ processId = $fence.ProcessId; processStartToken = $fence.ProcessStartToken; startedAt = $fence.StartedAt }
    } else {
      $observation = [Acp.Worker.WindowsWorkerRecovery]::ObserveSealedUnjournaled($job)
      $root = $null
    }
    [Console]::WriteLine((@{ state = $observation.State; sealed = $true; reason = $observation.Reason;
      exitCode = $observation.ExitCode; root = $root } | ConvertTo-Json -Compress -Depth 5))
  } else { throw 'Unsupported launch fence operation' }
} catch {
  [Console]::WriteLine('{"state":"unconfirmed"}')
  exit 1
} finally { if ($null -ne $fence) { $fence.Dispose() } }
