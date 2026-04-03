param(
  [Parameter(Mandatory = $true)]
  [string]$RustDeskPassword,

  [string]$RustDeskConfigString = "",

  [string]$RustDeskId = "",

  [string]$NodePath = "C:\Program Files\nodejs\node.exe",

  [int]$PhoneFarmPort = 7780
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ("[host] " + $Message)
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-PhoneFarmStartup {
  param(
    [string]$ResolvedNodePath
  )

  $taskName = "PhoneFarm Dashboard AutoStart"
  $existing = schtasks /Query /TN $taskName 2>$null
  if ($LASTEXITCODE -eq 0) {
    schtasks /Delete /TN $taskName /F | Out-Null
  }

  $taskCommand = ('"{0}" "{1}"' -f $ResolvedNodePath, "C:\PhoneFarm\server.js")
  schtasks /Create /TN $taskName /SC ONSTART /RL HIGHEST /TR $taskCommand /F | Out-Null
}

function Ensure-PortFirewallRule {
  param(
    [string]$DisplayName,
    [int]$Port
  )

  $existing = Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existing) {
    return
  }

  New-NetFirewallRule -DisplayName $DisplayName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
}

if (-not (Test-Admin)) {
  throw "Run this script as Administrator."
}

Write-Step "Running RustDesk host setup"
$remoteHostScript = "C:\PhoneFarm\scripts\setup-remote-host.ps1"
$remoteHostArgs = @(
  "-ExecutionPolicy", "Bypass",
  "-File", $remoteHostScript,
  "-RustDeskPassword", $RustDeskPassword
)

if ($RustDeskConfigString) {
  $remoteHostArgs += @("-RustDeskConfigString", $RustDeskConfigString)
}

if ($RustDeskId) {
  $remoteHostArgs += @("-RustDeskId", $RustDeskId)
}

& powershell.exe @remoteHostArgs
if ($LASTEXITCODE -ne 0) {
  throw "setup-remote-host.ps1 failed."
}

if (-not (Test-Path -LiteralPath $NodePath)) {
  throw "Node was not found at $NodePath"
}

Write-Step "Creating PhoneFarm dashboard startup task"
Ensure-PhoneFarmStartup -ResolvedNodePath $NodePath

Write-Step "Allowing PhoneFarm dashboard port through Windows Firewall"
Ensure-PortFirewallRule -DisplayName "PhoneFarm Dashboard TCP $PhoneFarmPort" -Port $PhoneFarmPort

Write-Step "Starting PhoneFarm dashboard"
Start-Process -FilePath $NodePath -ArgumentList "C:\PhoneFarm\server.js" -WorkingDirectory "C:\PhoneFarm" | Out-Null

Write-Host ""
Write-Host "Host PC setup completed."
Write-Host "Manual BIOS/UEFI action still required:"
Write-Host "  Set 'Restore on AC Power Loss' or equivalent to 'Power On'."
