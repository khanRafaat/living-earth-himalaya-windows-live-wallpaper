# Packs the wallpaper page into page.zip for build.cmd, which puts it inside the exe.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$zipPath = Join-Path $PSScriptRoot 'page.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
$files = @('index.html', 'host/banner.jpg') | ForEach-Object { Get-Item (Join-Path $root $_) }
$files += Get-ChildItem (Join-Path $root 'src') -Recurse -File
# the stills for the Windows background (stills.mjs renders them)
$stills = Join-Path $root 'host/stills'
if (Test-Path $stills) { $files += Get-ChildItem $stills -Filter *.jpg -File }
$zip = [IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($root.Length + 1).Replace('\', '/')
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $rel, 'Optimal')
  }
} finally { $zip.Dispose() }
