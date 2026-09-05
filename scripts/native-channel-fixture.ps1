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

# Read-only diagnostics also survive a hard child timeout. Never use manifest
# PIDs as termination authority; the outer owned job supplies empty-tree proof.
function Write-AcpNativeWriterDiagnostics([string]$OwnedRunId) {
  $manifest = Join-Path (Get-AcpNativeChannelRoot $OwnedRunId) 'workspace ž 🚀/acp-native-writer-pids.json'
  try {
    $item = Get-Item -LiteralPath $manifest -ErrorAction Stop
    if ($item.Length -gt 256 -or $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid diagnostic file' }
    $ids = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json -AsHashtable
    if ($ids.Count -ne 2 -or -not $ids.ContainsKey('root') -or -not $ids.ContainsKey('child')) { throw 'Invalid diagnostic keys' }
    foreach ($role in @('root','child')) {
      if ($ids[$role] -isnot [long] -and $ids[$role] -isnot [int]) { throw 'Invalid diagnostic PID' }
      if ($ids[$role] -le 0 -or $ids[$role] -gt [int]::MaxValue) { throw 'Invalid diagnostic PID' }
      Write-Host "Owned diagnostic PID $($ids[$role]): native workspace $role writer (job-owned cleanup, not PID-only authority)"
    }
  } catch { Write-Host 'Native writer PID manifest unavailable or invalid; outer job remains cleanup authority.' }
}
