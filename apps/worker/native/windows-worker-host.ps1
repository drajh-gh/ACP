$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Send-AcpFrame($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 8)); [Console]::Out.Flush() }
$workerJob = $null
$launchFence = $null
$controlReader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))
$phase = 'read-launch'
try {
  # Read bounded launch data before compiling or creating anything. No command
  # strings are evaluated. The parent supplies exact executable/argument arrays.
  $launchLine = $controlReader.ReadLine()
  if ($null -eq $launchLine -or $launchLine.Length -gt 65536) { throw 'Invalid launch frame' }
  $launch = $launchLine | ConvertFrom-Json -AsHashtable
  $phase = 'validate-launch'
  if ($launch.workerProcessId -notmatch '^wpr_[0-9a-f-]{36}$') { throw 'Invalid process journal identity' }
  # ConvertFrom-Json may already have produced a UTC DateTime. Casting preserves
  # its kind; Parse(string) would first format it without the UTC offset.
  $deadline = ([DateTimeOffset]$launch.deadlineAt).UtcDateTime
  if ($deadline -le [DateTime]::UtcNow -or $deadline -gt [DateTime]::UtcNow.AddDays(1)) { throw 'Invalid persisted deadline' }
  $phase = 'compile-bridge'
  Add-Type -Path (Join-Path $PSScriptRoot 'WindowsWorkerJob.cs')
  $phase = 'read-os-scope'
  . (Join-Path $PSScriptRoot 'windows-worker-scope.ps1')
  $scope = Get-AcpWindowsWorkerScope
  if ($launch.ContainsKey('launchFence')) {
    $phase = 'lock-launch-fence'
    Add-Type -Path (Join-Path $PSScriptRoot 'WindowsLaunchFence.cs')
    $expected = $launch.launchFence
    $expectedBoot = ([DateTimeOffset]$expected.scope.bootedAt).ToUniversalTime().ToString('O')
    if ($expected.scope.machineFingerprint -cne $scope.machineFingerprint -or
        ([DateTimeOffset]$expectedBoot) -ne ([DateTimeOffset]$scope.bootedAt) -or $expected.scope.sessionId -ne $scope.sessionId) { throw 'Launch scope mismatch' }
    $launchFence = [Acp.Worker.WindowsLaunchFence]::Open($expected.directory, $expected.directoryIdentity, $launch.workerProcessId,
      $scope.machineFingerprint, $expectedBoot, $scope.sessionId, 1000)
    $launchFence.Begin()
  }
  $phase = 'create-owned-root'
  $workerJob = [Acp.Worker.WindowsWorkerJob]::Create(('Local\ACP.Worker.' + $launch.workerProcessId),
    $launch.executable, [string[]]$launch.arguments, $launch.workspace, [string[]]$launch.environment, $deadline)
  if ($null -ne $launchFence) {
    $launchFence.RecordRoot($workerJob.ProcessId, $workerJob.ProcessStartToken, $workerJob.StartedAt)
    $launchFence.Dispose(); $launchFence = $null
  }
  Send-AcpFrame @{ type = 'ready'; processId = $workerJob.ProcessId; processStartToken = $workerJob.ProcessStartToken; startedAt = $workerJob.StartedAt; scope = $scope }
  $phase = 'control-loop'
  # Console.In is a synchronized TextReader whose async methods may block the
  # calling thread. A dedicated StreamReader keeps exit/deadline polling live.
  $control = $controlReader.ReadLineAsync()
  $outBuffer = [byte[]]::new(8192)
  $errBuffer = [byte[]]::new(8192)
  $output = $workerJob.Output.ReadAsync($outBuffer, 0, $outBuffer.Length)
  $errors = $workerJob.Error.ReadAsync($errBuffer, 0, $errBuffer.Length)
  $released = $false
  $stopRequested = $false
  $outputBytes = 0L
  $errorBytes = 0L
  $inputDelivery = $null
  while ($true) {
    if ($workerJob.DeadlineExpired -or [DateTime]::UtcNow -ge $deadline) { $stopRequested = $true }
    if ($control.IsCompleted) {
      $line = $control.GetAwaiter().GetResult()
      if ($null -eq $line) { $stopRequested = $true }
      else {
        if ($line.Length -gt 524288) { throw 'Oversized control frame' }
        $command = $line | ConvertFrom-Json -AsHashtable
        if ($command.type -eq 'stop') { $stopRequested = $true }
        elseif ($command.type -eq 'go' -and -not $released -and -not $stopRequested) {
          $released = $true
          if ($launch.ContainsKey('launchFence')) {
            $launchFence = [Acp.Worker.WindowsLaunchFence]::Open($expected.directory, $expected.directoryIdentity, $launch.workerProcessId,
              $scope.machineFingerprint, $expectedBoot, $scope.sessionId, 1000)
            $launchFence.RequireRoot($workerJob.ProcessId, $workerJob.ProcessStartToken)
          }
          try { $workerJob.Resume() }
          finally { if ($null -ne $launchFence) { $launchFence.Dispose(); $launchFence = $null } }
          $inputBytes = [Text.Encoding]::UTF8.GetBytes($command.input + "`n")
          $inputDelivery = $workerJob.BeginInput($inputBytes)
        } else { throw 'Invalid control transition' }
        $control = $controlReader.ReadLineAsync()
      }
    }
    if ($stopRequested -or $workerJob.RootExited) {
      # Root exit is not tree exit: reap descendants even after normal output.
      $rootExitCode = if ($workerJob.RootExited) { $workerJob.ExitCode } else { 137 }
      if (-not $workerJob.TerminateAndWait(5000)) { throw 'Tree termination unconfirmed' }
      break
    }
    if ($null -ne $inputDelivery -and $inputDelivery.IsCompleted) {
      $inputDelivery.GetAwaiter().GetResult()
      $inputDelivery = $null
    }
    if ($output.IsCompleted) {
      $count = $output.GetAwaiter().GetResult()
      if ($count -gt 0) {
        $outputBytes += $count
        if ($outputBytes -gt $launch.maximumOutputBytes) { throw 'Runner output exceeded limit' }
        Send-AcpFrame @{ type = 'output'; data = [Convert]::ToBase64String($outBuffer, 0, $count) }
        $output = $workerJob.Output.ReadAsync($outBuffer, 0, $outBuffer.Length)
      }
    }
    if ($errors.IsCompleted) {
      $count = $errors.GetAwaiter().GetResult()
      if ($count -gt 0) {
        $errorBytes += $count
        if ($errorBytes -gt 65536) { throw 'Runner stderr exceeded limit' }
        # Drain but never forward model/credential-bearing stderr to the daemon.
        $errors = $workerJob.Error.ReadAsync($errBuffer, 0, $errBuffer.Length)
      }
    }
    [Threading.Thread]::Sleep(10)
  }
  # All writers are now dead. Drain remaining buffered stdout under the same cap.
  $phase = 'drain-output'
  while ($true) {
    $count = $output.GetAwaiter().GetResult()
    if ($count -eq 0) { break }
    $outputBytes += $count
    if ($outputBytes -gt $launch.maximumOutputBytes) { throw 'Runner output exceeded limit' }
    Send-AcpFrame @{ type = 'output'; data = [Convert]::ToBase64String($outBuffer, 0, $count) }
    $output = $workerJob.Output.ReadAsync($outBuffer, 0, $outBuffer.Length)
  }
  Send-AcpFrame @{ type = 'closed'; treeEmpty = $true; exitCode = $rootExitCode; terminated = $stopRequested }
} catch {
  # Errors are intentionally generic; exception contents may contain payloads.
  $empty = $false
  if ($null -ne $workerJob) { try { $empty = $workerJob.TerminateAndWait(5000) } catch {} }
  Send-AcpFrame @{ type = 'failure'; treeEmpty = $empty; stage = $phase;
    errorCode = $_.Exception.HResult; scriptLine = $_.InvocationInfo.ScriptLineNumber }
  exit 1
} finally {
  if ($null -ne $launchFence) { $launchFence.Dispose() }
  if ($null -ne $workerJob) { $workerJob.Dispose() }
  $controlReader.Dispose()
}
