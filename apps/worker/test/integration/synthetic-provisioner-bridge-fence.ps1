# Test-only seal/hold actor. Never creates a root or performs a stop.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -Path (Join-Path $PSScriptRoot '../../native/WindowsLaunchFence.cs')
$request = [Console]::ReadLine() | ConvertFrom-Json -AsHashtable
$fence = $null
try {
  $expected = $request.fence
  # ConvertFrom-Json may materialize timestamps as DateTime. Never let implicit
  # PowerShell string conversion discard the boot identity's fractional part.
  $boot = ([DateTimeOffset]$expected.scope.bootedAt).ToUniversalTime().ToString('O')
  $fence = [Acp.Worker.WindowsLaunchFence]::OpenProvisioner($expected.directory, $expected.directoryIdentity, $request.attemptId,
    $expected.scope.machineFingerprint, $boot, $expected.scope.sessionId, 1000)
  if ($request.operation -eq 'seal') { $fence.Seal() }
  elseif ($request.operation -ne 'hold') { throw 'Unknown fixture operation' }
  [Console]::WriteLine('{"ready":true}')
  [Console]::Out.Flush()
  if ($request.operation -eq 'hold') { [Console]::ReadLine() | Out-Null }
} finally { if ($null -ne $fence) { $fence.Dispose() } }
