param(
  [Parameter(Mandatory = $true)]
  [string]$Serial
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root "config\\settings.json"
$activityLogPath = Join-Path $root "logs\\activity.log"

function Write-ActivityLog {
  param(
    [string]$Category,
    [string]$Message,
    [string]$DeviceSerial = ""
  )

  $timestamp = (Get-Date).ToString("o")
  $serialSegment = if ($DeviceSerial) { " [$DeviceSerial]" } else { "" }
  Add-Content -Path $activityLogPath -Value "[$timestamp] [$Category]$serialSegment $Message"
}

function Get-Settings {
  if (Test-Path $settingsPath) {
    return Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
  }
  return [pscustomobject]@{ scrcpyPath = "scrcpy" }
}

$settings = Get-Settings
$scrcpyPath = if ($settings.scrcpyPath) { $settings.scrcpyPath } else { "scrcpy" }

Write-ActivityLog -Category "scrcpy" -Message "Launching scrcpy window" -DeviceSerial $Serial
Start-Process -FilePath $scrcpyPath -ArgumentList @("--serial", $Serial)
