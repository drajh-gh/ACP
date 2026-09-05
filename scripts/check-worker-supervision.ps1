param([switch]$Internal, [ValidateSet('supervision', 'launch-fence', 'filesystem', 'lease-watchdog', 'lease-liveness', 'lease-bootstrap')][string]$Suite = 'supervision', [string]$TestNamePattern)
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
if (-not $Internal) {
  Add-Type -Path (Join-Path $PSScriptRoot 'WindowsKillOnCloseJob.cs')
  $pwshPath = (Get-Command pwsh -CommandType Application | Select-Object -First 1).Source
  if ($TestNamePattern -match '["\r\n]') { throw 'Invalid test-name pattern' }
  $gateArguments = '"{0}" -NoProfile -File "{1}" -Internal -Suite {2}' -f $pwshPath, $PSCommandPath, $Suite
  if ($TestNamePattern) { $gateArguments += ' -TestNamePattern "' + $TestNamePattern + '"' }
  $ownedGate = [Acp.Integration.WindowsKillOnCloseJob]::Start($pwshPath, $gateArguments, $repositoryRoot)
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
  'lease-watchdog' { 'apps/worker/test/integration/windows-lease-watchdog.test.ts' }
  'lease-liveness' { 'apps/worker/test/integration/windows-lease-watchdog.test.ts' }
  'lease-bootstrap' { 'apps/worker/test/integration/windows-lease-watchdog.test.ts' }
  default { 'apps/worker/test/integration/windows-worker.test.ts' }
}
foreach ($argument in @('--experimental-strip-types', '--test', '--test-concurrency=1', '--test-reporter=spec')) { $testInfo.ArgumentList.Add($argument) }
$leaseLivenessPattern = '^(native expiry|fresh native epochs|the persisted run deadline|native lease silence|a pending challenge|an expired old epoch)'
if ($Suite -eq 'lease-watchdog') { $testInfo.ArgumentList.Add('--test-skip-pattern=^no first ACK|' + $leaseLivenessPattern) }
$suitePattern = switch ($Suite) { 'lease-liveness' { $leaseLivenessPattern }; 'lease-bootstrap' { '^no first ACK' }; default { '' } }
# Do not use a complement skip filter: it also skips Node's parent FILE and all
# its cases. One positive regex intersects both searches without repeated flags.
$selectedPattern = if ($suitePattern -and $TestNamePattern) {
  '^(?=[\s\S]*(?:' + $suitePattern + '))(?=[\s\S]*(?:' + $TestNamePattern + '))'
} elseif ($suitePattern) { $suitePattern } else { $TestNamePattern }
if ($selectedPattern) { $testInfo.ArgumentList.Add('--test-name-pattern=' + $selectedPattern) }
$testInfo.ArgumentList.Add($testFile)
$testProcess = [Diagnostics.Process]::Start($testInfo)
$testOutput = $testProcess.StandardOutput.ReadToEndAsync()
$testError = $testProcess.StandardError.ReadToEndAsync()
try {
  Write-Output "Owned PID $($testProcess.Id): native process-tree checks (70-second limit)"
  if (-not $testProcess.WaitForExit(70000)) {
    $testProcess.Kill($true)
    if (-not $testProcess.WaitForExit(5000)) { throw 'Native test process tree failed to stop' }
    if ($testOutput.Wait(2000)) { Write-Output $testOutput.GetAwaiter().GetResult() }
    if ($testError.Wait(2000)) { Write-Output $testError.GetAwaiter().GetResult() }
    throw 'Native tests timed out'
  }
  $capturedOutput = $testOutput.GetAwaiter().GetResult()
  Write-Output $capturedOutput
  Write-Output $testError.GetAwaiter().GetResult()
  if ($testProcess.ExitCode -ne 0) { throw 'Native process-tree tests failed' }
  # Node reports the test FILE as one passing test when every actual case was
  # filtered out. Require a passed case, not just exit zero or the summary count.
  $passedCases = @($capturedOutput -split '\r?\n' | Where-Object {
    $_ -match '^\u2714 (.+) \([0-9.]+ms\)$' -and $Matches[1].Replace('\', '/') -cne $testFile
  })
  if ($passedCases.Count -eq 0) { throw 'No matching native test cases ran' }
} finally { $testProcess.Dispose() }
