[CmdletBinding()]
param(
  [switch]$LifecycleOnly,
  [switch]$HostOnly,
  [switch]$LaunchRecovery,
  [switch]$LaunchNative,
  [switch]$FilesystemBindings,
  [switch]$FilesystemNative,
  [switch]$FilesystemLeases,
  [switch]$FilesystemLeaseNative,
  [ValidateSet('initial', 'lost-ack', 'periodic-cancel')]
  [string]$FilesystemLeaseChannelNative,
  [ValidateSet('core', 'races', 'expiry', 'upgrade', 'regression')]
  [string]$WorktreeReservations,
  [ValidateSet('core', 'limits', 'snapshot')]
  [string]$CounterpartStatus,
  [switch]$MigrationSessions,
  [Parameter(DontShow)]
  [switch]$Internal,
  [Parameter(DontShow)]
  [string]$RunId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($LaunchNative -and (-not $LaunchRecovery -or -not $LifecycleOnly)) { throw 'LaunchNative requires LaunchRecovery and LifecycleOnly to retain the bounded gate budget' }
if ($HostOnly -and ($LifecycleOnly -or $LaunchRecovery)) { throw 'HostOnly cannot be combined with LifecycleOnly or LaunchRecovery' }
if ($FilesystemBindings -and (-not $LifecycleOnly -or -not $LaunchRecovery -or $LaunchNative)) { throw 'FilesystemBindings requires LifecycleOnly and LaunchRecovery, without LaunchNative' }
if ($FilesystemNative -and -not $FilesystemBindings) { throw 'FilesystemNative requires FilesystemBindings' }
if ($FilesystemLeases -and (-not $FilesystemBindings -or $FilesystemNative)) { throw 'FilesystemLeases requires FilesystemBindings, without FilesystemNative' }
if ($FilesystemLeaseNative -and -not $FilesystemLeases) { throw 'FilesystemLeaseNative requires FilesystemLeases' }
if ($FilesystemLeaseChannelNative -and (-not $FilesystemLeases -or $FilesystemLeaseNative)) { throw 'FilesystemLeaseChannelNative requires FilesystemLeases, without FilesystemLeaseNative' }
if ($WorktreeReservations -and (-not $FilesystemLeases -or $FilesystemLeaseNative -or $FilesystemLeaseChannelNative)) { throw 'WorktreeReservations requires FilesystemLeases without native modes' }
if ($MigrationSessions -and ($LifecycleOnly -or $HostOnly -or $LaunchRecovery -or $LaunchNative -or $FilesystemBindings -or $FilesystemNative -or $FilesystemLeases -or $FilesystemLeaseNative -or $FilesystemLeaseChannelNative -or $WorktreeReservations)) { throw 'MigrationSessions is a standalone bounded gate' }
if ($CounterpartStatus -and ($LifecycleOnly -or $HostOnly -or $LaunchRecovery -or $LaunchNative -or $FilesystemBindings -or $FilesystemNative -or $FilesystemLeases -or $FilesystemLeaseNative -or $FilesystemLeaseChannelNative -or $WorktreeReservations -or $MigrationSessions)) { throw 'CounterpartStatus is a standalone bounded gate' }

. (Join-Path $PSScriptRoot 'native-channel-fixture.ps1')

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

if (-not $Internal) {
  $outerRunId = [guid]::NewGuid().ToString('D')
  $scriptPath = $PSCommandPath
  $repositoryRoot = Split-Path -Parent $PSScriptRoot
  $pwshCommand = (Get-Command pwsh -CommandType Application |
    Select-Object -First 1).Source
  Add-Type -Path (Join-Path $PSScriptRoot 'WindowsKillOnCloseJob.cs')
  $commandLine = '"{0}" -NoProfile -NonInteractive -File "{1}" -Internal -RunId {2}' -f `
    $pwshCommand.Replace('"', '\"'), $scriptPath.Replace('"', '\"'), $outerRunId
  if ($LifecycleOnly) { $commandLine += ' -LifecycleOnly' }
  if ($LaunchRecovery) { $commandLine += ' -LaunchRecovery' }
  if ($LaunchNative) { $commandLine += ' -LaunchNative' }
  if ($HostOnly) { $commandLine += ' -HostOnly' }
  if ($FilesystemBindings) { $commandLine += ' -FilesystemBindings' }
  if ($FilesystemNative) { $commandLine += ' -FilesystemNative' }
  if ($FilesystemLeases) { $commandLine += ' -FilesystemLeases' }
  if ($FilesystemLeaseNative) { $commandLine += ' -FilesystemLeaseNative' }
  if ($FilesystemLeaseChannelNative) { $commandLine += ' -FilesystemLeaseChannelNative ' + $FilesystemLeaseChannelNative }
  if ($WorktreeReservations) { $commandLine += ' -WorktreeReservations ' + $WorktreeReservations }
  if ($CounterpartStatus) { $commandLine += ' -CounterpartStatus ' + $CounterpartStatus }
  if ($MigrationSessions) { $commandLine += ' -MigrationSessions' }
  $integrationProcess = $null
  $channelRoot = $null
  $ownedTreeStopped = $false

  try {
    if ($FilesystemLeaseChannelNative) {
      $pendingChannelRoot = Get-AcpNativeChannelRoot $outerRunId
      New-Item -ItemType Directory -Path $pendingChannelRoot -ErrorAction Stop | Out-Null
      $channelRoot = $pendingChannelRoot
      Write-Host "Owned native channel fixture: $channelRoot"
    }
    $integrationProcess = [Acp.Integration.WindowsKillOnCloseJob]::Start(
      $pwshCommand,
      $commandLine,
      $repositoryRoot
    )
    Write-Host "Owned PID $($integrationProcess.ProcessId): bounded PostgreSQL integration"
    if (-not $integrationProcess.WaitForExit(90000)) {
      $integrationProcess.Terminate(1460)
      if (-not $integrationProcess.WaitForExit(5000)) {
        throw 'PostgreSQL integration process tree did not stop within its cleanup limit'
      }
      throw 'PostgreSQL integration work exceeded its 90-second limit'
    }
    $integrationExitCode = $integrationProcess.GetExitCode()
    if ($integrationExitCode -ne 0) {
      throw "PostgreSQL integration child exited with $integrationExitCode"
    }
  }
  finally {
    try {
    if ($null -ne $integrationProcess) {
      try {
        $integrationProcess.Terminate(0)
        $ownedTreeStopped = $integrationProcess.WaitForEmpty(5000)
        if (-not $ownedTreeStopped) { throw 'Owned PostgreSQL integration job did not become empty' }
      }
      finally {
        $integrationProcess.Dispose()
      }
    }
    } finally {
    try {
    $inventory = Invoke-BoundedDocker @(
      'ps', '-aq', '--filter', "label=acp.integration.run=$outerRunId"
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
        throw "Owned PostgreSQL integration container remains: $ownedContainerId"
      }
    }
    } finally {
      if ($null -ne $channelRoot -and (Test-Path -LiteralPath $channelRoot)) {
        if ($FilesystemLeaseChannelNative -eq 'periodic-cancel') { Write-AcpNativeWriterDiagnostics $outerRunId }
        if ($ownedTreeStopped) { Remove-AcpNativeChannelFixture $outerRunId $true }
        elseif ($null -eq $integrationProcess) { Remove-Item -LiteralPath $channelRoot } # Only the empty prelaunch directory.
        else { throw "Owned native fixture preserved without empty-job proof: $channelRoot" }
        if (Test-Path -LiteralPath $channelRoot) { throw "Owned native fixture remains: $channelRoot" }
      }
    }
    }
  }
  return
}

if ([string]::IsNullOrWhiteSpace($RunId)) {
  throw 'Internal PostgreSQL integration run requires a run identifier'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$containerName = 'acp-postgres-integration-check'
$postgresImage = 'postgres:18.6-alpine3.24'
$expectedPostgresDigest = 'postgres@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2'
$sessionAJob = $null
$sessionBJob = $null
$ownedContainerId = $null
$postgresOptions = '-c statement_timeout=30000 -c lock_timeout=10000'

function Invoke-AcpSqlFile {
  param(
    [Parameter(Mandatory)]
    [string]$RelativePath,
    [Parameter(Mandatory)]
    [string]$Label
  )

  Write-Host "Running $Label"
  $sqlPath = Join-Path $repositoryRoot $RelativePath
  Get-Content -Raw -LiteralPath $sqlPath |
    docker exec -i --env "PGOPTIONS=$postgresOptions" $containerName `
      psql -v ON_ERROR_STOP=1 -U postgres -d acp_test `
      --single-transaction --quiet --tuples-only --no-align |
    Where-Object { $_.Trim().Length -gt 0 }
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed"
  }
}

function Invoke-AcpSqlText {
  param(
    [Parameter(Mandatory)]
    [string]$Sql,
    [Parameter(Mandatory)]
    [string]$Label
  )

  Write-Host "Running $Label"
  $Sql | docker exec -i --env "PGOPTIONS=$postgresOptions" $containerName `
    psql -v ON_ERROR_STOP=1 -U postgres -d acp_test --quiet
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed"
  }
}

try {
  $postgresDigest = docker image inspect $postgresImage `
    --format '{{index .RepoDigests 0}}'
  if ($LASTEXITCODE -ne 0 -or $postgresDigest -ne $expectedPostgresDigest) {
    throw "PostgreSQL image digest mismatch: $postgresDigest"
  }

  $existingContainer = docker ps -a --filter "name=^/$containerName`$" `
    --format '{{.ID}}'
  if ($LASTEXITCODE -ne 0) {
    throw 'Docker container inventory failed'
  }
  if ($existingContainer) {
    throw "Refusing to replace existing container $containerName"
  }

  $ownedContainerId = docker run --name $containerName --rm -d `
    --pull never --cpus 1 --memory 512m `
    -p '127.0.0.1::5432' `
    --label "acp.integration.run=$RunId" `
    -e POSTGRES_PASSWORD=acp_test_password `
    -e POSTGRES_DB=acp_test $postgresImage
  if ($LASTEXITCODE -ne 0) {
    throw 'PostgreSQL container startup failed'
  }
  Write-Host "Started $containerName ($ownedContainerId)"

  $ready = $false
  $consecutiveReadyChecks = 0
  for ($attempt = 1; $attempt -le 40; $attempt++) {
    docker exec $containerName pg_isready -U postgres -d acp_test *> $null
    if ($LASTEXITCODE -eq 0) {
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
    docker logs $containerName
    throw 'PostgreSQL did not become ready'
  }

  Invoke-AcpSqlFile 'packages/storage/migrations/0001_control_plane.sql' `
    '0001 up'
  Invoke-AcpSqlFile `
    'packages/storage/test/integration/postgres-0001-upgrade-seed.sql' `
    'populated 0001 seed'
  Invoke-AcpSqlFile 'packages/storage/migrations/0002_durable_runtime.sql' `
    '0002 up'
  Invoke-AcpSqlFile 'packages/storage/migrations/0003_worker_runtime.sql' `
    '0003 up'
  Invoke-AcpSqlFile 'packages/storage/migrations/0004_counterpart_interface.sql' `
    '0004 up'
  Invoke-AcpSqlFile `
    'packages/storage/test/integration/postgres-authority-lock-negative.sql' `
    'unfenced authority denial'
  Invoke-AcpSqlFile `
    'packages/storage/test/integration/postgres-invariants.sql' `
    'durable invariant fixture'
  Invoke-AcpSqlFile 'packages/storage/migrations/0005_authoritative_context.sql' `
    '0005 populated upgrade'
  function Invoke-AcpNodeCheck {
    param([string]$RelativePath, [string]$Label, [string]$Phase, [int]$TimeoutSeconds = 30)
    $mappedPort = Invoke-BoundedDocker @('port', $containerName, '5432/tcp')
    $checkPort = ($mappedPort.StandardOutput.Trim() -split ':')[-1]
    if ($checkPort -notmatch '^[0-9]+$') { throw 'Invalid integration test database port' }
    $checkStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $checkStartInfo.FileName = (Get-Command node -CommandType Application | Select-Object -First 1).Source
    $checkStartInfo.UseShellExecute = $false
    $checkStartInfo.CreateNoWindow = $true
    $checkStartInfo.RedirectStandardOutput = $true
    $checkStartInfo.RedirectStandardError = $true
    $checkStartInfo.WorkingDirectory = $repositoryRoot
    if (($FilesystemNative -and $RelativePath -eq 'packages/storage/test/integration/filesystem-bindings.ts') -or
        ($FilesystemLeaseNative -and $RelativePath -eq 'packages/storage/test/integration/filesystem-writer-leases.ts') -or
        ($FilesystemLeaseChannelNative -and $RelativePath -eq 'packages/storage/test/integration/filesystem-native-channel.ts')) {
      $checkStartInfo.Environment['ACP_TEST_GIT'] = (Get-Command git -CommandType Application | Select-Object -First 1).Source
    }
    if ($FilesystemLeaseChannelNative -and $RelativePath -eq 'packages/storage/test/integration/filesystem-native-channel.ts') {
      $checkStartInfo.Environment['ACP_TEST_NATIVE_CHANNEL_ROOT'] = Get-AcpNativeChannelRoot $RunId
    }
    foreach ($argument in @('--experimental-strip-types', $RelativePath, $checkPort)) {
      $checkStartInfo.ArgumentList.Add($argument)
    }
    if ($Phase) { $checkStartInfo.ArgumentList.Add($Phase) }
    $checkProcess = [System.Diagnostics.Process]::Start($checkStartInfo)
    $checkOutput = $checkProcess.StandardOutput.ReadToEndAsync()
    $checkError = $checkProcess.StandardError.ReadToEndAsync()
    try {
      Write-Host "Owned PID $($checkProcess.Id): $Label ($TimeoutSeconds seconds)"
      if (-not $checkProcess.WaitForExit($TimeoutSeconds * 1000)) {
        $checkProcess.Kill($true)
        if (-not $checkProcess.WaitForExit(5000)) {
          throw "$Label process tree did not stop after timeout"
        }
        Write-Host $checkOutput.GetAwaiter().GetResult()
        Write-Host $checkError.GetAwaiter().GetResult()
        throw "$Label timed out"
      }
      Write-Host $checkOutput.GetAwaiter().GetResult()
      Write-Host $checkError.GetAwaiter().GetResult()
      if ($checkProcess.ExitCode -ne 0) { throw "$Label failed" }
    }
    finally { $checkProcess.Dispose() }
  }
  if ($MigrationSessions) {
    Invoke-AcpNodeCheck 'packages/storage/test/integration/migration-sessions.ts' 'Migration session integration' -TimeoutSeconds 30
    Write-Host 'Migration session integration passed; removing only the owned disposable database container.'
    return
  }
  if ($FilesystemLeaseChannelNative -or $WorktreeReservations -or $CounterpartStatus) {
    # Focused real database/native phases apply the same seeded schema directly.
    # Unrelated predecessor suites cannot consume their bounded child's budget.
    foreach ($migration in @('0006_host_dispatch.sql', '0007_supervised_workers.sql', '0008_worker_recovery.sql',
        '0009_lifecycle_context.sql', '0010_worker_handoff.sql', '0011_worker_launch_intents.sql',
        '0012_worker_launch_recovery.sql', '0013_filesystem_bindings.sql', '0014_filesystem_writer_leases.sql')) {
      Invoke-AcpSqlFile ('packages/storage/migrations/' + $migration) ('Focused prerequisite schema: ' + $migration)
    }
    if ($CounterpartStatus) {
      Invoke-AcpSqlFile 'packages/storage/migrations/0015_worktree_target_holds.sql' 'Status prerequisite: 0015 target holds'
      Invoke-AcpNodeCheck 'packages/storage/test/integration/counterpart-status.ts' 'Counterpart status integration' $CounterpartStatus -TimeoutSeconds 30
      Write-Host 'Focused read-only counterpart status phase passed; predecessor suites remain separate gates.'
      return
    }
    if ($WorktreeReservations) {
      Invoke-AcpSqlFile 'packages/storage/migrations/0015_worktree_target_holds.sql' '0015 pre-run target hold upgrade'
      if ($WorktreeReservations -eq 'regression') {
        Invoke-AcpNodeCheck 'packages/storage/test/integration/filesystem-writer-leases.ts' 'Legacy filesystem writer regression under 0015' -TimeoutSeconds 30
      } else {
        Invoke-AcpNodeCheck 'packages/storage/test/integration/worktree-reservations.ts' 'Pre-run target hold integration' $WorktreeReservations -TimeoutSeconds 30
      }
      Write-Host 'Focused pre-run target hold phase passed; predecessor suites remain separate gates.'
      return
    }
    Invoke-AcpNodeCheck 'packages/storage/test/integration/filesystem-native-channel.ts' 'Native writer channel integration' $FilesystemLeaseChannelNative -TimeoutSeconds 30
    Write-Host 'Focused native writer channel scenario passed; predecessor suites are verified separately.'
    return
  }
  Invoke-AcpNodeCheck 'packages/storage/test/integration/context-store.ts' 'Authoritative context integration'
  Invoke-AcpSqlFile 'packages/storage/migrations/0006_host_dispatch.sql' '0006 populated upgrade'
  Invoke-AcpSqlFile 'packages/storage/migrations/0007_supervised_workers.sql' '0007 populated upgrade'
  Invoke-AcpSqlFile 'packages/storage/migrations/0008_worker_recovery.sql' '0008 populated upgrade'
  Invoke-AcpNodeCheck 'packages/storage/test/integration/lifecycle-context.ts' 'Lifecycle upgrade preparation' 'before'
  Invoke-AcpNodeCheck 'packages/storage/test/integration/lifecycle-context.ts' 'Lifecycle upgrade preflight' 'preflight'
  Invoke-AcpSqlFile 'packages/storage/migrations/0009_lifecycle_context.sql' '0009 populated upgrade'
  Invoke-AcpSqlFile 'packages/storage/migrations/0010_worker_handoff.sql' '0010 populated upgrade'
  Invoke-AcpSqlFile 'packages/storage/migrations/0011_worker_launch_intents.sql' '0011 populated upgrade'
  if (-not $LifecycleOnly) {
    Invoke-AcpNodeCheck 'packages/storage/test/integration/host-dispatch.ts' 'Host dispatch integration' -TimeoutSeconds 45
    if ($HostOnly) {
      Write-Host 'Host-only integration passed. Migration rollback is covered separately by LifecycleOnly; removing only the owned disposable database.'
      return
    }
  }
  Invoke-AcpNodeCheck 'packages/storage/test/integration/lifecycle-context.ts' 'Lifecycle context integration' 'after'
  Invoke-AcpNodeCheck 'packages/storage/test/integration/worker-handoff.ts' 'Worker handoff integration'
  Invoke-AcpNodeCheck 'packages/storage/test/integration/worker-launch-intent.ts' 'Worker launch-intent integration'
  if ($LaunchRecovery) {
    Invoke-AcpSqlFile 'packages/storage/migrations/0012_worker_launch_recovery.sql' '0012 populated upgrade'
    Invoke-AcpSqlFile 'packages/storage/migrations/0012_worker_launch_recovery.down.sql' '0012 reversible producer smoke'
    Invoke-AcpSqlFile 'packages/storage/migrations/0012_worker_launch_recovery.sql' '0012 re-upgrade'
    Invoke-AcpNodeCheck 'packages/storage/test/integration/worker-launch-recovery.ts' 'Worker launch recovery integration' -TimeoutSeconds 60
    if ($LaunchNative) { Invoke-AcpNodeCheck 'packages/storage/test/integration/worker-launch-native.ts' 'Worker native launch integration' -TimeoutSeconds 45 }
    if ($FilesystemBindings) {
      Invoke-AcpSqlFile 'packages/storage/migrations/0013_filesystem_bindings.sql' '0013 filesystem binding upgrade'
      Invoke-AcpSqlFile 'packages/storage/migrations/0013_filesystem_bindings.down.sql' '0013 empty registry downgrade'
      Invoke-AcpSqlFile 'packages/storage/migrations/0013_filesystem_bindings.sql' '0013 filesystem binding re-upgrade'
      $filesystemPhase = if ($FilesystemNative) { 'native' } else { '' }
      Invoke-AcpNodeCheck 'packages/storage/test/integration/filesystem-bindings.ts' 'Filesystem binding integration' $filesystemPhase -TimeoutSeconds 30
      if ($FilesystemLeases) {
        Invoke-AcpSqlFile 'packages/storage/migrations/0014_filesystem_writer_leases.sql' '0014 filesystem writer upgrade'
        Invoke-AcpSqlFile 'packages/storage/migrations/0014_filesystem_writer_leases.down.sql' '0014 empty writer downgrade'
        Invoke-AcpSqlFile 'packages/storage/migrations/0014_filesystem_writer_leases.sql' '0014 filesystem writer re-upgrade'
        $writerPhase = if ($FilesystemLeaseNative) { 'native' } else { '' }
        Invoke-AcpNodeCheck 'packages/storage/test/integration/filesystem-writer-leases.ts' 'Filesystem writer lease integration' $writerPhase -TimeoutSeconds 30
      }
    }
    Write-Host 'Launch recovery checks passed. No-journal receipts intentionally block producer downgrade; removing only the owned disposable database.'
    return
  }

  $unpauseSql = @'
BEGIN;
SELECT acp.acquire_effect_authority_lock();
INSERT INTO acp.runtime_control_authorizations (
  authorization_id, scope_type, scope_id, action, authorized_by, reason,
  valid_from, expires_at, provenance_id
) VALUES (
  'rca_00000000-0000-4000-8000-000000000010', 'global', 'global',
  'unpause_effects', 'integration:concurrency', 'Prepare concurrency probe.',
  '2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z',
  'prv_00000000-0000-4000-8000-000000000001'
);
DO $$
DECLARE
  control_time timestamptz;
BEGIN
  SELECT greatest(updated_at + interval '1 microsecond', statement_timestamp())
  INTO control_time
  FROM acp.runtime_controls
  WHERE scope_type = 'global' AND scope_id = 'global';

  INSERT INTO acp.runtime_control_events (
    control_event_id, scope_type, scope_id, previous_effects_paused,
    effects_paused, reason, updated_by, authorization_id, occurred_at,
    provenance_id
  ) VALUES (
    'rce_00000000-0000-4000-8000-000000000010', 'global', 'global', true,
    false, 'Prepare concurrency probe.', 'integration:concurrency',
    'rca_00000000-0000-4000-8000-000000000010', control_time,
    'prv_00000000-0000-4000-8000-000000000001'
  );
  PERFORM set_config(
    'acp.runtime_control_event_id',
    'rce_00000000-0000-4000-8000-000000000010',
    true
  );
  UPDATE acp.runtime_controls
  SET effects_paused = false,
      reason = 'Prepare concurrency probe.',
      updated_by = 'integration:concurrency',
      authorization_id = 'rca_00000000-0000-4000-8000-000000000010',
      updated_at = control_time,
      last_control_event_id = 'rce_00000000-0000-4000-8000-000000000010'
  WHERE scope_type = 'global' AND scope_id = 'global';
END;
$$;
COMMIT;
'@
  Invoke-AcpSqlText $unpauseSql 'concurrency probe setup'

  $sessionASql = @'
BEGIN;
SELECT acp.acquire_effect_authority_lock();
SELECT pg_sleep(5);
DO $$
DECLARE
  control_time timestamptz;
BEGIN
  SELECT greatest(updated_at + interval '1 microsecond', statement_timestamp())
  INTO control_time
  FROM acp.runtime_controls
  WHERE scope_type = 'global' AND scope_id = 'global';

  INSERT INTO acp.runtime_control_events (
    control_event_id, scope_type, scope_id, previous_effects_paused,
    effects_paused, reason, updated_by, authorization_id, occurred_at,
    provenance_id
  ) VALUES (
    'rce_00000000-0000-4000-8000-000000000011', 'global', 'global', false,
    true, 'Concurrent safety pause.', 'integration:concurrency', NULL,
    control_time, 'prv_00000000-0000-4000-8000-000000000001'
  );
  PERFORM set_config(
    'acp.runtime_control_event_id',
    'rce_00000000-0000-4000-8000-000000000011',
    true
  );
  UPDATE acp.runtime_controls
  SET effects_paused = true,
      reason = 'Concurrent safety pause.',
      updated_by = 'integration:concurrency',
      authorization_id = NULL,
      updated_at = control_time,
      last_control_event_id = 'rce_00000000-0000-4000-8000-000000000011'
  WHERE scope_type = 'global' AND scope_id = 'global';
END;
$$;
COMMIT;
'@

  $sessionBSql = @'
BEGIN;
SELECT acp.acquire_effect_authority_lock();
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM acp.runtime_controls
    WHERE scope_type = 'global'
      AND scope_id = 'global'
      AND effects_paused
      AND reason = 'Concurrent safety pause.'
  ) THEN
    RAISE EXCEPTION
      'post-fence authority read did not observe the concurrent pause';
  END IF;
END;
$$;
COMMIT;
'@

  $jobScript = {
    param($JobContainerName, $Sql, $SessionName)
    $Sql | docker exec -i `
      --env 'PGOPTIONS=-c statement_timeout=30000 -c lock_timeout=10000' `
      $JobContainerName psql -v ON_ERROR_STOP=1 -U postgres -d acp_test --quiet
    if ($LASTEXITCODE -ne 0) {
      throw "$SessionName failed"
    }
  }

  Write-Host 'Running two-session authority-fence probe'
  $sessionAJob = Start-Job -ScriptBlock $jobScript `
    -ArgumentList $containerName, $sessionASql, 'authority session A'

  $sessionALocked = $false
  for ($attempt = 1; $attempt -le 40; $attempt++) {
    $lockHeld = docker exec $containerName psql -v ON_ERROR_STOP=1 `
      -U postgres -d acp_test -Atc `
      "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND classid = 1094929713::oid AND objid = 1162237008::oid AND objsubid = 2 AND granted AND pid <> pg_catalog.pg_backend_pid())"
    if ($LASTEXITCODE -ne 0) {
      throw 'Authority-lock probe query failed'
    }
    if ($lockHeld -eq 't') {
      $sessionALocked = $true
      break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $sessionALocked) {
    throw 'Authority session A did not acquire the fence'
  }

  $sessionBJob = Start-Job -ScriptBlock $jobScript `
    -ArgumentList $containerName, $sessionBSql, 'authority session B'
  Wait-Job -Job $sessionAJob, $sessionBJob -Timeout 20 | Out-Null
  Receive-Job -Job $sessionAJob, $sessionBJob -ErrorAction Stop | Out-Host
  if ($sessionAJob.State -ne 'Completed' -or $sessionBJob.State -ne 'Completed') {
    throw "Concurrency probe failed: A=$($sessionAJob.State), B=$($sessionBJob.State)"
  }

  Invoke-AcpSqlFile 'packages/storage/migrations/0011_worker_launch_intents.down.sql' '0011 down'
  Invoke-AcpSqlText "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM acp.mission_events WHERE event_type = 'worker.launch-admitted') THEN RAISE EXCEPTION 'launch audit receipt lost on downgrade'; END IF; END; `$`$;" 'launch audit receipt survives downgrade'
  Invoke-AcpSqlFile 'packages/storage/migrations/0010_worker_handoff.down.sql' '0010 down'
  Invoke-AcpSqlText "DO `$`$ BEGIN IF NOT EXISTS (SELECT 1 FROM acp.mission_events WHERE event_type = 'worker.recovery-handed-off') THEN RAISE EXCEPTION 'handoff audit receipt lost on downgrade'; END IF; END; `$`$;" 'handoff audit receipt survives downgrade'
  Invoke-AcpSqlFile 'packages/storage/migrations/0009_lifecycle_context.down.sql' '0009 down'
  Invoke-AcpNodeCheck 'packages/storage/test/integration/lifecycle-context.ts' 'Lifecycle rollback integration' 'rollback'
  Invoke-AcpSqlFile 'packages/storage/migrations/0009_lifecycle_context.sql' '0009 re-upgrade with retained audit guards'
  Invoke-AcpSqlFile 'packages/storage/migrations/0009_lifecycle_context.down.sql' '0009 repeated producer rollback'
  Invoke-AcpSqlFile 'packages/storage/migrations/0008_worker_recovery.down.sql' '0008 down'
  Invoke-AcpSqlFile 'packages/storage/migrations/0007_supervised_workers.down.sql' '0007 down'
  Invoke-AcpSqlFile 'packages/storage/migrations/0006_host_dispatch.down.sql' '0006 down'
  Invoke-AcpSqlFile 'packages/storage/migrations/0005_authoritative_context.down.sql' `
    '0005 down'
  Invoke-AcpSqlFile 'packages/storage/migrations/0004_counterpart_interface.down.sql' `
    '0004 down'
  Invoke-AcpSqlFile 'packages/storage/migrations/0003_worker_runtime.down.sql' `
    '0003 down'
  Invoke-AcpSqlFile 'packages/storage/migrations/0002_durable_runtime.down.sql' `
    '0002 down'
  Invoke-AcpSqlFile 'packages/storage/migrations/0001_control_plane.down.sql' `
    '0001 down'

  $schemaCount = docker exec $containerName psql -v ON_ERROR_STOP=1 `
    -U postgres -d acp_test -Atc `
    "SELECT count(*) FROM pg_namespace WHERE nspname = 'acp'"
  if ($LASTEXITCODE -ne 0 -or $schemaCount -ne '0') {
    throw "ACP schema remains after rollback: $schemaCount"
  }

  Write-Host 'PostgreSQL integration and two-session authority checks passed.'
}
finally {
  foreach ($job in @($sessionAJob, $sessionBJob)) {
    if ($null -ne $job) {
      Stop-Job -Job $job -ErrorAction SilentlyContinue
      Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
  }
  if ($null -ne $ownedContainerId -and $ownedContainerId.Trim().Length -gt 0) {
    $runningContainer = Invoke-BoundedDocker @(
      'ps', '-aq', '--filter', "id=$ownedContainerId", '--format', '{{.ID}}'
    )
    if ($runningContainer.StandardOutput.Trim().Length -gt 0) {
      Invoke-BoundedDocker @('rm', '--force', $ownedContainerId) | Out-Null
      $remainingContainer = Invoke-BoundedDocker @(
        'ps', '-aq', '--filter', "id=$ownedContainerId", '--format', '{{.ID}}'
      )
      if ($remainingContainer.StandardOutput.Trim().Length -gt 0) {
        throw "Owned PostgreSQL integration container remains: $ownedContainerId"
      }
    }
  }
}
