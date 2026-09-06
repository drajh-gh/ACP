# Test-only native primitive probe. No database, permanent fence, Git or model.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -Path (Join-Path $PSScriptRoot '../../native/WindowsWorkerJob.cs')
function Send-ProbeFrame($value) { [Console]::WriteLine(($value | ConvertTo-Json -Compress -Depth 8)); [Console]::Out.Flush() }
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))
$worker = $null
try {
  $launch = $reader.ReadLine() | ConvertFrom-Json -AsHashtable
  $deadline = [DateTime]::UtcNow.AddMilliseconds($launch.deadlineMilliseconds)
  if ($launch.mode -eq 'legacy') {
    $worker = [Acp.Worker.WindowsWorkerJob]::Create(('Local\ACP.Worker.' + $launch.workerProcessId),
      $launch.executable, [string[]]$launch.arguments, $launch.workspace, [string[]]$launch.environment, $deadline)
  } elseif ($launch.mode -eq 'lease') {
    $worker = [Acp.Worker.WindowsWorkerJob]::CreateWithFilesystemLease(('Local\ACP.Worker.' + $launch.workerProcessId),
      $launch.executable, [string[]]$launch.arguments, $launch.workspace, [string[]]$launch.environment, $deadline,
      $launch.leaseId, $launch.runId, $launch.workerProcessId)
  } else {
    $worker = [Acp.Worker.WindowsWorkerJob]::CreateWithProvisionerAdmission($launch.jobName,
      $launch.executable, [string[]]$launch.arguments, $launch.workspace, [string[]]$launch.environment, $deadline,
      $launch.attemptId, $launch.reservationRevision)
  }
  Send-ProbeFrame @{ type = 'ready'; processId = $worker.ProcessId; processStartToken = $worker.ProcessStartToken; startedAt = $worker.StartedAt }
  $control = $reader.ReadLineAsync()
  $buffer = [byte[]]::new(8192)
  $output = $worker.Output.ReadAsync($buffer, 0, $buffer.Length)
  $worker.Error.CopyToAsync([IO.Stream]::Null) | Out-Null
  $stopRequested = $false
  while ($true) {
    if ($control.IsCompleted) {
      $line = $control.GetAwaiter().GetResult()
      if ($null -eq $line) { $stopRequested = $true }
      else {
        $command = $line | ConvertFrom-Json -AsHashtable
        switch -CaseSensitive ($command.type) {
          'challenge' {
            $challenge = $worker.BeginProvisionerAdmissionChallenge()
            Send-ProbeFrame @{ type = 'challenge'; nonce = $challenge.Nonce; epoch = $challenge.Epoch }
          }
          'accept' {
            $worker.AcceptProvisionerAdmissionChallenge($command.nonce, $command.epoch, $command.attemptId,
              $command.reservationRevision, $command.durationMilliseconds)
            Send-ProbeFrame @{ type = 'accepted'; nonce = $command.nonce; epoch = $command.epoch; reservationRevision = $command.reservationRevision }
          }
          'lease-challenge' { $worker.BeginFilesystemLeaseChallenge() | Out-Null }
          'lease-accept' { $worker.AcceptFilesystemLeaseChallenge('0' * 32, 1, $launch.leaseId, $launch.runId, $launch.workerProcessId, 1, 5000) }
          'go' {
            $worker.GoProvisioner()
            $worker.BeginInput([Text.Encoding]::UTF8.GetBytes($launch.input + "`n")) | Out-Null
            Send-ProbeFrame @{ type = 'resumed' }
          }
          'worker-go' { $worker.Resume() }
          'stall' { [Threading.Thread]::Sleep(30000) }
          'stop' { $stopRequested = $true }
          default { throw 'Invalid probe transition' }
        }
        $control = $reader.ReadLineAsync()
      }
    }
    if ($stopRequested -or $worker.RootExited) { break }
    if ($output.IsCompleted) {
      $count = $output.GetAwaiter().GetResult()
      if ($count -gt 0) {
        Send-ProbeFrame @{ type = 'output'; data = [Convert]::ToBase64String($buffer, 0, $count) }
        $output = $worker.Output.ReadAsync($buffer, 0, $buffer.Length)
      }
    }
    [Threading.Thread]::Sleep(10)
  }
  if (-not $worker.TerminateAndWait(5000)) { throw 'Probe tree closure unconfirmed' }
  Send-ProbeFrame @{ type = 'closed'; treeEmpty = $true; exitCode = $worker.ExitCode; deadlineExpired = $worker.DeadlineExpired }
} catch {
  $empty = $false
  $nativeTreeEmpty = $false
  $nativeDeadlineExpired = $false
  # Observe native denial BEFORE test cleanup can supply the missing kill.
  if ($null -ne $worker) {
    try {
      $nativeDeadlineExpired = $worker.DeadlineExpired
      $observation = [Diagnostics.Stopwatch]::StartNew()
      while ((-not $worker.RootExited -or $worker.ActiveProcesses -ne 0) -and $observation.ElapsedMilliseconds -lt 1500) { [Threading.Thread]::Sleep(10) }
      $nativeTreeEmpty = $worker.RootExited -and $worker.ActiveProcesses -eq 0
    } catch {}
  }
  if ($null -ne $worker) { try { $empty = $worker.TerminateAndWait(5000) } catch {} }
  Send-ProbeFrame @{ type = 'failure'; treeEmpty = $empty; created = ($null -ne $worker); nativeTreeEmpty = $nativeTreeEmpty; nativeDeadlineExpired = $nativeDeadlineExpired }
  exit 1
} finally {
  if ($null -ne $worker) { $worker.Dispose() }
  $reader.Dispose()
}
