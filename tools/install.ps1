<#
.SYNOPSIS
  Installs the Steam Game Wall screensaver into Steam\config\uioverrides\screensavers\steam-game-wall
  and syncs the cover cache there. Re-run after editing the source to update the install;
  an existing config.json in the install is kept unless -OverwriteConfig is given.
#>
param(
    [string]$Name = 'steam-game-wall',
    [switch]$OverwriteConfig,
    [switch]$InstallTask
)
$ErrorActionPreference = 'Stop'

$src = Split-Path $PSScriptRoot -Parent
$steam = ((Get-ItemProperty 'HKCU:\Software\Valve\Steam').SteamPath) -replace '/', '\'
$dst = Join-Path $steam "config\uioverrides\screensavers\$Name"
New-Item -ItemType Directory -Force (Join-Path $dst 'tools'), (Join-Path $dst 'cache\covers') | Out-Null

if ($src -ne $dst) {
    Copy-Item (Join-Path $src '*.html'), (Join-Path $src '*.css'), (Join-Path $src '*.js') $dst -Force
    Copy-Item (Join-Path $src 'tools\*') (Join-Path $dst 'tools') -Force
    if ($OverwriteConfig -or -not (Test-Path (Join-Path $dst 'config.json'))) { Copy-Item (Join-Path $src 'config.json') $dst -Force }
    # Seed the install with already downloaded covers so it doesn't fetch them again.
    if (Test-Path (Join-Path $src 'cache\covers')) {
        robocopy (Join-Path $src 'cache\covers') (Join-Path $dst 'cache\covers') *.jpg /XO /NFL /NDL /NJH /NJS /NP | Out-Null
    }
}

$syncArgs = @{}
if ($InstallTask) { $syncArgs.InstallTask = $true }
& (Join-Path $dst 'tools\library-sync.ps1') @syncArgs
Write-Host "Installed to $dst"
Write-Host "Big Picture -> Settings -> Customization -> Screensaver -> '$Name'"
