param([switch]$Internal, [ValidateSet('supervision', 'launch-fence', 'provisioner-fence', 'provisioner-admission', 'provisioner-bridge', 'provisioner-runner', 'filesystem', 'filesystem-pins', 'provisioner-observation', 'lease-watchdog', 'lease-liveness', 'lease-bootstrap', 'lease-channel', 'lease-channel-liveness')][string]$Suite = 'supervision', [string]$TestNamePattern, [string]$OwnedFixtureRun)
$ErrorActionPreference = 'Stop'
if ($Suite -eq 'provisioner-observation' -and -not $TestNamePattern) { throw 'Select a bounded provisioner observation phase with -TestNamePattern; see README.' }
if ($Suite -eq 'provisioner-fence' -and $TestNamePattern -notin @('^provisioner core:', '^provisioner safety:')) { throw 'Select an exact bounded provisioner fence core or safety phase; see README.' }
if ($Suite -eq 'provisioner-admission' -and $TestNamePattern -notin @('^provisioner admission core:', '^provisioner admission modes:', '^provisioner admission expiry:', '^provisioner admission bootstrap:')) { throw 'Select an exact bounded provisioner admission phase; see README.' }
if ($Suite -eq 'provisioner-bridge' -and $TestNamePattern -notin @('^provisioner bridge core:', '^provisioner bridge ack-owner:', '^provisioner bridge ack-plan:', '^provisioner bridge ack-root:', '^provisioner bridge ack-fence:', '^provisioner bridge framing:', '^provisioner bridge safety:', '^provisioner bridge loss:')) { throw 'Select an exact bounded provisioner bridge phase; see README.' }
if ($Suite -eq 'provisioner-runner' -and $TestNamePattern -notin @('^provisioner runner core:', '^provisioner runner loss:', '^provisioner runner expiry:')) { throw 'Select an exact bounded provisioner runner phase; see README.' }
$repositoryRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'native-channel-fixture.ps1')
if (-not $Internal) {
  Add-Type -Path (Join-Path $PSScriptRoot 'WindowsKillOnCloseJob.cs')
  $pwshPath = (Get-Command pwsh -CommandType Application | Select-Object -First 1).Source
  if ($TestNamePattern -match '["\r\n]') { throw 'Invalid test-name pattern' }
  $gateArguments = '"{0}" -NoProfile -File "{1}" -Internal -Suite {2}' -f $pwshPath, $PSCommandPath, $Suite
  if ($TestNamePattern) { $gateArguments += ' -TestNamePattern "' + $TestNamePattern + '"' }
  $ownedGate = $null
  $fixtureRoot = $null
  $empty = $false
  try {
    if ($Suite -in @('filesystem-pins', 'provisioner-observation', 'launch-fence', 'provisioner-fence', 'provisioner-bridge', 'provisioner-runner')) {
      $OwnedFixtureRun = [guid]::NewGuid().ToString('D')
      $pendingRoot = Get-AcpNativeChannelRoot $OwnedFixtureRun
      New-Item -ItemType Directory -Path $pendingRoot | Out-Null
      $fixtureRoot = $pendingRoot
      $gateArguments += ' -OwnedFixtureRun ' + $OwnedFixtureRun
      Write-Host "Owned $Suite fixture: $fixtureRoot"
    }
    $ownedGate = [Acp.Integration.WindowsKillOnCloseJob]::Start($pwshPath, $gateArguments, $repositoryRoot)
    Write-Output "Owned PID $($ownedGate.ProcessId): Windows $Suite integration (90-second limit)"
    if (-not $ownedGate.WaitForExit(90000)) { throw 'Worker supervision integration timed out' }
    if ($ownedGate.GetExitCode() -ne 0) { throw 'Worker supervision integration failed' }
  } finally {
    try {
      if ($null -ne $ownedGate) {
        try { $ownedGate.Terminate(0); $empty = $ownedGate.WaitForEmpty(5000) }
        finally { $ownedGate.Dispose() }
        if (-not $empty) { throw 'Owned supervision gate failed to stop' }
      }
    } finally {
      if ($null -ne $fixtureRoot) {
        if ($null -eq $ownedGate) { Remove-Item -LiteralPath $fixtureRoot }
        else { Remove-AcpNativeChannelFixture $OwnedFixtureRun $empty }
      }
    }
  }
  exit 0
}
Set-Location -LiteralPath $repositoryRoot
if ($Suite -in @('filesystem', 'provisioner-observation')) {
  Add-Type -Path @('apps/worker/native/WindowsWorkerScope.cs', 'apps/worker/native/WindowsFilesystemReadLease.cs', 'apps/worker/native/WindowsRepositoryObserver.cs', 'apps/worker/native/WindowsWorkerJob.cs')
} else { Add-Type -Path 'apps/worker/native/WindowsWorkerJob.cs' }
$nodePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$testInfo = [Diagnostics.ProcessStartInfo]::new($nodePath)
$testInfo.UseShellExecute = $false
$testInfo.CreateNoWindow = $true
$testInfo.RedirectStandardOutput = $true
$testInfo.RedirectStandardError = $true
if ($Suite -in @('filesystem', 'filesystem-pins', 'provisioner-observation')) { $testInfo.Environment['ACP_TEST_GIT'] = (Get-Command git -CommandType Application | Select-Object -First 1).Source }
if ($Suite -in @('filesystem-pins', 'provisioner-observation', 'launch-fence', 'provisioner-fence', 'provisioner-bridge', 'provisioner-runner')) { $testInfo.Environment['ACP_TEST_NATIVE_CHANNEL_ROOT'] = Get-AcpNativeChannelRoot $OwnedFixtureRun }
if ($Suite -eq 'provisioner-runner') { $testInfo.Environment['ACP_TEST_PWSH'] = (Get-Command pwsh -CommandType Application | Select-Object -First 1).Source }
$testFile = switch ($Suite) {
  'launch-fence' { 'apps/worker/test/integration/windows-launch-fence.test.ts' }
  'provisioner-fence' { 'apps/worker/test/integration/windows-provisioner-fence.test.ts' }
  'provisioner-admission' { 'apps/worker/test/integration/windows-provisioner-admission.test.ts' }
  'provisioner-bridge' { 'apps/worker/test/integration/windows-provisioner-bridge.test.ts' }
  'provisioner-runner' { 'apps/worker/test/integration/windows-provisioner-runner.test.ts' }
  'filesystem' { 'apps/worker/test/integration/windows-filesystem.test.ts' }
  'filesystem-pins' { 'apps/worker/test/integration/windows-linked-worktree-pins.test.ts' }
  'provisioner-observation' { 'apps/worker/test/integration/windows-provisioner-observation.test.ts' }
  'lease-watchdog' { 'apps/worker/test/integration/windows-lease-watchdog.test.ts' }
  'lease-liveness' { 'apps/worker/test/integration/windows-lease-watchdog.test.ts' }
  'lease-bootstrap' { 'apps/worker/test/integration/windows-lease-watchdog.test.ts' }
  'lease-channel' { 'apps/worker/test/integration/windows-lease-channel.test.ts' }
  'lease-channel-liveness' { 'apps/worker/test/integration/windows-lease-channel-liveness.test.ts' }
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
