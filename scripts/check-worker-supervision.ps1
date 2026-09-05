param([switch]$Internal, [ValidateSet('supervision', 'launch-fence', 'filesystem')][string]$Suite = 'supervision')
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
if (-not $Internal) {
  Add-Type -Path (Join-Path $PSScriptRoot 'WindowsKillOnCloseJob.cs')
  $pwshPath = (Get-Command pwsh -CommandType Application | Select-Object -First 1).Source
  $ownedGate = [Acp.Integration.WindowsKillOnCloseJob]::Start($pwshPath,
    ('"{0}" -NoProfile -File "{1}" -Internal -Suite {2}' -f $pwshPath, $PSCommandPath, $Suite), $repositoryRoot)
  try {
    Write-Output "Owned PID $($ownedGate.ProcessId): Windows $Suite integration (90-second limit)"
    if (-not $ownedGate.WaitForExit(90000)) { throw 'Worker supervision integration timed out' }
    if ($ownedGate.GetExitCode() -ne 0) { throw 'Worker supervision integration failed' }
  } finally {
    $ownedGate.Terminate(0)
    if (-not $ownedGate.WaitForExit(5000)) { throw 'Owned supervision gate failed to stop' }
    $ownedGate.Dispose()
  }
  exit 0
}
Set-Location -LiteralPath $repositoryRoot
if ($Suite -eq 'filesystem') {
  Add-Type -Path @('apps/worker/native/WindowsWorkerScope.cs', 'apps/worker/native/WindowsFilesystemReadLease.cs', 'apps/worker/native/WindowsRepositoryObserver.cs', 'apps/worker/native/WindowsWorkerJob.cs')
} else { Add-Type -Path 'apps/worker/native/WindowsWorkerJob.cs' }
$nodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$testInfo = [Diagnostics.ProcessStartInfo]::new($nodePath)
$testInfo.UseShellExecute = $false
$testInfo.CreateNoWindow = $true
$testInfo.RedirectStandardOutput = $true
$testInfo.RedirectStandardError = $true
if ($Suite -eq 'filesystem') { $testInfo.Environment['ACP_TEST_GIT'] = (Get-Command git -CommandType Application | Select-Object -First 1).Source }
$testFile = switch ($Suite) {
  'launch-fence' { 'apps/worker/test/integration/windows-launch-fence.test.ts' }
  'filesystem' { 'apps/worker/test/integration/windows-filesystem.test.ts' }
  default { 'apps/worker/test/integration/windows-worker.test.ts' }
}
foreach ($argument in @('--experimental-strip-types', '--test', '--test-concurrency=1', '--test-reporter=spec', $testFile)) { $testInfo.ArgumentList.Add($argument) }
$testProcess = [Diagnostics.Process]::Start($testInfo)
$testOutput = $testProcess.StandardOutput.ReadToEndAsync()
$testError = $testProcess.StandardError.ReadToEndAsync()
try {
  Write-Output "Owned PID $($testProcess.Id): native process-tree checks (70-second limit)"
  if (-not $testProcess.WaitForExit(70000)) {
    $testProcess.Kill($true)
    if (-not $testProcess.WaitForExit(5000)) { throw 'Native test process tree failed to stop' }
    throw 'Native tests timed out'
  }
  Write-Output $testOutput.GetAwaiter().GetResult()
  Write-Output $testError.GetAwaiter().GetResult()
  if ($testProcess.ExitCode -ne 0) { throw 'Native process-tree tests failed' }
} finally { $testProcess.Dispose() }
