function Get-AcpWindowsWorkerScope {
  Add-Type -Path (Join-Path $PSScriptRoot 'WindowsWorkerScope.cs')
  $operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime -OperationTimeoutSec 3
  $scope = [Acp.Worker.WindowsWorkerScope]::Read($operatingSystem.LastBootUpTime)
  return @{ machineFingerprint = $scope.MachineFingerprint; bootedAt = $scope.BootedAt; sessionId = $scope.SessionId }
}
