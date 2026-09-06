$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$nativeRoot = Join-Path $PSScriptRoot '../../native'
Add-Type -Path @((Join-Path $nativeRoot 'WindowsLaunchFence.cs'), (Join-Path $nativeRoot 'WindowsWorkerJob.cs'))
$request = [Console]::ReadLine() | ConvertFrom-Json -AsHashtable
$fence = $null
$worker = $null
try {
  $expected = $request.fence
  if ($request.operation -eq 'hold-directory-only') {
    # Exercise the exact private native anchor seam before any descendant fence
    # file exists. An open file must not mask ineffective directory sharing.
    $method = [Acp.Worker.WindowsLaunchFence].GetMethod('OpenDirectory', [Reflection.BindingFlags]'NonPublic,Static')
    $fence = $method.Invoke($null, @($expected.directory))
    [Console]::WriteLine('{"ready":true}')
    [Console]::Out.Flush()
    [Console]::ReadLine() | Out-Null
    return
  }
  $boot = ([DateTimeOffset]$expected.scope.bootedAt).ToUniversalTime().ToString('O')
  $fence = [Acp.Worker.WindowsLaunchFence]::Open($expected.directory, $expected.directoryIdentity, $request.workerProcessId,
    $expected.scope.machineFingerprint, $boot, $expected.scope.sessionId, 1000)
  if ($request.operation -eq 'seal-only') {
    $fence.Seal()
    [Console]::WriteLine('{"ready":true}')
  } elseif ($request.operation -eq 'claim-only') {
    $fence.Begin()
    [Console]::WriteLine('{"ready":true}')
  } elseif ($request.operation -eq 'hold-created-root') {
    $fence.Begin()
    $worker = [Acp.Worker.WindowsWorkerJob]::Create(('Local\ACP.Worker.' + $request.workerProcessId),
      $request.executable, [string[]]$request.arguments, $request.workspace, [string[]]$request.environment,
      ([DateTimeOffset]$request.deadlineAt).UtcDateTime)
    # Intentionally stop before RecordRoot; no release and no database journal.
    [Console]::WriteLine((@{ ready = $true; processId = $worker.ProcessId } | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    [Console]::ReadLine() | Out-Null
  } elseif ($request.operation -eq 'hold-fence') {
    $fence.Begin()
    [Console]::WriteLine('{"ready":true}')
    [Console]::Out.Flush()
    [Console]::ReadLine() | Out-Null
  } else { throw 'Unknown synthetic operation' }
} finally {
  if ($null -ne $worker) { $worker.Dispose() }
  if ($null -ne $fence) { $fence.Dispose() }
}
