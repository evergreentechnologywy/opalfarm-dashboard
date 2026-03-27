# PhoneFarm Dashboard

PhoneFarm is a local-first Windows dashboard for Android device management on a USB-connected control machine. It binds to `127.0.0.1` by default, keeps prep execution single-file through a queue, and launches `scrcpy` per-device for direct operator control.

## Folder Layout

- `C:\PhoneFarm\config\settings.json`: local settings, paths, and per-device SIM/proxy metadata.
- `C:\PhoneFarm\config\state.json`: persisted queue and device state cache.
- `C:\PhoneFarm\config\users.json`: local user accounts, password hashes, and per-device access scope.
- `C:\PhoneFarm\logs\activity.log`: shared activity log.
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

Default dashboard URL:

```text
http://127.0.0.1:7780
```

## Requirements

Install these tools on Windows:

- Node.js
- Android SDK Platform Tools (`adb.exe`)
- `scrcpy`

Update `C:\PhoneFarm\config\settings.json` if `adb` or `scrcpy` are not in `PATH`.

For a fresh machine, the preferred bootstrap is:

```powershell
git clone https://github.com/evergreentechnologywy/phonefarm-dashboard.git C:\PhoneFarm
cd C:\PhoneFarm
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy-phonefarm.ps1
```

`deploy-phonefarm.ps1` installs Node LTS, Platform Tools, and `scrcpy` with `winget`, resolves the installed binary locations, updates `config\settings.json`, runs a healthcheck, and starts the dashboard.

## Dashboard Behavior

- Device cards show serial, model, ADB state, prep state, SIM, proxy, and session state.
- `Open Control` launches `scrcpy` for the selected serial only.
- `Prep Device` always enqueues the device and never runs concurrently with another prep job.
- Prep states are `idle`, `queued`, `preparing`, `ready`, and `failed`.
- `Start Session` and `Stop Session` are explicit operator state markers stored locally.

## Authentication And Access Control

- The dashboard now requires login before any API access.
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

Create or update another admin:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\PhoneFarm\scripts\manage-phonefarm-user.ps1 `
  -Username supervisor `
  -Password 'StrongPasswordHere!' `
  -Role admin
```

## Prep Workflow

When `Prep Device` is pressed, the backend:

1. Adds the device to the queue.
2. Waits until it becomes the single active prep job.
3. Runs `prep-device-session.ps1` with the selected device serial.
4. Attempts to enable airplane mode.
5. Waits a random `25-45` seconds.
6. Attempts to disable airplane mode.
7. Attempts to re-enable hotspot.
8. Waits for the device to return online.
9. Marks the device `ready` on success or `failed` on error.

## Android Command Limitations

Airplane mode and hotspot control vary by Android version, OEM ROM, and whether the build allows shell-level connectivity commands.

- Airplane mode: the prep script tries both `cmd connectivity airplane-mode` and the global settings/broadcast path.
- Hotspot: the prep script tries `cmd connectivity tether start wifi` variants.
- If the device blocks these commands, prep fails intentionally instead of silently skipping the reset step.

This is by design. The operator sees `failed`, and the logs explain which command path was blocked.

## DeviceFarmer / STF Fallback

DeviceFarmer is the maintained STF-compatible path, but on this host it is a secondary option because:

- Docker Desktop is not installed.
- WSL2 is not installed.
- Native Windows STF deployments are fragile compared with a local Windows `adb` + `scrcpy` stack.

Minimum fallback path if STF is still required:

1. Install WSL2 or Docker Desktop.
2. Run DeviceFarmer containers behind localhost-only bindings.
3. Keep this PhoneFarm dashboard as the operator-facing layer for prep queueing and SIM/proxy metadata.
4. Use DeviceFarmer primarily for browser-based inventory/viewing if the Docker path proves stable on this hardware.

## Reboot / Recovery

- PhoneFarm is idempotent. Restarting the dashboard reuses persisted state from `config\state.json`.
- If ADB becomes unstable after USB churn, run `C:\PhoneFarm\scripts\restart-adb.ps1`.
- Logs remain in `C:\PhoneFarm\logs`.

## Local Security

- The dashboard binds to `127.0.0.1` by default.
- No public port exposure is configured.
- Only local scripts under `C:\PhoneFarm` are used for device actions.
