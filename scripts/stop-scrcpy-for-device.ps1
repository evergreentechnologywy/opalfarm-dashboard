param(
  [Parameter(Mandatory = $true)]
  [string]$Serial
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
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

$escapedSerial = $Serial.Replace("'", "''")
$candidates = Get-CimInstance Win32_Process -Filter "Name = 'scrcpy.exe'" |
  Where-Object {
    $_.CommandLine -and (
      $_.CommandLine -match [regex]::Escape("--serial $Serial") -or
      $_.CommandLine -match [regex]::Escape("--serial=""$Serial""") -or
      $_.CommandLine -match [regex]::Escape("--serial `"$Serial`"")
    )
  }

if (-not $candidates) {
  Write-ActivityLog -Category "scrcpy" -Message "No scrcpy process found to stop" -DeviceSerial $Serial
  exit 0
}

foreach ($process in $candidates) {
  Stop-Process -Id $process.ProcessId -Force
  Write-ActivityLog -Category "scrcpy" -Message ("Stopped scrcpy process " + $process.ProcessId) -DeviceSerial $Serial
}

exit 0
