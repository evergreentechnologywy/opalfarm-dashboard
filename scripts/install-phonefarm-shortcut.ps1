param(
  [string]$ExePath = "C:\PhoneFarm-Opal\dist\win-arm64-unpacked\OpalFarm.exe",
  [string]$ShortcutName = "OpalFarm"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $ExePath)) {
  throw "OpalFarm executable was not found at $ExePath"
}

$startMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\OpalFarm"
$shortcutPath = Join-Path $startMenuDir "$ShortcutName.lnk"

New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $ExePath
$shortcut.WorkingDirectory = Split-Path -Parent $ExePath
$shortcut.IconLocation = "$ExePath,0"
$shortcut.Description = "OpalFarm desktop app"
$shortcut.Save()

[pscustomobject]@{
  ok = $true
  shortcutPath = $shortcutPath
  exePath = $ExePath
} | ConvertTo-Json -Compress
