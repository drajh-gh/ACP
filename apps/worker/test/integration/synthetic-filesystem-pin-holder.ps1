$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$directory = $null
$file = $null
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json -AsHashtable
  Add-Type -Path (Join-Path $PSScriptRoot '../../native/WindowsFilesystemReadLease.cs')
  $directory = [Acp.Worker.WindowsFilesystemReadLease]::Directory($request.directory)
  $file = $directory.PinFile($request.leaf)
  [Console]::WriteLine('{"ready":true}')
  [Console]::ReadLine() | Out-Null
} finally {
  if ($null -ne $file) { $file.Dispose() }
  if ($null -ne $directory) { $directory.Dispose() }
}
