param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root "config\settings.json"
$startScript = Join-Path $root "start-phonefarm.ps1"
$stopScript = Join-Path $root "stop-phonefarm.ps1"
$ruleName = "PhoneFarm Tailscale 7780"

if (-not (Test-Path $settingsPath)) {
  throw "settings.json not found at $settingsPath"
}

$settings = Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
$settings.host = "127.0.0.1"
$settings | ConvertTo-Json -Depth 8 | Set-Content -Path $settingsPath

try {
  $existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($existingRule) {
    Remove-NetFirewallRule -DisplayName $ruleName | Out-Null
  }
}
catch {
  Write-Warning "Could not remove the Windows Firewall rule automatically: $($_.Exception.Message)"
}

powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript | Out-Null
Start-Sleep -Seconds 1
powershell -NoProfile -ExecutionPolicy Bypass -File $startScript | Out-Null

Write-Output "PhoneFarm is now back to localhost-only mode on port $($settings.port)"
Write-Output "Local URL: http://127.0.0.1`:$($settings.port)"
