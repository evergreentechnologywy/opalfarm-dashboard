const state = {
  data: null,
  user: null
};

const appShell = document.getElementById("appShell");
const loginShell = document.getElementById("loginShell");
const loginForm = document.getElementById("loginForm");
const loginError = document.getElementById("loginError");
const currentUser = document.getElementById("currentUser");
const logoutButton = document.getElementById("logoutButton");
const refreshButton = document.getElementById("refreshButton");
const deviceGrid = document.getElementById("deviceGrid");
const deviceCount = document.getElementById("deviceCount");
const queueList = document.getElementById("queueList");
const activityList = document.getElementById("activityList");
const preparingBadge = document.getElementById("preparingBadge");
const routingStatusBadge = document.getElementById("routingStatusBadge");
const routingSummary = document.getElementById("routingSummary");
const routingChecks = document.getElementById("routingChecks");
const template = document.getElementById("deviceCardTemplate");

loginForm.addEventListener("submit", handleLogin);
logoutButton.addEventListener("click", handleLogout);
refreshButton.addEventListener("click", () => refresh(true));

refresh();
setInterval(() => {
  if (state.user) {
    refresh();
  }
}, 4000);

async function refresh(showToast = false) {
  const meResponse = await fetch("/api/me");
  if (meResponse.status === 401) {
    state.user = null;
    state.data = null;
    render();
    return;
  }

  const mePayload = await meResponse.json();
  state.user = mePayload.user;

  const response = await fetch("/api/status");
  state.data = await response.json();
  render();

  if (showToast) {
    refreshButton.textContent = "Refreshed";
    setTimeout(() => {
      refreshButton.textContent = "Refresh";
    }, 800);
  }
}

async function handleLogin(event) {
  event.preventDefault();
  loginError.textContent = "";
  const formData = new FormData(loginForm);
  const payload = {
    username: formData.get("username"),
    password: formData.get("password")
  };

  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const result = await response.json().catch(() => ({ error: "Login failed" }));
  if (!response.ok) {
    loginError.textContent = result.error || "Login failed";
    return;
  }

  loginForm.reset();
  await refresh();
}

async function handleLogout() {
  await fetch("/api/logout", { method: "POST" });
  state.user = null;
  state.data = null;
  render();
}

function render() {
  if (!state.user) {
    appShell.hidden = true;
    loginShell.hidden = false;
    return;
  }

  appShell.hidden = false;
  loginShell.hidden = true;
  currentUser.textContent = `${state.user.displayName} (${state.user.role})`;

  const data = state.data || { devices: [], queue: [], recentActivity: [] };
  renderRoutingAudit(data.routingAudit || { overallOk: false, summary: "Routing audit has not completed yet.", checks: [] });
  const devices = data.devices || [];
  deviceCount.textContent = `${devices.length} device${devices.length === 1 ? "" : "s"}`;
  preparingBadge.textContent = data.preparingSerial ? `Preparing ${data.preparingSerial}` : "Idle";
  preparingBadge.className = `badge ${data.preparingSerial ? "badge-preparing" : "badge-neutral"}`;

  queueList.innerHTML = "";
  if (!data.queue.length) {
    queueList.innerHTML = `<div class="queue-item">No queued prep jobs visible for this account.</div>`;
  } else {
    for (const serial of data.queue) {
      const el = document.createElement("div");
      el.className = "queue-item";
      el.innerHTML = `<strong>${escapeHtml(serial)}</strong><small>Queued for preparation</small>`;
      queueList.appendChild(el);
    }
  }

  deviceGrid.innerHTML = "";
  if (!devices.length) {
    deviceGrid.innerHTML = `<div class="queue-item">No devices are visible to this account yet.</div>`;
  } else {
    for (const device of devices) {
      deviceGrid.appendChild(renderDevice(device));
    }
  }

  activityList.innerHTML = "";
  const recent = (data.recentActivity || []).slice(0, 20);
  if (!recent.length) {
    activityList.innerHTML = `<div class="activity-item">No recent events visible for this account.</div>`;
  } else {
    for (const event of recent) {
      const el = document.createElement("div");
      el.className = "activity-item";
      const serialLabel = event.serial ? ` | ${escapeHtml(event.serial)}` : "";
      el.innerHTML = `<strong>${escapeHtml(event.category.toUpperCase())}${serialLabel}</strong><div>${escapeHtml(event.message)}</div><small>${escapeHtml(new Date(event.timestamp).toLocaleString())}</small>`;
      activityList.appendChild(el);
    }
  }
}

function renderRoutingAudit(audit) {
  routingSummary.textContent = audit.summary || "Routing audit has not completed yet.";
  routingStatusBadge.textContent = audit.overallOk ? "No Gateway Flags" : "Review Needed";
  routingStatusBadge.className = `badge ${audit.overallOk ? "badge-ready" : "badge-failed"}`;

  routingChecks.innerHTML = "";
  const checks = audit.checks || [];
  if (!checks.length) {
    routingChecks.innerHTML = `<div class="activity-item">No routing audit results yet.</div>`;
    return;
  }

  for (const check of checks) {
    const el = document.createElement("div");
    el.className = "activity-item";
    el.innerHTML = `<strong>${escapeHtml(check.name)}</strong><div>${escapeHtml(check.detail)}</div><small>${check.ok ? "OK" : "Needs review"}</small>`;
    routingChecks.appendChild(el);
  }
}

function renderDevice(device) {
  const fragment = template.content.cloneNode(true);
  const serial = fragment.querySelector(".serial");
  const model = fragment.querySelector(".model");
  const statusBadge = fragment.querySelector(".status-badge");
  const prepBadge = fragment.querySelector(".prep-badge");
  const adbState = fragment.querySelector(".adb-state");
  const sessionState = fragment.querySelector(".session-state");
  const transportId = fragment.querySelector(".transport-id");
  const ipAddress = fragment.querySelector(".ip-address");
  const ipMeta = fragment.querySelector(".ip-meta");
  const networkBadge = fragment.querySelector(".network-badge");
  const publicIpAddress = fragment.querySelector(".public-ip-address");
  const publicIpMeta = fragment.querySelector(".public-ip-meta");
  const publicIpBadge = fragment.querySelector(".public-ip-badge");
  const flagChanged = fragment.querySelector(".flag-changed");
  const flagDuplicate = fragment.querySelector(".flag-duplicate");
  const simInput = fragment.querySelector(".sim-input");
  const proxyInput = fragment.querySelector(".proxy-input");

  serial.textContent = device.serial;
  model.textContent = [device.model, device.product].filter(Boolean).join(" | ") || "Unknown model";
  statusBadge.textContent = device.online ? "Online" : "Offline";
  statusBadge.className = `badge status-badge ${device.online ? "badge-online" : "badge-offline"}`;
  prepBadge.textContent = (device.prepState || "idle").toUpperCase();
  prepBadge.className = `badge prep-badge badge-${device.prepState || "idle"}`;
  adbState.textContent = device.adbState || "unknown";
  sessionState.textContent = device.sessionState || "stopped";
  transportId.textContent = device.transportId || "-";
  renderNetwork(device.network || {}, ipAddress, ipMeta, networkBadge);
  renderPublicIp(device.publicIp || {}, publicIpAddress, publicIpMeta, publicIpBadge, flagChanged, flagDuplicate);
  simInput.value = device.sim || "";
  proxyInput.value = device.proxy || "";

  fragment.querySelector(".action-check-ip").addEventListener("click", () => invokeDeviceAction(device.serial, "check-ip"));
  fragment.querySelector(".action-open").addEventListener("click", () => invokeDeviceAction(device.serial, "open-control"));
  fragment.querySelector(".action-prep").addEventListener("click", () => invokeDeviceAction(device.serial, "prep"));
  fragment.querySelector(".action-start").addEventListener("click", () => invokeDeviceAction(device.serial, "start-session"));
  fragment.querySelector(".action-stop").addEventListener("click", () => invokeDeviceAction(device.serial, "stop-session"));
  fragment.querySelector(".action-save").addEventListener("click", async () => {
    await invokeDeviceAction(device.serial, "metadata", {
      sim: simInput.value,
      proxy: proxyInput.value
    });
  });

  return fragment;
}

function renderPublicIp(publicIp, addressEl, metaEl, badgeEl, changedEl, duplicateEl) {
  const status = publicIp.status || "unknown";
  const ip = publicIp.currentIp || "";
  const checkedAt = publicIp.lastCheckedAt ? new Date(publicIp.lastCheckedAt).toLocaleString() : "";
  const source = publicIp.source || "";
  const duplicateWith = publicIp.duplicateWith || [];

  addressEl.textContent = ip || "Not checked yet";
  metaEl.textContent = [
    checkedAt ? `Last checked ${checkedAt}` : "",
    source ? `Source ${source}` : "",
    publicIp.lastReason ? `Reason ${publicIp.lastReason}` : "",
    publicIp.lastError ? `Error ${publicIp.lastError}` : ""
  ].filter(Boolean).join(" | ");

  badgeEl.textContent = status.toUpperCase();
  badgeEl.className = `badge public-ip-badge ${publicIpBadgeClass(status)}`;
  changedEl.textContent = `Changed since last prep/session: ${publicIp.changedSinceLastPrep ? "Yes" : "No"}`;
  duplicateEl.textContent = `Duplicate with another active phone: ${duplicateWith.length ? `Yes (${duplicateWith.join(", ")})` : "No"}`;
}

function publicIpBadgeClass(status) {
  if (status === "verified") return "badge-ready";
  if (status === "changed") return "badge-preparing";
  if (status === "duplicate") return "badge-failed";
  if (status === "failed") return "badge-offline";
  return "badge-neutral";
}

function renderNetwork(network, ipAddress, ipMeta, networkBadge) {
  const status = network.status || "unknown";
  const ip = network.ipAddress || "";
  const iface = network.interface || "";
  const source = network.source || "";
  const checkedAt = network.checkedAt ? new Date(network.checkedAt).toLocaleTimeString() : "";

  if (status === "ok" && ip) {
    ipAddress.textContent = ip;
    ipMeta.textContent = [iface ? `Interface ${iface}` : "", source ? `Source ${source}` : "", checkedAt ? `Checked ${checkedAt}` : ""]
      .filter(Boolean)
      .join(" | ");
    networkBadge.textContent = "IP Ready";
    networkBadge.className = "badge badge-ready network-badge";
    return;
  }

  if (status === "offline") {
    ipAddress.textContent = "Device offline";
    ipMeta.textContent = checkedAt ? `Last checked ${checkedAt}` : "No network data";
    networkBadge.textContent = "Offline";
    networkBadge.className = "badge badge-offline network-badge";
    return;
  }

  if (status === "pending") {
    ipAddress.textContent = "Waiting for IP refresh";
    ipMeta.textContent = checkedAt ? `Last checked ${checkedAt}` : "Refresh pending";
    networkBadge.textContent = "Pending";
    networkBadge.className = "badge badge-neutral network-badge";
    return;
  }

  ipAddress.textContent = "IP not resolved";
  ipMeta.textContent = [source ? `Source ${source}` : "", checkedAt ? `Checked ${checkedAt}` : "Device online but no IP detected"]
    .filter(Boolean)
    .join(" | ");
  networkBadge.textContent = "Unknown";
  networkBadge.className = "badge badge-queued network-badge";
}

async function invokeDeviceAction(serial, action, body = {}) {
  const response = await fetch(`/api/devices/${encodeURIComponent(serial)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Action failed" }));
    window.alert(error.error || "Action failed");
    return;
  }

  await refresh();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
