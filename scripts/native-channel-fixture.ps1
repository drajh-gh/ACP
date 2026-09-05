# Exact outer-gate-owned disposable path, never a caller-selected recursive target.
function Get-AcpNativeChannelRoot([string]$OwnedRunId) {
  $validatedRun = [guid]::ParseExact($OwnedRunId, 'D').ToString('D')
  if ($validatedRun -cne $OwnedRunId) { throw 'Canonical owned fixture run identifier required' }
  return [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('acp-native-writer-channel-' + $validatedRun)))
}

function Remove-AcpNativeChannelFixture([string]$OwnedRunId, [bool]$TreeEmpty) {
  $target = Get-AcpNativeChannelRoot $OwnedRunId
  if (-not (Test-Path -LiteralPath $target)) { return }
  if (-not $TreeEmpty) { throw "Owned native fixture preserved without empty-job proof: $target" }
  if ((Split-Path -Parent $target) -ine ([IO.Path]::GetTempPath().TrimEnd('\'))) { throw 'Unsafe owned fixture cleanup target' }
  $item = Get-Item -LiteralPath $target
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Owned fixture root was redirected; preserved for inspection' }
  Remove-Item -LiteralPath $target -Recurse -Force
  if (Test-Path -LiteralPath $target) { throw "Owned native fixture remains: $target" }
  Write-Host "Removed owned native channel fixture: $target"
}
