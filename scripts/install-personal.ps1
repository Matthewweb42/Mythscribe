# Builds MythScribe from the latest main and installs it on this Windows machine, for the author's
# own use (docs/PERSONAL-USE.md). Unsigned and never published; your books and settings live
# outside the install folder, so reinstalling keeps them.
#
# Run from a Windows clone (not the WSL one), in PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts\install-personal.ps1
# Windows on Arm builds arm64 by default; pass -Arch x64 on an Intel/AMD PC.

param(
  [ValidateSet('arm64', 'x64')]
  [string]$Arch = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' })
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if (Get-Process -Name 'MythScribe' -ErrorAction SilentlyContinue) {
  throw 'MythScribe is running. Close it first, then run this again.'
}

git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'git pull failed; fix the clone (local changes?) and retry.' }

npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

npm run build
if ($LASTEXITCODE -ne 0) { throw 'The build failed (typecheck or bundle); main is not installable right now.' }

npx electron-builder --win "--$Arch" --publish never
if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed.' }

$installer = Get-ChildItem dist -Filter '*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "Installing $($installer.Name) ($(git rev-parse --short HEAD))"
Start-Process -FilePath $installer.FullName -Wait

# On Windows on Arm the installer has been seen to finish without writing MythScribe.exe and its
# DLLs (2026-10-06), leaving a Start-menu shortcut that asks you to browse for the program. The
# unpacked build is the same app, so copy it over whatever the installer wrote.
$unpacked = Join-Path 'dist' "win-$Arch-unpacked"
if ($Arch -eq 'x64') { $unpacked = Join-Path 'dist' 'win-unpacked' }
$installed = Join-Path $env:LOCALAPPDATA 'Programs\MythScribe'
if ((Test-Path $installed) -and -not (Test-Path (Join-Path $installed 'MythScribe.exe'))) {
  Write-Host "The installer left out MythScribe.exe; copying the build from $unpacked"
  Copy-Item (Join-Path $unpacked '*') $installed -Recurse -Force
}
if (Test-Path (Join-Path $installed 'MythScribe.exe')) {
  Write-Host 'MythScribe is installed. Start it from the Start menu.'
} else {
  Write-Host "MythScribe.exe is not in $installed. If you chose another folder, check it is there."
}
