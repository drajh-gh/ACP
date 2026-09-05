$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $line = [Console]::ReadLine()
  if ($null -eq $line -or $line.Length -gt 16384) { throw 'Invalid observation frame' }
  $request = $line | ConvertFrom-Json -AsHashtable
  Add-Type -Path @((Join-Path $PSScriptRoot 'WindowsWorkerScope.cs'), (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'),
    (Join-Path $PSScriptRoot 'WindowsFilesystemReadLease.cs'), (Join-Path $PSScriptRoot 'WindowsRepositoryObserver.cs'))
  $os = Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime -OperationTimeoutSec 3
  $actual = [Acp.Worker.WindowsWorkerScope]::Read($os.LastBootUpTime)
  $report = [Action[int]] { param($ownedPid) [Console]::WriteLine('{"type":"process","pid":'+$ownedPid+'}') }
  $observer = [Acp.Worker.WindowsRepositoryObserver]::new($request.gitExecutable, ([DateTimeOffset]$request.deadlineAt).UtcDateTime, $report)
  if ($request.operation -eq 'repository') {
    $result = $observer.Repository($request.checkout, $actual.MachineFingerprint)
  } elseif ($request.operation -eq 'worktree') {
    $repository = $request.repository
    if ($repository.machineFingerprint -cne $actual.MachineFingerprint) { throw 'Wrong machine' }
    $result = $observer.Worktree($repository.checkout.path,$repository.checkout.identity,$repository.commonGitDirectory.path,
      $repository.commonGitDirectory.identity,$request.workspace,$actual.MachineFingerprint)
  } else { throw 'Unsupported observation' }
  [Console]::WriteLine('{"type":"observation","value":'+$result+'}')
} catch {
  [Console]::WriteLine('{"type":"observation","value":{"state":"unconfirmed"}}')
  exit 1
}
