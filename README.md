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

## Remote Access via Tailscale

PhoneFarm remote access is supported through Tailscale for operator access only.

How it works:

- PhoneFarm itself remains bound to `127.0.0.1`.
- Tailscale publishes the dashboard to the tailnet by proxying to `http://127.0.0.1:7780`.
- This preserves the separation between operator access and phone web traffic.

Enable Tailscale access:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\PhoneFarm\scripts\enable-tailscale-access.ps1
```

Disable Tailscale access:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\PhoneFarm\scripts\disable-tailscale-access.ps1
```

Addresses to use:

- local access: `http://127.0.0.1:7780`
- Tailscale remote access: `http://surfacepro.tail50b6ba.ts.net:7780/`

How to verify phone traffic is still independent:

1. Open the `Routing Safety` panel in the dashboard.
2. Note the `PC Public IP` shown there.
3. Run `Check IP` on a phone and compare the phone-reported public IP widget.
4. Tailscale remote access must not change the phone-reported public IP.
5. If the phone public IP unexpectedly matches the PC public IP when it should be using mobile data or a provider phone path, review routing before using it.

Settings that must remain disabled to avoid leakage or routing changes:

- Tailscale exit-node mode on this PC
- Internet Connection Sharing on this PC
- PC-hosted proxying for phone browsing
- global IP forwarding on this PC

Traffic-path model:

- operator access path: `You -> Tailscale -> local PC dashboard`
- device traffic path: `Phone -> its own network -> website`

Misrouting indicators:

- the dashboard is no longer bound to `127.0.0.1`
- Tailscale is not proxying to `http://127.0.0.1:7780`
- Internet Connection Sharing becomes enabled
- the PC is configured as a Tailscale exit node
- a phone's public IP unexpectedly flips to the PC's public IP

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

- Authentication is currently disabled on this machine for direct operator access.
- The browser dashboard opens directly without a sign-in step.
- If login is re-enabled later, credentials and per-device access are stored in `C:\PhoneFarm\config\users.json`.

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
- `check-device-ip.ps1` now prefers the PhoneFarm helper app on the phone itself.
- The helper app is launched for the selected serial only and performs the HTTP request on the phone.
- The result is written locally on the phone and read back over `adb`, so the PC is not acting as the network path or as a proxy.
- If the helper app is not present, `check-device-ip.ps1` can still fall back to older device-shell methods.

Tradeoffs:

- This is intentionally not a PC-side IP lookup.
- Some phones still fail the check because their own network path is not ready or DNS is failing on-device.
- Those devices now report a phone-side failure message instead of falling back to a misleading PC-side result.

Helper app files and scripts:

- source: `C:\PhoneFarm\android\phonefarm-ip-helper\`
- APK output: `C:\PhoneFarm\config\phonefarm-ip-helper.apk`
- build script: `C:\PhoneFarm\scripts\build-phonefarm-ip-helper.ps1`
- install script: `C:\PhoneFarm\scripts\install-phonefarm-ip-helper.ps1`

## Scripts

- `C:\PhoneFarm\start-phonefarm.ps1`
- `C:\PhoneFarm\stop-phonefarm.ps1`
- `C:\PhoneFarm\scripts\restart-adb.ps1`
- `C:\PhoneFarm\scripts\open-scrcpy-for-device.ps1`
- `C:\PhoneFarm\scripts\prep-device-session.ps1`
- `C:\PhoneFarm\scripts\check-device-ip.ps1`
- `C:\PhoneFarm\scripts\build-phonefarm-ip-helper.ps1`
- `C:\PhoneFarm\scripts\install-phonefarm-ip-helper.ps1`
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
- Tailscale remote access, when enabled, is provided by Tailscale proxying to localhost.
- No public internet services are exposed by default.
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
- The helper app now provides the primary phone-side public IP path, but a device with broken phone-side DNS or no usable network still reports `failed`.
- DeviceFarmer/STF is documented as a fallback path, not the active Windows runtime on this host.

Remote access summary:

- local dashboard URL: `http://127.0.0.1:7780`
- Tailscale dashboard URL: `http://surfacepro.tail50b6ba.ts.net:7780/`
- service bind mode: localhost only
- remote access mode: Tailscale proxy to localhost
- device traffic routed through the PC: not configured and should remain disabled
