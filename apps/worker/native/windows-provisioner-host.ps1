$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true)
# A dedicated private bridge, never a model-facing arbitrary command tool.
# Scope is observed here; the original plan must come from the trusted parent.
try {
  Add-Type -Path @((Join-Path $PSScriptRoot 'WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot 'WindowsLaunchFence.cs'),
    (Join-Path $PSScriptRoot 'WindowsWorkerScope.cs'), (Join-Path $PSScriptRoot 'WindowsProvisionerBridge.cs'),
    (Join-Path $PSScriptRoot 'WindowsFilesystemReadLease.cs'), (Join-Path $PSScriptRoot 'WindowsProvisionerBindingPins.cs'))
  $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime -OperationTimeoutSec 3
  $scope = [Acp.Worker.WindowsWorkerScope]::Read($operatingSystem.LastBootUpTime)
  exit ([Acp.Worker.WindowsProvisionerBridge]::Run($scope).GetAwaiter().GetResult())
} catch {
  [Console]::WriteLine('{"type":"unconfirmed"}')
  exit 1
}
