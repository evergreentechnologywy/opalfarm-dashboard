param(
  [Parameter(Mandatory = $true)]
  [string]$Serial,

  [Parameter(Mandatory = $true)]
  [string]$Ssid,

  [string]$Password = "",
  [string]$SettingsPath = "C:\PhoneFarm-Opal\config\settings.json"
)

$ErrorActionPreference = "Stop"

function Write-Result {
  param(
    [bool]$Success,
    [string]$Message,
    [hashtable]$Extra = @{}
  )

  $payload = @{
    ok = $Success
    serial = $Serial
    ssid = $Ssid
    message = $Message
    checkedAt = [DateTime]::UtcNow.ToString("o")
  }

  foreach ($key in $Extra.Keys) {
    $payload[$key] = $Extra[$key]
  }

  $payload | ConvertTo-Json -Depth 6 -Compress
}

$settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
$adbPath = if ($settings.adbPath) { [string]$settings.adbPath } else { "adb" }

& $adbPath -s $Serial shell svc wifi enable | Out-Null
Start-Sleep -Seconds 2

$escapedSsid = '"' + $Ssid.Replace('"', '\"') + '"'
$escapedPassword = '"' + $Password.Replace('"', '\"') + '"'

$commands = @(
  "cmd wifi connect-network wpa2 $escapedSsid $escapedPassword",
  "cmd -w wifi connect-network wpa2 $escapedSsid $escapedPassword",
  "am start -a android.settings.WIFI_SETTINGS"
)

foreach ($command in $commands) {
  $output = & $adbPath -s $Serial shell $command 2>&1
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) {
    Write-Result -Success:$true -Message "Phone-side Wi-Fi connect command accepted." -Extra @{
      method = $command
      detail = [string]($output | Out-String).Trim()
    }
    exit 0
  }
}

Write-Result -Success:$false -Message "Phone-side Wi-Fi connect command could not be completed." -Extra @{
  requiresManualAssist = $true
}
exit 1
