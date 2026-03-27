param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$outputPath = Join-Path $root "config\routing-audit.json"

function New-Check {
  param(
    [string]$Name,
    [bool]$Ok,
    [string]$Detail
  )

  [pscustomobject]@{
    name = $Name
    ok = $Ok
    detail = $Detail
  }
}

$checks = @()

try {
  $tailscaleCommand = Get-Command tailscale -ErrorAction SilentlyContinue
  $tailscaleExe = if ($tailscaleCommand) { $tailscaleCommand.Source } else { "C:\Program Files\Tailscale\tailscale.exe" }
  $tailscale = & $tailscaleExe status --json | ConvertFrom-Json
  $exitNode = [bool]$tailscale.Self.ExitNode
  $checks += New-Check -Name "Tailscale Exit Node" -Ok (-not $exitNode) -Detail (if ($exitNode) { "This PC is configured as an exit node." } else { "This PC is not using exit-node mode." })
}
catch {
  $checks += New-Check -Name "Tailscale Exit Node" -Ok $true -Detail "Tailscale status unavailable; no exit-node evidence from audit."
}

try {
  $sharedAccess = Get-Service -Name SharedAccess -ErrorAction Stop
  $icsOff = $sharedAccess.Status -ne "Running"
  $checks += New-Check -Name "Internet Connection Sharing" -Ok $icsOff -Detail "SharedAccess service status: $($sharedAccess.Status)"
}
catch {
  $checks += New-Check -Name "Internet Connection Sharing" -Ok $true -Detail "SharedAccess service not present or not queryable."
}

try {
  $winHttp = netsh winhttp show proxy | Out-String
  $direct = $winHttp -match "Direct access"
  $checks += New-Check -Name "WinHTTP Proxy" -Ok $direct -Detail (($winHttp -replace '\s+', ' ').Trim())
}
catch {
  $checks += New-Check -Name "WinHTTP Proxy" -Ok $false -Detail "Could not query WinHTTP proxy state."
}

try {
  $internetSettings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
  $proxyEnabled = [int]($internetSettings.ProxyEnable | ForEach-Object { $_ }) -eq 1
  $detail = if ($proxyEnabled) { "User proxy enabled: $($internetSettings.ProxyServer)" } else { "User proxy disabled." }
  $checks += New-Check -Name "Windows User Proxy" -Ok (-not $proxyEnabled) -Detail $detail
}
catch {
  $checks += New-Check -Name "Windows User Proxy" -Ok $true -Detail "User proxy settings unavailable."
}

try {
  $tcpip = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters' -ErrorAction Stop
  $ipEnableRouter = [int]($tcpip.IPEnableRouter | ForEach-Object { $_ })
  $checks += New-Check -Name "IPv4 Forwarding" -Ok ($ipEnableRouter -eq 0) -Detail (if ($ipEnableRouter -eq 0) { "Global IP forwarding is disabled." } else { "Global IP forwarding is enabled via IPEnableRouter." })
}
catch {
  $checks += New-Check -Name "IPv4 Forwarding" -Ok $false -Detail "Could not query IPv4 forwarding state."
}

$overallOk = -not ($checks | Where-Object { -not $_.ok })
$result = [pscustomobject]@{
  checkedAt = (Get-Date).ToString("o")
  overallOk = $overallOk
  summary = if ($overallOk) { "No obvious PC gateway or proxy routing flags detected." } else { "One or more routing or proxy checks need attention." }
  checks = $checks
}

$result | ConvertTo-Json -Depth 6 | Set-Content -Path $outputPath
Write-Output $result.summary
