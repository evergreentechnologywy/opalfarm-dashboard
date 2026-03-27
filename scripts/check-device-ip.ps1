param(
  [Parameter(Mandatory = $true)]
  [string]$Serial,
  [string]$SettingsPath = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if (-not $SettingsPath) {
  $SettingsPath = Join-Path $root "config\settings.json"
}

function Get-Settings {
  if (Test-Path $SettingsPath) {
    return Get-Content -Raw -Path $SettingsPath | ConvertFrom-Json
  }
  return [pscustomobject]@{ adbPath = "adb" }
}

function Invoke-Adb {
  param([string[]]$Arguments)
  $output = & $script:AdbPath @Arguments 2>&1
  [pscustomobject]@{
    ExitCode = $LASTEXITCODE
    Output = ($output | Out-String).Trim()
  }
}

function Parse-PublicIp {
  param([string]$Text)
  $ipv4 = [regex]::Match($Text, '\b\d{1,3}(?:\.\d{1,3}){3}\b')
  if ($ipv4.Success) { return $ipv4.Value }
  $ipv6 = [regex]::Match($Text, '\b(?:[a-fA-F0-9]{1,4}:){2,}[a-fA-F0-9]{1,4}\b')
  if ($ipv6.Success) { return $ipv6.Value }
  return ""
}

$settings = Get-Settings
$script:AdbPath = if ($settings.adbPath) { $settings.adbPath } else { "adb" }
$attempts = @(
  @{ source = "device-curl-ipify"; args = @("-s", $Serial, "shell", "curl", "-fsSL", "https://api64.ipify.org?format=text") },
  @{ source = "device-toybox-wget-ipify"; args = @("-s", $Serial, "shell", "toybox", "wget", "-qO-", "https://api64.ipify.org?format=text") },
  @{ source = "device-wget-ifconfigme"; args = @("-s", $Serial, "shell", "wget", "-qO-", "https://ifconfig.me/ip") },
  @{ source = "device-toybox-wget-ipinfo"; args = @("-s", $Serial, "shell", "toybox", "wget", "-qO-", "https://ipinfo.io/ip") }
)

$failure = ""
foreach ($attempt in $attempts) {
  $result = Invoke-Adb -Arguments $attempt.args
  if ($result.ExitCode -ne 0) {
    $failure = $result.Output
    continue
  }

  $ip = Parse-PublicIp -Text $result.Output
  if ($ip) {
    [pscustomobject]@{
      success = $true
      ip = $ip
      source = $attempt.source
      error = ""
    } | ConvertTo-Json -Compress
    exit 0
  }

  $failure = "No public IP address detected in device-side output."
}

[pscustomobject]@{
  success = $false
  ip = ""
  source = ""
  error = if ($failure) { $failure } else { "No device-side IP method succeeded." }
} | ConvertTo-Json -Compress
exit 1
