$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true)
try {
  Add-Type -Path @(
    (Join-Path $PSScriptRoot '../../native/WindowsWorkerJob.cs'),
    (Join-Path $PSScriptRoot '../../native/WindowsLaunchFence.cs'),
    (Join-Path $PSScriptRoot '../../native/WindowsWorkerScope.cs'),
    (Join-Path $PSScriptRoot '../../native/WindowsProvisionerBridge.cs'),
    (Join-Path $PSScriptRoot '../../native/WindowsFilesystemReadLease.cs'),
    (Join-Path $PSScriptRoot '../../native/WindowsProvisionerBindingPins.cs'),
    (Join-Path $PSScriptRoot 'ProvisionerBridgePinObserver.cs'))
  $boot = (Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 3).LastBootUpTime
  $scope = [Acp.Worker.WindowsWorkerScope]::Read($boot)
  exit ([Acp.Integration.ProvisionerBridgePinObserver]::Run($scope).GetAwaiter().GetResult())
} catch {
  [Console]::WriteLine('{"type":"fixture-error"}')
  exit 1
}
