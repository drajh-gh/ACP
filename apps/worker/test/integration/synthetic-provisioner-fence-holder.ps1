$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$nativeRoot = Join-Path $PSScriptRoot '../../native'
Add-Type -Path @((Join-Path $nativeRoot 'WindowsLaunchFence.cs'), (Join-Path $nativeRoot 'WindowsWorkerJob.cs'))
$line = [Console]::ReadLine()
if ($null -eq $line -or $line.Length -gt 8192) { throw 'Invalid fixture frame' }
$request = $line | ConvertFrom-Json -AsHashtable
$fence = $null
$worker = $null
try {
  $expected = $request.fence
  $boot = ([DateTimeOffset]$expected.scope.bootedAt).ToUniversalTime().ToString('O')
  $fence = [Acp.Worker.WindowsLaunchFence]::OpenProvisioner($expected.directory, $expected.directoryIdentity, $request.attemptId,
    $expected.scope.machineFingerprint, $boot, $expected.scope.sessionId, 500)
  if ($request.operation -eq 'seal-only') {
    $fence.Seal()
    [Console]::WriteLine('{"ready":true}')
    return
  }
  $fence.Begin()
  if ($request.operation -eq 'claim-only') {
    [Console]::WriteLine('{"ready":true}')
    return
  }
  if ($request.operation -notin @('hold-root', 'hold-tree', 'hold-before-record', 'hold-unrecorded')) { throw 'Invalid fixture operation' }
  # This test-only creation consumes no database plan and never runs a provisioner or Git.
  $worker = [Acp.Worker.WindowsWorkerJob]::Create(('Local\ACP.Provisioner.' + $request.attemptId),
    $request.executable, [string[]]$request.arguments, $request.workspace, [string[]]$request.environment,
    ([DateTimeOffset]$request.deadlineAt).UtcDateTime)
  if ($request.operation -notin @('hold-before-record', 'hold-unrecorded')) {
    $fence.RecordRoot($worker.ProcessId, $worker.ProcessStartToken, $worker.StartedAt)
  }
  $childId = $null
  if ($request.operation -eq 'hold-tree') {
    $fence.RequireRoot($worker.ProcessId, $worker.ProcessStartToken)
    $worker.Resume()
    $reader = [IO.StreamReader]::new($worker.Output, [Text.UTF8Encoding]::new($false, $true))
    $read = $reader.ReadLineAsync()
    if (-not $read.Wait(3000)) { throw 'Synthetic tree did not report' }
    $frame = $read.GetAwaiter().GetResult()
    if ($null -eq $frame -or $frame.Length -gt 1024) { throw 'Invalid synthetic tree frame' }
    $childId = ($frame | ConvertFrom-Json -AsHashtable).childId
  }
  if ($request.operation -ne 'hold-before-record') { $fence.Dispose(); $fence = $null }
  [Console]::WriteLine((@{ ready = $true; processId = $worker.ProcessId; childId = $childId } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  $command = [Console]::ReadLine()
  if ($command -eq 'resume') {
    $denied = $false
    $rootWasLive = -not $worker.RootExited
    $deadlineExpired = $worker.DeadlineExpired
    try {
      $fence = [Acp.Worker.WindowsLaunchFence]::OpenProvisioner($expected.directory, $expected.directoryIdentity, $request.attemptId,
        $expected.scope.machineFingerprint, $boot, $expected.scope.sessionId, 500)
      $fence.RequireRoot($worker.ProcessId, $worker.ProcessStartToken)
      $worker.Resume()
    } catch { $denied = $true }
    [Console]::WriteLine((@{ resumeDenied = $denied; rootWasLive = $rootWasLive; deadlineExpired = $deadlineExpired } | ConvertTo-Json -Compress))
  }
} catch {
  [Console]::WriteLine('{"ready":false}')
  exit 1
} finally {
  if ($null -ne $worker) { $worker.Dispose() }
  if ($null -ne $fence) { $fence.Dispose() }
}
