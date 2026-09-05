$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$pins = $null
try {
  $line = [Console]::ReadLine()
  if ($line.Length -gt 16384) { throw 'Oversized pin fixture request' }
  $request = $line | ConvertFrom-Json -AsHashtable
  Add-Type -Path @(
    (Join-Path $PSScriptRoot '../../native/WindowsWorkerScope.cs'),
    (Join-Path $PSScriptRoot '../../native/WindowsFilesystemReadLease.cs'),
    (Join-Path $PSScriptRoot '../../native/WindowsLinkedWorktreePins.cs'))
  # A public default constructor would bypass Open and return a pinless object.
  if ([Acp.Worker.WindowsLinkedWorktreePins].GetConstructors().Length -ne 0) { throw 'Pin scope must not be publicly constructible' }
  $scope = [Acp.Worker.WindowsWorkerScope]::Read((Get-CimInstance Win32_OperatingSystem).LastBootUpTime)
  $pins = [Acp.Worker.WindowsLinkedWorktreePins]::Open($scope, $request.machineFingerprint,
    $request.checkout.path, $request.checkout.identity, $request.commonGitDirectory.path, $request.commonGitDirectory.identity,
    $request.workspace.path, $request.workspace.identity, $request.gitDirectory.path, $request.gitDirectory.identity)
  [Console]::WriteLine('{"state":"held"}')
  [Console]::ReadLine() | Out-Null
  $pins.Dispose()
  [Console]::WriteLine('{"state":"released"}')
} catch {
  [Console]::WriteLine('{"state":"rejected"}')
  # Stay alive: rejection tests must prove partial-acquisition Dispose released
  # earlier pins, not merely observe Windows closing handles at process exit.
  [Console]::ReadLine() | Out-Null
} finally { if ($null -ne $pins) { $pins.Dispose() } }
