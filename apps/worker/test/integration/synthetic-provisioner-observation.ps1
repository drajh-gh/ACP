$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::ReadLine() | ConvertFrom-Json -AsHashtable
Add-Type -Path @((Join-Path $PSScriptRoot '../../native/WindowsWorkerJob.cs'), (Join-Path $PSScriptRoot '../../native/WindowsFilesystemReadLease.cs'),
  (Join-Path $PSScriptRoot '../../native/WindowsRepositoryObserver.cs'), (Join-Path $PSScriptRoot 'SyntheticDirectoryPinProbe.cs'))
if ($request.action -eq 'directory-pins') {
  $probe = [Acp.Integration.SyntheticDirectoryPinProbe]::Run([IO.Path]::GetDirectoryName($request.input.workspacePath)) | ConvertFrom-Json -AsHashtable
  if ($probe.Count -ne 6 -or @($probe.Values | Where-Object { $_ -ne $true }).Count -ne 0) { throw 'Pure directory pin proof failed' }
  [Console]::WriteLine('{"type":"result","observation":{"state":"unconfirmed"},"applied":true,"pinsDenied":true}')
  exit 0
}
$script:count = 0
$script:applied = $false
$script:pinsDenied = $false
$script:parentDenied = $false
$script:packedDenied = $false
$report = [Action[int]] {
  param($ownedPid)
  [Console]::WriteLine('{"type":"process","pid":'+$ownedPid+'}')
  $script:count++
  if ($script:count -eq 5) {
    $parent = [IO.Path]::GetDirectoryName($request.input.workspacePath)
    $packed = Join-Path $request.repository.commonGitDirectory.path 'packed-refs'
    switch ($request.action) {
      'target' { [IO.Directory]::CreateDirectory($request.input.workspacePath) | Out-Null }
      'branch' {
        $branch = Join-Path $request.repository.commonGitDirectory.path $request.input.branchRef.Replace('/', '\')
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($branch)) | Out-Null
        [IO.File]::WriteAllText($branch, $request.input.baseRevision+"`n", [Text.UTF8Encoding]::new($false))
      }
      'packed' { [IO.File]::WriteAllText($packed, $request.input.baseRevision+' '+$request.input.branchRef+"`n", [Text.UTF8Encoding]::new($false)) }
      'pins' {
        try { [IO.Directory]::Move($parent, $parent+'-moved') }
        catch [IO.IOException] { $script:parentDenied = ($_.Exception.GetBaseException().HResult -band 65535) -eq 32 }
        $script:parentDenied = $script:parentDenied -and [IO.Directory]::Exists($parent) -and -not [IO.Directory]::Exists($parent+'-moved')
        try { $file = [IO.File]::Open($packed, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite); $file.Dispose() } catch [IO.IOException] { $script:packedDenied = $true }
        $script:pinsDenied = $script:parentDenied -and $script:packedDenied
      }
      default { throw 'Unknown owned fixture action' }
    }
    $script:applied = $true
  }
}
$repository = $request.repository
$observer = [Acp.Worker.WindowsRepositoryObserver]::new($request.gitExecutable, ([DateTimeOffset]$request.deadlineAt).UtcDateTime, $report)
try {
  $json = $observer.ProvisionerTarget($repository.checkout.path,$repository.checkout.identity,$repository.commonGitDirectory.path,
    $repository.commonGitDirectory.identity,$request.input.workspacePath,$request.input.branchRef,$request.input.baseRevision,$repository.machineFingerprint)
  $observation = $json | ConvertFrom-Json -AsHashtable
} catch { $observation = @{ state = 'unconfirmed' } }
[Console]::WriteLine((@{ type = 'result'; observation = $observation; applied = $script:applied; pinsDenied = $script:pinsDenied;
  parentDenied = $script:parentDenied; packedDenied = $script:packedDenied } | ConvertTo-Json -Depth 8 -Compress))
