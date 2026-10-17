# Builds dist\RPp\ (portable app), a portable .zip and an Inno Setup installer.
# Inputs in vendor\ (see README): electron.zip (win32-x64), ffmpeg.exe, ffmpeg-LICENSE.txt, rcedit-x64.exe
param([switch]$NoInstaller)
$ErrorActionPreference = 'Stop'

$Root   = $PSScriptRoot
$Vendor = Join-Path $Root 'vendor'
$Dist   = Join-Path $Root 'dist'
$Stage  = Join-Path $Dist 'RPp'
$Ver    = (Get-Content (Join-Path $Root 'app\package.json') -Raw | ConvertFrom-Json).version
$Exe    = Join-Path $Stage 'RPp.exe'
# Windows' own bsdtar: it can read and write zip (GNU tar from Git for Windows cannot)
$Tar    = Join-Path $env:SystemRoot 'System32\tar.exe'

Write-Host "Building RPp $Ver"
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force $Stage | Out-Null

# 1. Electron runtime
& $Tar -xf (Join-Path $Vendor 'electron.zip') -C $Stage
if ($LASTEXITCODE) { throw 'Failed to unpack electron.zip' }
Rename-Item (Join-Path $Stage 'electron.exe') 'RPp.exe'
Remove-Item (Join-Path $Stage 'resources\default_app.asar') -ErrorAction SilentlyContinue
Get-ChildItem (Join-Path $Stage 'locales') -Filter *.pak | Where-Object { $_.Name -notin 'en-US.pak', 'ru.pak' } | Remove-Item

# 2. App code + ffmpeg
Copy-Item (Join-Path $Root 'app') (Join-Path $Stage 'resources\app') -Recurse
Copy-Item (Join-Path $Vendor 'ffmpeg.exe') (Join-Path $Stage 'resources\ffmpeg.exe')
Copy-Item (Join-Path $Vendor 'ffmpeg-LICENSE.txt') (Join-Path $Stage 'resources\ffmpeg-LICENSE.txt')

# 3. Exe icon and version info
& (Join-Path $Vendor 'rcedit-x64.exe') $Exe `
    --set-icon (Join-Path $Root 'app\icon.ico') `
    --set-file-version $Ver --set-product-version $Ver `
    --set-version-string ProductName 'RPp' `
    --set-version-string FileDescription 'RPp' `
    --set-version-string CompanyName 'RPp' `
    --set-version-string OriginalFilename 'RPp.exe' `
    --set-version-string InternalName 'RPp'
if ($LASTEXITCODE) { throw 'rcedit failed' }

# 4. Portable zip
$Zip = Join-Path $Dist "RPp-$Ver-portable.zip"
Remove-Item $Zip -ErrorAction SilentlyContinue
& $Tar -a -c -f $Zip -C $Dist 'RPp'
if ($LASTEXITCODE) { throw 'zip failed' }

# 5. Installer
if (-not $NoInstaller) {
    $iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
            Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $iscc) { throw 'Inno Setup not found (winget install JRSoftware.InnoSetup)' }
    & $iscc /Q "/DAppVersion=$Ver" "/DSrcDir=$Stage" "/DOutDir=$Dist" "/DRoot=$Root" (Join-Path $Root 'installer.iss')
    if ($LASTEXITCODE) { throw 'ISCC failed' }
}

Get-ChildItem $Dist -File | ForEach-Object { '{0,-40} {1,8:N1} MB' -f $_.Name, ($_.Length / 1MB) }
