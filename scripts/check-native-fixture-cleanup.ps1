$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'native-channel-fixture.ps1')
Add-Type -Path (Join-Path $PSScriptRoot 'WindowsKillOnCloseJob.cs')
$taskNode = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$holder = Join-Path $PSScriptRoot 'test/owned-fixture-holder.mjs'
foreach ($mode in @('hold', 'root-exit')) {
  $ownedRun = [guid]::NewGuid().ToString('D')
  $ownedRoot = Get-AcpNativeChannelRoot $ownedRun
  New-Item -ItemType Directory -Path $ownedRoot | Out-Null
  $job = $null
  $empty = $false
  try {
    $job = [Acp.Integration.WindowsKillOnCloseJob]::Start($taskNode, ('"{0}" "{1}" "{2}" {3}' -f $taskNode, $holder, $ownedRoot, $mode), $PSScriptRoot)
    Write-Host "Owned PID $($job.ProcessId): native fixture cleanup $mode (10-second setup bound)"
    $readyFile = Join-Path $ownedRoot 'owned-pids.json'
    $budget = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath $readyFile)) {
      if ($budget.ElapsedMilliseconds -gt 10000) { throw 'Owned fixture setup timed out' }
      Start-Sleep -Milliseconds 20
    }
    $identities = Get-Content -LiteralPath $readyFile -Raw | ConvertFrom-Json
    Write-Host "Owned PID $($identities.child): native fixture cleanup descendant"
    if ($mode -eq 'hold' -and $job.WaitForExit(50)) { throw 'Held fixture root unexpectedly exited' }
    if ($mode -eq 'root-exit' -and -not $job.WaitForExit(5000)) { throw 'Fixture root did not exit' }
    if ($job.WaitForEmpty(50)) { throw 'Live descendant incorrectly reported as empty job' }
    $rejected = $false
    try { Remove-AcpNativeChannelFixture $ownedRun $false } catch { $rejected = $true }
    if (-not $rejected -or -not (Test-Path -LiteralPath $readyFile)) { throw 'Fixture removed before job-empty proof' }
    $job.Terminate(137)
    if (-not $job.WaitForEmpty(5000)) { throw 'Owned fixture job did not stop' }
    $empty = $true
    Remove-AcpNativeChannelFixture $ownedRun $true
    if (Test-Path -LiteralPath $ownedRoot) { throw 'Owned fixture root remains' }
    Write-Host "PASS native fixture cleanup: $mode retains state until every owned process exits"
  } finally {
    if ($null -ne $job) {
      try { $job.Terminate(0); $empty = $job.WaitForEmpty(5000) } finally { $job.Dispose() }
    } else { $empty = $true }
    Remove-AcpNativeChannelFixture $ownedRun $empty
  }
}
