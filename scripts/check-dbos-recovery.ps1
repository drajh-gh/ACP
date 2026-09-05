[CmdletBinding()]
param(
  [Parameter(DontShow)]
  [switch]$Internal,
  [Parameter(DontShow)]
  [string]$RunId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-BoundedDocker {
  param(
    [Parameter(Mandatory)]
    [string[]]$DockerArguments,
    [int]$TimeoutSeconds = 10,
    [switch]$AllowFailure
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = 'docker'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in $DockerArguments) {
    $startInfo.ArgumentList.Add($argument)
  }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      throw 'Could not start bounded Docker command'
    }
    $standardOutputTask = $process.StandardOutput.ReadToEndAsync()
    $standardErrorTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      $process.Kill($true)
      if (-not $process.WaitForExit(5000)) {
        throw "Docker command could not be stopped after timeout: $($DockerArguments -join ' ')"
      }
      throw "Docker command exceeded ${TimeoutSeconds}s: $($DockerArguments -join ' ')"
    }
    $standardOutput = $standardOutputTask.GetAwaiter().GetResult()
    $standardError = $standardErrorTask.GetAwaiter().GetResult()
    if ($standardOutput.Length -gt 65536) {
      $standardOutput = "[truncated]`n" + $standardOutput.Substring($standardOutput.Length - 65536)
    }
    if ($standardError.Length -gt 65536) {
      $standardError = "[truncated]`n" + $standardError.Substring($standardError.Length - 65536)
    }
    if (-not $AllowFailure -and $process.ExitCode -ne 0) {
      throw "Docker command failed: $standardError"
    }
    return [pscustomobject]@{
      ExitCode = $process.ExitCode
      StandardOutput = $standardOutput
      StandardError = $standardError
    }
  }
  finally {
    $process.Dispose()
  }
}

function Read-CappedLog {
  param(
    [Parameter(Mandatory)]
    [string]$Path,
    [int]$MaximumCharacters = 65536
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return ''
  }
  $file = [System.IO.File]::Open(
    $Path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::ReadWrite
  )
  try {
    $charactersToRead = [Math]::Min($MaximumCharacters, [int]$file.Length)
    if ($file.Length -gt $charactersToRead) {
      $file.Seek(-$charactersToRead, [System.IO.SeekOrigin]::End) | Out-Null
    }
    $buffer = [byte[]]::new($charactersToRead)
    $read = $file.Read($buffer, 0, $buffer.Length)
    $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
    if ($file.Length -gt $charactersToRead) {
      return "[truncated]`n$text"
    }
    return $text
  }
  finally {
    $file.Dispose()
  }
}

if (-not $Internal) {
  $outerRunId = [guid]::NewGuid().ToString('D')
  $scriptPath = $PSCommandPath
  $repositoryRoot = Split-Path -Parent $PSScriptRoot
  $pwshCommand = (Get-Command pwsh -CommandType Application |
    Select-Object -First 1).Source
  Add-Type -Path (Join-Path $PSScriptRoot 'WindowsKillOnCloseJob.cs')
  $commandLine = '"{0}" -NoProfile -NonInteractive -File "{1}" -Internal -RunId {2}' -f `
    $pwshCommand.Replace('"', '\"'), $scriptPath.Replace('"', '\"'), $outerRunId
  $integrationProcess = $null

  try {
    $integrationProcess = [Acp.Integration.WindowsKillOnCloseJob]::Start(
      $pwshCommand,
      $commandLine,
      $repositoryRoot
    )
    Write-Host "Owned PID $($integrationProcess.ProcessId): bounded DBOS recovery integration"
    if (-not $integrationProcess.WaitForExit(90000)) {
      $integrationProcess.Terminate(1460)
      if (-not $integrationProcess.WaitForExit(5000)) {
        throw 'DBOS recovery process tree did not stop within its cleanup limit'
      }
      throw 'DBOS recovery work exceeded its 90-second limit'
    }
    $integrationExitCode = $integrationProcess.GetExitCode()
    if ($integrationExitCode -ne 0) {
      throw "DBOS recovery child exited with $integrationExitCode"
    }
  }
  finally {
    if ($null -ne $integrationProcess) {
      try {
        $integrationProcess.Terminate(0)
        $integrationProcess.WaitForExit(5000) | Out-Null
      }
      finally {
        $integrationProcess.Dispose()
      }
    }
    $outerTemporaryRoot = [System.IO.Path]::GetTempPath()
    foreach ($outerTemporarySuffix in @('stdout.log', 'stderr.log')) {
      Remove-Item -LiteralPath (Join-Path $outerTemporaryRoot `
        "acp-dbos-recovery-$outerRunId.$outerTemporarySuffix") `
        -Force -ErrorAction SilentlyContinue
    }
    $inventory = Invoke-BoundedDocker @(
      'ps', '-aq', '--filter', "label=acp.dbos-recovery.run=$outerRunId"
    )
    $ownedContainerIds = @($inventory.StandardOutput -split '\r?\n' |
      Where-Object { $_.Trim().Length -gt 0 })
    foreach ($ownedContainerId in $ownedContainerIds) {
      Invoke-BoundedDocker @('rm', '--force', $ownedContainerId) `
        -AllowFailure | Out-Null
      $remaining = Invoke-BoundedDocker @(
        'ps', '-aq', '--filter', "id=$ownedContainerId", '--format', '{{.ID}}'
      )
      if ($remaining.StandardOutput.Trim().Length -gt 0) {
        throw "Owned DBOS recovery container remains: $ownedContainerId"
      }
    }
  }
  return
}

if ([string]::IsNullOrWhiteSpace($RunId)) {
  throw 'Internal DBOS recovery run requires a run identifier'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$postgresContainerName = 'acp-dbos-recovery-postgres'
$postgresImage = 'postgres:18.6-alpine3.24'
$expectedPostgresDigest = 'postgres@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2'
$ownedPostgresId = $null
$runnerProcess = $null
$stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) `
  "acp-dbos-recovery-$RunId.stdout.log"
$stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) `
  "acp-dbos-recovery-$RunId.stderr.log"

function Assert-CachedImageDigest {
  param(
    [Parameter(Mandatory)]
    [string]$Image,
    [Parameter(Mandatory)]
    [string]$ExpectedDigest
  )

  $digestResult = Invoke-BoundedDocker @(
    'image', 'inspect', $Image, '--format', '{{json .RepoDigests}}'
  ) -AllowFailure
  if ($digestResult.ExitCode -ne 0) {
    throw "Required cached image is unavailable: $Image"
  }
  $repoDigests = @($digestResult.StandardOutput | ConvertFrom-Json)
  if ($ExpectedDigest -notin $repoDigests) {
    throw "Image digest mismatch for ${Image}: $($repoDigests -join ', ')"
  }
}

try {
  Assert-CachedImageDigest $postgresImage $expectedPostgresDigest
  $nodeCommand = (Get-Command node -CommandType Application |
    Select-Object -First 1).Source
  $nodeVersionText = & $nodeCommand --version
  $nodeVersion = [version]$nodeVersionText.TrimStart('v')
  if ($nodeVersion.Major -lt 24) {
    throw "DBOS recovery check requires Node 24 or newer; found $nodeVersion"
  }

  $existingResult = Invoke-BoundedDocker @(
    'ps', '-a', '--filter', "name=^/$postgresContainerName`$", '--format', '{{.ID}}'
  )
  $existingContainer = $existingResult.StandardOutput.Trim()
  if ($existingContainer) {
    throw "Refusing to replace existing container $postgresContainerName"
  }

  foreach ($ownedTemporaryPath in @($stdoutPath, $stderrPath)) {
    if (Test-Path -LiteralPath $ownedTemporaryPath) {
      throw "Refusing to overwrite existing recovery file $ownedTemporaryPath"
    }
  }
  $runResult = Invoke-BoundedDocker @(
    'run', '--name', $postgresContainerName, '--rm', '-d', '--pull', 'never',
    '--cpus', '1', '--memory', '512m', '--pids-limit', '128',
    '--publish', '127.0.0.1::5432',
    '--label', "acp.dbos-recovery.run=$RunId",
    '-e', 'POSTGRES_PASSWORD=acp_test_password',
    '-e', 'POSTGRES_DB=acp_dbos_recovery', $postgresImage
  )
  $ownedPostgresId = $runResult.StandardOutput.Trim()
  Write-Host "Started $postgresContainerName ($ownedPostgresId)"

  $ready = $false
  $consecutiveReadyChecks = 0
  for ($attempt = 1; $attempt -le 40; $attempt++) {
    $readyResult = Invoke-BoundedDocker @(
      'exec', $postgresContainerName, 'pg_isready', '-U', 'postgres',
      '-d', 'acp_dbos_recovery'
    ) -AllowFailure
    if ($readyResult.ExitCode -eq 0) {
      $consecutiveReadyChecks += 1
      if ($consecutiveReadyChecks -ge 2) {
        $ready = $true
        break
      }
    }
    else {
      $consecutiveReadyChecks = 0
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) {
    $logs = Invoke-BoundedDocker @('logs', '--tail', '200', $postgresContainerName) `
      -AllowFailure
    Write-Host $logs.StandardOutput
    Write-Host $logs.StandardError
    throw 'DBOS recovery PostgreSQL did not become ready'
  }

  $portResult = Invoke-BoundedDocker @(
    'port', $postgresContainerName, '5432/tcp'
  )
  $publishedPort = $portResult.StandardOutput.Trim()
  if ($publishedPort -notmatch ':(\d+)$') {
    throw "Could not resolve DBOS recovery PostgreSQL port: $publishedPort"
  }
  $databaseUrl = "postgresql://postgres:acp_test_password@127.0.0.1:$($Matches[1])/acp_dbos_recovery"
  Write-Host 'Running live DBOS process-kill recovery check'
  $runnerProcess = Start-Process -FilePath $nodeCommand `
    -ArgumentList @(
      '--experimental-strip-types',
      '--test',
      '--test-concurrency=1',
      'apps/worker/test/integration/dbos-process-recovery.test.ts'
    ) `
    -WorkingDirectory $repositoryRoot `
    -Environment @{
      ACP_DBOS_RECOVERY_DATABASE_URL = $databaseUrl
    } `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden -PassThru
  Write-Host "Started recovery runner process $($runnerProcess.Id)"

  $runnerFinished = $false
  $runnerExitCode = $null
  for ($attempt = 1; $attempt -le 140; $attempt++) {
    $runnerProcess.Refresh()
    if ($runnerProcess.HasExited) {
      if (-not $runnerProcess.WaitForExit(5000)) {
        throw 'Live DBOS runner exit output did not settle within its cleanup limit'
      }
      $runnerFinished = $true
      $runnerExitCode = $runnerProcess.ExitCode
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $runnerFinished) {
    foreach ($logPath in @($stdoutPath, $stderrPath)) {
      if (Test-Path -LiteralPath $logPath) {
        Read-CappedLog $logPath | Write-Host
      }
    }
    $runnerProcess.Kill($true)
    if (-not $runnerProcess.WaitForExit(5000)) {
      throw 'Live DBOS runner did not stop within its cleanup limit'
    }
    throw 'Live DBOS process-kill recovery runner exceeded 70 seconds'
  }

  foreach ($logPath in @($stdoutPath, $stderrPath)) {
    if (Test-Path -LiteralPath $logPath) {
      Read-CappedLog $logPath | Write-Host
    }
  }
  if ($runnerExitCode -ne 0) {
    throw "Live DBOS process-kill recovery check failed with exit code $runnerExitCode"
  }

  Write-Host 'Live DBOS process-kill recovery check passed.'
}
finally {
  if ($null -ne $runnerProcess) {
    $runnerProcess.Refresh()
    if (-not $runnerProcess.HasExited) {
      $runnerProcess.Kill($true)
      if (-not $runnerProcess.WaitForExit(5000)) {
        throw 'Owned DBOS runner remains after bounded cleanup'
      }
    }
  }
  foreach ($logPath in @($stdoutPath, $stderrPath)) {
    Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $ownedPostgresId -and $ownedPostgresId.Trim().Length -gt 0) {
    $runningContainer = Invoke-BoundedDocker @(
      'ps', '-aq', '--filter', "id=$ownedPostgresId", '--format', '{{.ID}}'
    )
    if ($runningContainer.StandardOutput.Trim().Length -gt 0) {
      Invoke-BoundedDocker @('rm', '--force', $ownedPostgresId) | Out-Null
      $remainingContainer = Invoke-BoundedDocker @(
        'ps', '-aq', '--filter', "id=$ownedPostgresId", '--format', '{{.ID}}'
      )
      if ($remainingContainer.StandardOutput.Trim().Length -gt 0) {
        throw "Owned DBOS recovery PostgreSQL remains: $ownedPostgresId"
      }
    }
  }
}
