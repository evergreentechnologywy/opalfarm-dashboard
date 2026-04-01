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

try {
  Write-ActivityLog -Category "scrcpy" -Message ("Launching scrcpy window via " + $scrcpyPath) -DeviceSerial $Serial
  $process = Start-Process -FilePath $scrcpyPath -ArgumentList @("--serial", $Serial) -PassThru
  Start-Sleep -Milliseconds 800
  $stillRunning = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
  $payload = [pscustomobject]@{
    ok = $true
    serial = $Serial
    pid = $process.Id
    processName = $process.ProcessName
    filePath = $scrcpyPath
    startedAt = (Get-Date).ToString("o")
    aliveAfterLaunch = [bool]$stillRunning
  }
  Write-ActivityLog -Category "scrcpy" -Message ("scrcpy launched with PID " + $process.Id + "; aliveAfterLaunch=" + [bool]$stillRunning) -DeviceSerial $Serial
  $payload | ConvertTo-Json -Compress
  exit 0
}
catch {
  $message = $_.Exception.Message
  Write-ActivityLog -Category "scrcpy" -Message ("scrcpy launch failed: " + $message) -DeviceSerial $Serial
  [pscustomobject]@{
    ok = $false
    serial = $Serial
    error = $message
    filePath = $scrcpyPath
    startedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json -Compress
  exit 1
}
