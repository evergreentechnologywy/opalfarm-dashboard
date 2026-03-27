param()

$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root "config\\settings.json"
$pidPath = Join-Path $root "phonefarm.pid"

function Get-Settings {
  if (Test-Path $settingsPath) {
    return Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
  }
  return [pscustomobject]@{
    host = "127.0.0.1"
    port = 7780
    adbPath = "adb"
    scrcpyPath = "scrcpy"
  }
}

$settings = Get-Settings
$dashboardUrl = "http://$($settings.host):$($settings.port)/api/status"
$nodePidValue = if (Test-Path $pidPath) { (Get-Content -Raw -Path $pidPath).Trim() } else { "" }
$process = $null

if ($nodePidValue) {
  $process = Get-Process -Id $nodePidValue -ErrorAction SilentlyContinue
}

$dashboardStatus = "offline"
try {
  $response = Invoke-WebRequest -Uri $dashboardUrl -UseBasicParsing -TimeoutSec 5
  if ($response.StatusCode -eq 200) {
    $dashboardStatus = "online"
  }
}
catch {
  $dashboardStatus = "offline"
}

$adbCommand = Get-Command $settings.adbPath -ErrorAction SilentlyContinue
$scrcpyCommand = Get-Command $settings.scrcpyPath -ErrorAction SilentlyContinue

[pscustomobject]@{
  DashboardUrl = $dashboardUrl
  DashboardStatus = $dashboardStatus
  NodePid = if ($process) { $process.Id } else { $null }
  NodeRunning = [bool]$process
  AdbPath = if ($adbCommand) { $adbCommand.Source } else { $settings.adbPath }
  ScrcpyPath = if ($scrcpyCommand) { $scrcpyCommand.Source } else { $settings.scrcpyPath }
}
