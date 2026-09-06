$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$pins = $null
try {
  $line = [Console]::ReadLine()
  if ($null -eq $line -or $line.Length -gt 16384) { throw 'Bounded pin fixture request required' }
  $request = $line | ConvertFrom-Json -AsHashtable
  Add-Type -Path @(
    (Join-Path $PSScriptRoot '../../native/WindowsWorkerScope.cs'),
    (Join-Path $PSScriptRoot '../../native/WindowsFilesystemReadLease.cs'),
    (Join-Path $PSScriptRoot '../../native/WindowsProvisionerBindingPins.cs'),
    (Join-Path $PSScriptRoot 'ProvisionerPinFixtureRelease.cs'))
  if ([Acp.Worker.WindowsProvisionerBindingPins].GetConstructors().Length -ne 0) { throw 'Pins must not have a public bypass constructor' }
  $boot = (Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 3).LastBootUpTime
  $scope = [Acp.Worker.WindowsWorkerScope]::Read($boot)
  $pins = [Acp.Worker.WindowsProvisionerBindingPins]::Open($scope, $request.machineFingerprint,
    $request.workspacePath, $request.parent.path, $request.parent.identity,
    $request.commonGitDirectory.path, $request.commonGitDirectory.identity)
  [Console]::WriteLine('{"state":"held"}')
  $command = [Console]::ReadLine()
  if ($command -eq 'parallel') { [Acp.Integration.ProvisionerPinFixtureRelease]::ParallelDispose($pins) }
  elseif ($command -eq 'release') { $pins.Dispose(); $pins.Dispose() }
  else { throw 'Exact fixture release command required' }
  [Console]::WriteLine('{"state":"released"}')
  # Remain alive so post-release probes establish Dispose, not kernel cleanup.
  [Console]::ReadLine() | Out-Null
} catch {
  [Console]::WriteLine('{"state":"rejected"}')
  # A partial-acquisition leak must remain observable while this process lives.
  [Console]::ReadLine() | Out-Null
} finally { if ($null -ne $pins) { $pins.Dispose() } }
