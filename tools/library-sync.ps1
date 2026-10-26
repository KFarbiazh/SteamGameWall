<#
.SYNOPSIS
  Builds cache/games.json + cache/covers/ for the Steam Game Wall screensaver.

.DESCRIPTION
  Owned games come from Steam's local PICS cache (appcache/packageinfo.vdf lists the
  licensed packages, appcache/appinfo.vdf gives type, name and capsule art paths).
  If library.steamApiKey is set in config.json, IPlayerService/GetOwnedGames is merged in.
  Covers (600x900) are downloaded once from the Steam CDN, falling back to Steam's local
  librarycache and, optionally, SteamGridDB. Existing covers are never re-downloaded.

.PARAMETER Force        Re-download every cover.
.PARAMETER InstallTask  Register a scheduled task that re-syncs at logon and daily.
.PARAMETER Quiet        No progress output (used by the scheduled task).
#>
param(
    [switch]$Force,
    [switch]$InstallTask,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Drawing

$Root = Split-Path $PSScriptRoot -Parent
$CacheDir = Join-Path $Root 'cache'
$CoverDir = Join-Path $CacheDir 'covers'
New-Item -ItemType Directory -Force $CoverDir | Out-Null

function Log($msg) { if (-not $Quiet) { Write-Host $msg } }

$config = Get-Content (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
$lib = $config.library
$sel = $config.selection

if ($InstallTask) {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Quiet"
    $triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME), (New-ScheduledTaskTrigger -Daily -At 4am))
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
    Register-ScheduledTask -TaskName 'SteamGameWallSync' -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null
    Log "Scheduled task 'SteamGameWallSync' registered (at logon + daily 04:00)."
}

# --- Steam install ---------------------------------------------------------------------------
$steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath
if (-not $steam -or -not (Test-Path $steam)) { throw 'Steam install not found (HKCU\Software\Valve\Steam\SteamPath).' }
$steam = $steam -replace '/', '\'

Add-Type -Path (Join-Path $PSScriptRoot 'SteamPics.cs')
$appinfo = [SteamPics]::ReadAppInfo((Join-Path $steam 'appcache\appinfo.vdf'))
$licensed = [SteamPics]::ReadPackageAppIds((Join-Path $steam 'appcache\packageinfo.vdf'))
Log "PICS cache: $($appinfo.Count) apps, $($licensed.Count) licensed app ids."

$candidates = @{}   # appid -> name
foreach ($id in $licensed) {
    if (-not $appinfo.ContainsKey($id)) { continue }
    $common = $appinfo[$id]['common']
    if (-not $common) { continue }
    if ($lib.includeTypes -notcontains [string]$common['type']) { continue }
    $candidates[[int]$id] = [string]$common['name']
}

if ($lib.steamApiKey) {
    $loginUsers = Get-Content (Join-Path $steam 'config\loginusers.vdf') -Raw
    $steamId = [regex]::Matches($loginUsers, '"(7656\d{13})"\s*\{[^}]*?"MostRecent"\s*"1"') | Select-Object -First 1 | ForEach-Object { $_.Groups[1].Value }
    if (-not $steamId) { $steamId = [regex]::Match($loginUsers, '"(7656\d{13})"').Groups[1].Value }
    try {
        $url = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=$($lib.steamApiKey)&steamid=$steamId&include_appinfo=1&include_played_free_games=1&skip_unvetted_apps=0"
        $owned = (Invoke-RestMethod $url -TimeoutSec 30).response.games
        foreach ($g in $owned) {
            $info = $appinfo[[uint32]$g.appid]
            if ($info -and $info['common'] -and $lib.includeTypes -notcontains [string]$info['common']['type']) { continue }
            if (-not $candidates.ContainsKey([int]$g.appid)) { $candidates[[int]$g.appid] = $g.name }
        }
        Log "Steam Web API: $($owned.Count) owned games merged."
    } catch { Log "Steam Web API failed, using local data only: $($_.Exception.Message)" }
}

$excludeIds = @($sel.excludeAppIds | ForEach-Object { [int]$_ })
$namePatterns = @($sel.excludeNamePatterns)
$games = $candidates.GetEnumerator() | Where-Object {
    $n = $_.Value
    ($excludeIds -notcontains $_.Key) -and -not ($namePatterns | Where-Object { $n -match $_ })
} | Sort-Object Key

# Only games with real portrait art. Without common/library_assets_full/library_capsule the
# CDN serves Steam's auto-generated fill-in (horizontal header pasted over its own blur).
$noArt = @($games | Where-Object {
    $info = $appinfo[[uint32]$_.Key]
    -not ($info -and $info['common'] -and $info['common']['library_assets_full'] -and $info['common']['library_assets_full']['library_capsule'])
})
$games = @($games | Where-Object { $noArt -notcontains $_ })
Log "Skipped $($noArt.Count) games without portrait art."

# --- Cover sources ---------------------------------------------------------------------------
$cdn = 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps'
$web = New-Object System.Net.WebClient
$web.Headers['User-Agent'] = 'SteamGameWall/1.0'

function Get-AssetPath($node) {
    if (-not $node) { return $null }
    if ($node['english']) { return [string]$node['english'] }
    foreach ($v in $node.Values) { if ($v -is [string]) { return $v } }
    return $null
}

function Get-RemoteUrls([int]$appid) {
    $urls = New-Object System.Collections.Generic.List[string]
    $info = $appinfo[[uint32]$appid]
    $capsule = if ($info -and $info['common'] -and $info['common']['library_assets_full']) { $info['common']['library_assets_full']['library_capsule'] }
    if ($capsule) {
        foreach ($k in 'image2x', 'image') { $p = Get-AssetPath $capsule[$k]; if ($p) { $urls.Add("$cdn/$appid/$p") } }
    }
    $urls.Add("$cdn/$appid/library_600x900_2x.jpg")
    $urls.Add("$cdn/$appid/library_600x900.jpg")
    return $urls | Select-Object -Unique
}

function Get-LocalCover([int]$appid) {
    $dir = Join-Path $steam "appcache\librarycache\$appid"
    if (-not (Test-Path $dir)) { return $null }
    Get-ChildItem $dir -Recurse -File -Include 'library_600x900*.jpg', 'library_capsule*.jpg' |
        Sort-Object Length -Descending | Select-Object -First 1 -ExpandProperty FullName
}

function Get-GridDbUrl([int]$appid) {
    if (-not $lib.steamGridDbKey) { return $null }
    try {
        $r = Invoke-RestMethod "https://www.steamgriddb.com/api/v2/grids/steam/${appid}?dimensions=600x900&types=static" `
            -Headers @{ Authorization = "Bearer $($lib.steamGridDbKey)" } -TimeoutSec 20
        return ($r.data | Select-Object -First 1).url
    } catch { return $null }
}

# Accept only portrait ~2:3 art of usable size.
function Test-Cover([string]$path) {
    try {
        $img = [System.Drawing.Image]::FromFile($path)
        try { $ratio = $img.Height / $img.Width; return ($img.Width -ge 200 -and $ratio -gt 1.4 -and $ratio -lt 1.6) }
        finally { $img.Dispose() }
    } catch { return $false }
}

$tmp = Join-Path $CacheDir 'download.tmp'
$result = New-Object System.Collections.Generic.List[object]
$i = 0; $fresh = 0; $missing = @()
foreach ($g in $games) {
    $i++
    $appid = $g.Key
    $file = Join-Path $CoverDir "$appid.jpg"
    if (-not $Quiet) { Write-Progress -Activity 'Syncing covers' -Status $g.Value -PercentComplete ($i * 100 / [Math]::Max(1, @($games).Count)) }

    if ($Force -or -not (Test-Path $file)) {
        $ok = $false
        foreach ($u in Get-RemoteUrls $appid) {
            try { $web.DownloadFile($u, $tmp) } catch { continue }
            if (Test-Cover $tmp) { Move-Item $tmp $file -Force; $ok = $true; break }
        }
        if (-not $ok) {
            $local = Get-LocalCover $appid
            if ($local -and (Test-Cover $local)) { Copy-Item $local $file -Force; $ok = $true }
        }
        if (-not $ok) {
            $u = Get-GridDbUrl $appid
            if ($u) {
                try { $web.DownloadFile($u, $tmp); if (Test-Cover $tmp) { Move-Item $tmp $file -Force; $ok = $true } } catch { }
            }
        }
        if (-not $ok) { $missing += $g.Value; continue }
        $fresh++
    }
    $result.Add([ordered]@{ appid = $appid; name = $g.Value; file = "cache/covers/$appid.jpg" })
}
if (Test-Path $tmp) { Remove-Item $tmp -Force }
if (-not $Quiet) { Write-Progress -Activity 'Syncing covers' -Completed }

# --- Prune: covers no longer in the library, then oldest files above the size cap --------------
$keep = @{}; foreach ($r in $result) { $keep["$($r.appid).jpg"] = $true }
Get-ChildItem $CoverDir -File | Where-Object { -not $keep[$_.Name] } | Remove-Item -Force
$capBytes = [long]$lib.maxCacheMB * 1MB
$files = Get-ChildItem $CoverDir -File | Sort-Object LastWriteTime -Descending
$total = 0; $dropped = @{}
foreach ($f in $files) { $total += $f.Length; if ($capBytes -gt 0 -and $total -gt $capBytes) { $dropped[$f.Name] = $true; Remove-Item $f.FullName -Force } }
$final = @($result | Where-Object { -not $dropped["$($_.appid).jpg"] })

$doc = [ordered]@{ generated = (Get-Date).ToString('o'); count = $final.Count; games = $final }
$json = $doc | ConvertTo-Json -Depth 4 -Compress
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $CacheDir 'games.json'), $json, $utf8)
[IO.File]::WriteAllText((Join-Path $CacheDir 'games.js'), "window.__LIBRARY__=$json;", $utf8)

Log "Library: $($final.Count) games with covers ($fresh new). Skipped without art: $($missing.Count)."
if ($missing.Count -and -not $Quiet) { Log ('  ' + ($missing -join '; ')) }
