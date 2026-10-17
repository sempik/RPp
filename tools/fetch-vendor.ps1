# Downloads the third-party binaries into vendor\ and checks them against pinned SHA-256 hashes.
# Used by the GitHub Actions release build and for local builds.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root   = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $Root 'vendor'
New-Item -ItemType Directory -Force $Vendor | Out-Null

# Electron: hash from the official SHASUMS256.txt of v44.8.0
# FFmpeg essentials 9.0.2 (gyan.dev): hash of the release zip and of the ffmpeg.exe inside it
# rcedit v2.0.0 (electron/rcedit)
$Deps = @{
    electron = @{ Url = 'https://github.com/electron/electron/releases/download/v44.8.0/electron-v44.8.0-win32-x64.zip'
                  Sha = '1c9319bab793492715f7668e0be0e6a30bf2a8577275e40035bd33601bf6f573' }
    ffmpeg   = @{ Url = 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip'
                  Sha = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba'
                  ExeSha = '3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec' }
    rcedit   = @{ Url = 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe'
                  Sha = '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a' }
}

function Get-Verified([string]$url, [string]$sha, [string]$out) {
    if (-not ((Test-Path $out) -and (Get-FileHash $out -Algorithm SHA256).Hash -eq $sha)) {
        Write-Host "Downloading $url"
        Invoke-WebRequest $url -OutFile $out -UseBasicParsing
    }
    $got = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $sha) { throw "SHA-256 mismatch for $url`n expected $sha`n got      $got" }
    Write-Host "OK  $(Split-Path $out -Leaf)  $got"
}

Get-Verified $Deps.electron.Url $Deps.electron.Sha (Join-Path $Vendor 'electron.zip')
Get-Verified $Deps.rcedit.Url $Deps.rcedit.Sha (Join-Path $Vendor 'rcedit-x64.exe')

$ffExe = Join-Path $Vendor 'ffmpeg.exe'
if (-not ((Test-Path $ffExe) -and (Get-FileHash $ffExe).Hash -eq $Deps.ffmpeg.ExeSha)) {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) 'rpp-ffmpeg'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory $tmp | Out-Null
    Get-Verified $Deps.ffmpeg.Url $Deps.ffmpeg.Sha (Join-Path $tmp 'ffmpeg.zip')
    Expand-Archive (Join-Path $tmp 'ffmpeg.zip') (Join-Path $tmp 'x')
    Copy-Item (Get-ChildItem (Join-Path $tmp 'x') -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName $ffExe
    Copy-Item (Get-ChildItem (Join-Path $tmp 'x') -Recurse -Filter 'LICENSE*' | Select-Object -First 1).FullName (Join-Path $Vendor 'ffmpeg-LICENSE.txt')
    Remove-Item $tmp -Recurse -Force
}
$got = (Get-FileHash $ffExe -Algorithm SHA256).Hash.ToLower()
if ($got -ne $Deps.ffmpeg.ExeSha) { throw "ffmpeg.exe hash mismatch: $got" }
Write-Host "OK  ffmpeg.exe  $got"
