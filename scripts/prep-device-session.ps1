param(
  [Parameter(Mandatory = $true)]
  [string]$Serial,
  [string]$SettingsPath = "",
  [string]$ActivityLogPath = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if (-not $SettingsPath) {
  $SettingsPath = Join-Path $root "config\\settings.json"
}
$devicesPath = Join-Path $root "config\\devices.json"
if (-not $ActivityLogPath) {
  $ActivityLogPath = Join-Path $root "logs\\activity.log"
}
$deviceLogPath = Join-Path $root ("logs\\prep-" + $Serial + ".log")

function Write-PrepLog {
  param(
    [string]$Category,
    [string]$Message
  )

  $timestamp = (Get-Date).ToString("o")
  $line = "[$timestamp] [$Category] [$Serial] $Message"
  Add-Content -Path $ActivityLogPath -Value $line
  Add-Content -Path $deviceLogPath -Value $line
}

function Get-Settings {
  if (Test-Path $SettingsPath) {
    return Get-Content -Raw -Path $SettingsPath | ConvertFrom-Json
  }
  return [pscustomobject]@{
    adbPath = "adb"
    prep = [pscustomobject]@{
      minWaitSeconds = 25
      maxWaitSeconds = 45
      onlineTimeoutSeconds = 90
    }
  }
}

function Get-DeviceConfig {
  if (Test-Path $devicesPath) {
    $config = Get-Content -Raw -Path $devicesPath | ConvertFrom-Json
    $device = $config.devices | Where-Object { $_.serial -eq $Serial } | Select-Object -First 1
    if ($device) {
      return $device
    }
  }

  return [pscustomobject]@{
    serial = $Serial
    role = "hotspot-client"
    parentHotspotSerial = ""
  }
}

function Invoke-Adb {
  param(
    [string[]]$Arguments,
    [switch]$IgnoreErrors
  )

  $output = & $script:AdbPath @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  if (-not $IgnoreErrors -and $exitCode -ne 0) {
    throw "adb $($Arguments -join ' ') failed with exit code $exitCode. Output: $output"
  }
  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = ($output | Out-String).Trim()
  }
}

function Wait-ForDeviceOnline {
  param([int]$TimeoutSeconds)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $result = Invoke-Adb -Arguments @("-s", $Serial, "get-state") -IgnoreErrors
    if ($result.Output -match "device") {
      return
    }
    Start-Sleep -Seconds 3
  }
  throw "Device did not return online within $TimeoutSeconds seconds."
}

function Set-AirplaneMode {
  param([bool]$Enabled)

  $target = if ($Enabled) { "1" } else { "0" }
  $stateWord = if ($Enabled) { "true" } else { "false" }
  $action = if ($Enabled) { "enable" } else { "disable" }
  Write-PrepLog -Category "prep" -Message "Attempting to $action airplane mode"

  $attempts = @(
    @("shell", "cmd", "connectivity", "airplane-mode", $action),
    @("shell", "settings", "put", "global", "airplane_mode_on", $target),
    @("shell", "am", "broadcast", "-a", "android.intent.action.AIRPLANE_MODE", "--ez", "state", $stateWord)
  )

  foreach ($attempt in $attempts) {
    $result = Invoke-Adb -Arguments (@("-s", $Serial) + $attempt) -IgnoreErrors
    Write-PrepLog -Category "prep" -Message ("Airplane mode command attempt: adb " + ($attempt -join " ") + " => exit " + $result.ExitCode)
  }

  Start-Sleep -Seconds 3
  $verify = Invoke-Adb -Arguments @("-s", $Serial, "shell", "settings", "get", "global", "airplane_mode_on") -IgnoreErrors
  if ($verify.Output.Trim() -ne $target) {
    throw "Unable to verify airplane mode state $target on this device."
  }
}

function Enable-Hotspot {
  Write-PrepLog -Category "prep" -Message "Attempting to re-enable hotspot"

  $attempts = @(
    @("shell", "cmd", "connectivity", "tether", "start", "wifi"),
    @("shell", "cmd", "connectivity", "start-tethering", "wifi")
  )

  foreach ($attempt in $attempts) {
    $result = Invoke-Adb -Arguments (@("-s", $Serial) + $attempt) -IgnoreErrors
    Write-PrepLog -Category "prep" -Message ("Hotspot command attempt: adb " + ($attempt -join " ") + " => exit " + $result.ExitCode)
    if ($result.ExitCode -eq 0) {
      return
    }
  }

  throw "Unable to re-enable hotspot through ADB on this device or ROM."
}

function Wait-ForNetworkRecovery {
  param([int]$TimeoutSeconds)

  Write-PrepLog -Category "prep" -Message "Waiting for client network recovery"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $result = Invoke-Adb -Arguments @("-s", $Serial, "shell", "getprop", "sys.boot_completed") -IgnoreErrors
    $route = Invoke-Adb -Arguments @("-s", $Serial, "shell", "ip", "route") -IgnoreErrors
    if (($result.Output -match "1") -and ($route.Output -match "default|src\s+\d{1,3}(?:\.\d{1,3}){3}")) {
      return
    }
    Start-Sleep -Seconds 4
  }
  throw "Client network recovery timed out."
}

try {
  $settings = Get-Settings
  $deviceConfig = Get-DeviceConfig
  $script:AdbPath = if ($settings.adbPath) { $settings.adbPath } else { "adb" }
  $prepSettings = if ($settings.prep) { $settings.prep } else { [pscustomobject]@{ minWaitSeconds = 25; maxWaitSeconds = 45; onlineTimeoutSeconds = 90 } }
  $minWait = [int]$prepSettings.minWaitSeconds
  $maxWait = [int]$prepSettings.maxWaitSeconds
  $timeout = [int]$prepSettings.onlineTimeoutSeconds
  $randomWait = Get-Random -Minimum $minWait -Maximum ($maxWait + 1)

  Write-PrepLog -Category "prep" -Message "Prep sequence started"
  Wait-ForDeviceOnline -TimeoutSeconds $timeout
  Set-AirplaneMode -Enabled $true
  Write-PrepLog -Category "prep" -Message "Sleeping for randomized hold: $randomWait seconds"
  Start-Sleep -Seconds $randomWait
  Set-AirplaneMode -Enabled $false
  if ($deviceConfig.role -eq "hotspot-provider") {
    Enable-Hotspot
  } else {
    Write-PrepLog -Category "prep" -Message "Device role is hotspot-client; hotspot re-enable skipped"
    Wait-ForNetworkRecovery -TimeoutSeconds $timeout
  }
  Wait-ForDeviceOnline -TimeoutSeconds $timeout
  Write-PrepLog -Category "prep" -Message "Prep sequence completed successfully"
  exit 0
}
catch {
  Write-PrepLog -Category "prep" -Message ("Prep sequence failed: " + $_.Exception.Message)
  exit 1
}
