# PhoneFarm Dashboard

PhoneFarm is a local-first Windows 11 dashboard for Android device management on a USB-connected control machine. It binds to `127.0.0.1` by default, uses a single global prep queue, launches `scrcpy` per serial, and verifies each phone's own public IP from the phone side instead of substituting the PC's IP.

## Folder Layout

- `C:\PhoneFarm\config\settings.json`: local bind address, ports, ADB path, scrcpy path, and polling settings.
- `C:\PhoneFarm\config\devices.json`: serial, nickname, role, and optional parent hotspot reference.
- `C:\PhoneFarm\config\state.json`: persisted queue and device state cache.
- `C:\PhoneFarm\config\users.json`: local user accounts, password hashes, and per-device access scope.
- `C:\PhoneFarm\config\device-ip-history.json`: public IP history per device serial.
- `C:\PhoneFarm\logs\activity.log`: shared dashboard activity log.
- `C:\PhoneFarm\logs\ip-check.log`: public IP verification log.
- `C:\PhoneFarm\logs\prep-<serial>.log`: prep log per device.
- `C:\PhoneFarm\scripts\`: PowerShell helper scripts.
- `C:\PhoneFarm\web\`: browser UI assets.

## Start / Stop / Health

```powershell
cd C:\PhoneFarm
.\deploy-phonefarm.ps1
.\start-phonefarm.ps1
.\scripts\healthcheck-phonefarm.ps1
.\stop-phonefarm.ps1
.\scripts\restart-adb.ps1
```

Local dashboard URL:

```text
http://127.0.0.1:7780
```

## Required Tools

- Node.js
- Android SDK Platform Tools (`adb.exe`)
- `scrcpy`

If `adb.exe` or `scrcpy.exe` are not on `PATH`, PhoneFarm uses the explicit paths in `C:\PhoneFarm\config\settings.json`.

Fresh machine bootstrap:

```powershell
git clone https://github.com/evergreentechnologywy/phonefarm-dashboard.git C:\PhoneFarm
cd C:\PhoneFarm
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy-phonefarm.ps1
```

`deploy-phonefarm.ps1` installs Node LTS, Platform Tools, and `scrcpy` with `winget`, resolves the installed binary locations, updates `settings.json`, runs a healthcheck, and starts the dashboard.

## Device Metadata Model

`C:\PhoneFarm\config\devices.json` stores the local per-device metadata used by the dashboard:

```json
{
  "devices": [
    {
      "serial": "DEVICE_SERIAL",
      "nickname": "Desk Phone 1",
      "role": "hotspot-provider",
      "parentHotspotSerial": ""
    },
    {
      "serial": "DEVICE_SERIAL_2",
      "nickname": "Client Phone 1",
      "role": "hotspot-client",
      "parentHotspotSerial": "DEVICE_SERIAL"
    }
  ]
}
```

Supported roles:

- `hotspot-provider`
- `hotspot-client`

## Dashboard Features

Each device card shows:

- serial
- nickname
- online or offline status
- role
- prep state
- current public IP
- last checked time
- IP status: `unknown`, `verified`, `changed`, `duplicate`, `failed`

Each device card provides:

- `Open Control`
- `Prep Device`
- `Check IP`
- `Start Session`
- `Stop Session`

The dashboard also shows:

- a global prep queue panel
- recent activity
- routing safety audit status

## Authentication

- The dashboard requires login before any API access.
- Default admin user: `admin`
- Default admin password: `Daniel1099#`
- Passwords are stored as PBKDF2 hashes in `C:\PhoneFarm\config\users.json`.
- Device visibility and actions are enforced per user by serial.

Create or update a restricted operator:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\PhoneFarm\scripts\manage-phonefarm-user.ps1 `
  -Username operator1 `
  -Password 'StrongPasswordHere!' `
  -DisplayName 'Operator 1' `
  -AllowedDevices SERIAL1,SERIAL2
```

## Prep Workflow

When `Prep Device` is pressed, the backend:

1. Adds the selected serial to the global prep queue.
2. Waits until it becomes the one active prep job.
3. Runs `prep-device-session.ps1` for that serial.
4. Enables airplane mode.
5. Waits a random `25-45` seconds.
6. Disables airplane mode.
7. If the device role is `hotspot-provider`, attempts to re-enable hotspot.
8. If the device role is `hotspot-client`, waits for network recovery without trying to start hotspot.
9. Runs an automatic public IP verification from the phone's own network path.
10. Marks the device `ready` or `failed`.

Prep states:

- `idle`
- `queued`
- `preparing`
- `ready`
- `failed`

## Public IP Verification

PhoneFarm verifies each phone's own public IP without using the PC's IP as a substitute.

Behavior:

- `Check IP` runs a public IP verification for the selected serial only.
- A public IP check runs automatically after prep completes successfully.
- `Start Session` performs a fresh IP verification before marking the session running.
- Results are written to `C:\PhoneFarm\logs\ip-check.log`.
- History is written to `C:\PhoneFarm\config\device-ip-history.json`.
- Duplicate IPs across currently visible devices are flagged in the UI.
- The dashboard shows whether the IP changed since the device's last successful prep verification.

Implementation path:

- The check is device-side, not PC-side.
- `check-device-ip.ps1` calls `adb -s <serial> shell ...` for the selected phone only.
- It tries on-device HTTP clients such as `curl`, `toybox wget`, and `wget` against public IP endpoints.
- The HTTP request originates from the phone's own network path when those shell tools are available on the device.

Tradeoffs:

- This is intentionally not a PC-side IP lookup.
- Some Android builds do not ship usable shell HTTP clients. On those devices, the public IP check shows `failed`.
- If that happens, the next practical path is a small helper app on-device that can fetch and return the public IP under ADB control.

## Scripts

- `C:\PhoneFarm\start-phonefarm.ps1`
- `C:\PhoneFarm\stop-phonefarm.ps1`
- `C:\PhoneFarm\scripts\restart-adb.ps1`
- `C:\PhoneFarm\scripts\open-scrcpy-for-device.ps1`
- `C:\PhoneFarm\scripts\prep-device-session.ps1`
- `C:\PhoneFarm\scripts\check-device-ip.ps1`
- `C:\PhoneFarm\scripts\healthcheck-phonefarm.ps1`
- `C:\PhoneFarm\scripts\manage-phonefarm-user.ps1`
- `C:\PhoneFarm\scripts\audit-phonefarm-routing.ps1`

## DeviceFarmer / STF Note

DeviceFarmer is the maintained STF-compatible path, but on this host it remains a documented fallback instead of the primary runtime because:

- Docker Desktop is not installed.
- WSL2 is not installed.
- Native Windows STF deployments are fragile compared with a direct Windows `adb` + `scrcpy` stack.

Minimum fallback path:

1. Install WSL2 or Docker Desktop.
2. Run DeviceFarmer containers behind localhost-only bindings.
3. Keep PhoneFarm as the operator-facing local queue, metadata, and prep/IP layer.

## Local Security

- PhoneFarm is configured to bind to `127.0.0.1`.
- No public services are exposed by default.
- Only local scripts under `C:\PhoneFarm` are used for device actions.

## Deployment Summary

Commands run during this build:

- `winget search adb; winget search scrcpy`
- `winget install --id Google.PlatformTools --exact --accept-package-agreements --accept-source-agreements; winget install --id Genymobile.scrcpy --exact --accept-package-agreements --accept-source-agreements`
- `powershell -NoProfile -ExecutionPolicy Bypass -File C:\PhoneFarm\start-phonefarm.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File C:\PhoneFarm\stop-phonefarm.ps1`
- `powershell -NoProfile -ExecutionPolicy Bypass -File C:\PhoneFarm\scripts\healthcheck-phonefarm.ps1`
- local git init/commit/push operations for the PhoneFarm repository

Files created or updated for the final local-only build:

- `C:\PhoneFarm\package.json`
- `C:\PhoneFarm\server.js`
- `C:\PhoneFarm\README.md`
- `C:\PhoneFarm\start-phonefarm.ps1`
- `C:\PhoneFarm\stop-phonefarm.ps1`
- `C:\PhoneFarm\deploy-phonefarm.ps1`
- `C:\PhoneFarm\config\settings.json`
- `C:\PhoneFarm\config\devices.json`
- `C:\PhoneFarm\config\state.json`
- `C:\PhoneFarm\config\users.json`
- `C:\PhoneFarm\config\device-ip-history.json`
- `C:\PhoneFarm\scripts\healthcheck-phonefarm.ps1`
- `C:\PhoneFarm\scripts\open-scrcpy-for-device.ps1`
- `C:\PhoneFarm\scripts\prep-device-session.ps1`
- `C:\PhoneFarm\scripts\check-device-ip.ps1`
- `C:\PhoneFarm\scripts\restart-adb.ps1`
- `C:\PhoneFarm\web\index.html`
- `C:\PhoneFarm\web\app.js`
- `C:\PhoneFarm\web\styles.css`

Services or scheduled tasks created:

- None. PhoneFarm currently runs as a manually started local process.

Known limitations:

- Phones must appear in `adb devices -l` before the dashboard can manage them.
- Airplane mode and hotspot control vary by Android version and OEM ROM.
- Device-side public IP verification depends on shell HTTP tooling available on the phone.
- DeviceFarmer/STF is documented as a fallback path, not the active Windows runtime on this host.
