$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root "installer\RoonPresenceSetup.cs"
$dist = Join-Path $root "dist"
$output = Join-Path $dist "RoonPresenceSetup.exe"
$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path -LiteralPath $csc)) {
  throw "Could not find csc.exe at $csc"
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null
& $csc /nologo /target:exe /platform:anycpu /out:$output $source
Write-Host "Built $output"
