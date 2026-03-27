param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$settingsPath = Join-Path $root "config\settings.json"
$startScript = Join-Path $root "start-phonefarm.ps1"
$stopScript = Join-Path $root "stop-phonefarm.ps1"
$ruleName = "PhoneFarm Tailscale 7780"

if (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
  throw "tailscale.exe is not installed."
}

$status = tailscale status --json | ConvertFrom-Json
if (-not $status.Self -or -not $status.Self.Online) {
  throw "Tailscale is not online on this machine."
}

$tailscaleIPv4 = $status.TailscaleIPs | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
if (-not $tailscaleIPv4) {
  throw "No Tailscale IPv4 address was found for this node."
}

if (-not (Test-Path $settingsPath)) {
  throw "settings.json not found at $settingsPath"
}

$settings = Get-Content -Raw -Path $settingsPath | ConvertFrom-Json
$settings.host = $tailscaleIPv4
$settings | ConvertTo-Json -Depth 8 | Set-Content -Path $settingsPath

$firewallUpdated = $false
try {
  $existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  if ($existingRule) {
    Remove-NetFirewallRule -DisplayName $ruleName | Out-Null
  }

  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $settings.port `
    -RemoteAddress "100.64.0.0/10" | Out-Null
  $firewallUpdated = $true
}
catch {
  Write-Warning "Could not create the Windows Firewall rule automatically: $($_.Exception.Message)"
}

powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript | Out-Null
Start-Sleep -Seconds 1
powershell -NoProfile -ExecutionPolicy Bypass -File $startScript | Out-Null

Write-Output "PhoneFarm is now bound to Tailscale IP $tailscaleIPv4 on port $($settings.port)"
Write-Output "Remote URL: http://$tailscaleIPv4`:$($settings.port)"
if ($status.Self.DNSName) {
  $dnsName = $status.Self.DNSName.TrimEnd('.')
  Write-Output "MagicDNS URL: http://$dnsName`:$($settings.port)"
}
if (-not $firewallUpdated) {
  Write-Output "Firewall rule was not created automatically. If remote access fails, add a manual inbound TCP allow rule for port $($settings.port) limited to 100.64.0.0/10."
}
