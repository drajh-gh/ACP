$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $line = [Console]::ReadLine()
  if ($null -eq $line -or $line.Length -gt 4096) { throw 'Invalid recovery frame' }
  $request = $line | ConvertFrom-Json -AsHashtable
  if ($request.workerProcessId -notmatch '^wpr_[0-9a-f-]{36}$' -or
      $request.treeIdentifier -cne ('Local\ACP.Worker.' + $request.workerProcessId) -or
      $request.processStartToken -notmatch '^win32-filetime:[0-9]{16,20}$' -or $request.processId -lt 1) { throw 'Invalid recovery identity' }
  # Compile together so the recovery class can reference the scope type.
  Add-Type -Path @((Join-Path $PSScriptRoot 'WindowsWorkerScope.cs'), (Join-Path $PSScriptRoot 'WindowsWorkerRecovery.cs'))
  $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime -OperationTimeoutSec 3
  $scope = [Acp.Worker.WindowsWorkerScope]::Read($operatingSystem.LastBootUpTime)
  $deadline = ([DateTimeOffset]$request.deadlineAt).UtcDateTime
  $remaining = [Math]::Floor(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
  if ($remaining -le 0 -or $remaining -gt 15000) { throw 'Recovery deadline invalid' }
  $expectedBoot = ([DateTimeOffset]$request.scope.bootedAt).ToUniversalTime().ToString('O')
  $observation = [Acp.Worker.WindowsWorkerRecovery]::Stop($request.treeIdentifier, $request.processId,
    $request.processStartToken, $request.scope.machineFingerprint, $expectedBoot, $request.scope.sessionId,
    $scope, [Math]::Min(5000, $remaining))
  [Console]::WriteLine((@{ state = $observation.State; reason = $observation.Reason; exitCode = $observation.ExitCode } | ConvertTo-Json -Compress))
} catch {
  [Console]::WriteLine('{"state":"unconfirmed","reason":"native_recovery_unavailable","exitCode":null}')
  exit 1
}
