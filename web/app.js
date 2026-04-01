const state = {
  data: null,
  user: {
    username: "operator",
    displayName: "Operator",
    role: "admin",
    allowedDevices: ["*"]
  },
  viewMode: "cards",
  filters: {
    search: "",
    status: "all",
    role: "all",
    warningsOnly: false,
    readyOnly: false
  }
};
const BASE_PATH = window.location.pathname.startsWith("/phonefarm") ? "/phonefarm" : "";

const appShell = document.getElementById("appShell");
const currentUser = document.getElementById("currentUser");
const logoutButton = document.getElementById("logoutButton");
const refreshButton = document.getElementById("refreshButton");
const statsGrid = document.getElementById("statsGrid");
const deviceCount = document.getElementById("deviceCount");
const cardView = document.getElementById("cardView");
const tableView = document.getElementById("tableView");
const deviceTableBody = document.getElementById("deviceTableBody");
const queueLengthBadge = document.getElementById("queueLengthBadge");
const activePrepDevice = document.getElementById("activePrepDevice");
const activePrepCountdown = document.getElementById("activePrepCountdown");
const lastCompletedPrep = document.getElementById("lastCompletedPrep");
const lastCompletedPrepMeta = document.getElementById("lastCompletedPrepMeta");
const queueList = document.getElementById("queueList");
const activityList = document.getElementById("activityList");
const routingStatusBadge = document.getElementById("routingStatusBadge");
const routingSummary = document.getElementById("routingSummary");
const routingChecks = document.getElementById("routingChecks");
const searchInput = document.getElementById("searchInput");
const statusFilter = document.getElementById("statusFilter");
const roleFilter = document.getElementById("roleFilter");
const warningsOnlyToggle = document.getElementById("warningsOnlyToggle");
const readyOnlyToggle = document.getElementById("readyOnlyToggle");
const cardViewButton = document.getElementById("cardViewButton");
const tableViewButton = document.getElementById("tableViewButton");
const template = document.getElementById("deviceCardTemplate");
logoutButton.addEventListener("click", handleLogout);
refreshButton.addEventListener("click", () => refresh(true));
searchInput.addEventListener("input", event => {
  state.filters.search = event.target.value.trim().toLowerCase();
  render();
});
statusFilter.addEventListener("change", event => {
  state.filters.status = event.target.value;
  render();
});
roleFilter.addEventListener("change", event => {
  state.filters.role = event.target.value;
  render();
});
warningsOnlyToggle.addEventListener("change", event => {
  state.filters.warningsOnly = event.target.checked;
  render();
});
readyOnlyToggle.addEventListener("change", event => {
  state.filters.readyOnly = event.target.checked;
  render();
});
cardViewButton.addEventListener("click", () => setViewMode("cards"));
tableViewButton.addEventListener("click", () => setViewMode("table"));

render();
refresh();
setInterval(() => {
  if (state.user) {
    refresh(false);
  }
}, 4000);

async function refresh(showToast = false) {
  try {
    const meResponse = await fetch(apiPath("/api/me"), {
      credentials: "same-origin",
      cache: "no-store"
    });
    if (meResponse.status === 401) {
      state.user = null;
      state.data = null;
      render();
      return;
    }
    if (!meResponse.ok) {
      throw new Error(`Login session check failed (${meResponse.status})`);
    }

    const mePayload = await meResponse.json();
    state.user = mePayload.user;

    const response = await fetch(apiPath("/api/status"), {
      credentials: "same-origin",
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error(`Dashboard refresh failed (${response.status})`);
    }

    state.data = await response.json();
    render();

    if (showToast) {
      refreshButton.textContent = "Refreshed";
      setTimeout(() => {
        refreshButton.textContent = "Refresh";
      }, 800);
    }
  } catch (error) {
    window.alert(error.message || "Dashboard refresh failed.");
  }
}

function setViewMode(mode) {
  state.viewMode = mode;
  cardViewButton.classList.toggle("is-active", mode === "cards");
  tableViewButton.classList.toggle("is-active", mode === "table");
  appShell.classList.toggle("table-mode", mode === "table");
  renderDeviceViews();
}

async function handleLogout() {
  await fetch(apiPath("/api/logout"), { method: "POST", credentials: "same-origin", cache: "no-store" });
  await refresh();
}

function apiPath(pathname) {
  return `${BASE_PATH}${pathname}`;
}

function render() {
  appShell.hidden = false;
  appShell.classList.toggle("table-mode", state.viewMode === "table");
  currentUser.textContent = `${state.user?.displayName || "Operator"} (${state.user?.role || "admin"})`;

  const data = state.data || { devices: [], queue: [], recentActivity: [], routingAudit: { checks: [] } };
  const visibleDevices = filterDevices(data.devices || []);

  renderSummaryStats(buildSummaryStats(data.devices || []));
  renderQueuePanel(data);
  renderActivityFeed(data.recentActivity || []);
  renderRoutingAudit(data.routingAudit || { overallOk: false, summary: "Routing audit has not completed yet.", checks: [] });

  deviceCount.textContent = `${visibleDevices.length} visible device${visibleDevices.length === 1 ? "" : "s"}`;
  renderDeviceViews(visibleDevices);
}

function buildSummaryStats(devices) {
  return [
    { label: "Total Devices", value: devices.length, tone: "neutral" },
    { label: "Online", value: devices.filter(device => device.online).length, tone: "success" },
    { label: "Queued", value: devices.filter(device => device.prepState === "queued").length, tone: "warning" },
    { label: "Preparing", value: devices.filter(device => device.prepState === "preparing").length, tone: "info" },
    { label: "Ready", value: devices.filter(device => device.prepState === "ready").length, tone: "success" },
    { label: "Failed", value: devices.filter(device => device.prepState === "failed").length, tone: "danger" },
    { label: "Duplicate IP", value: devices.filter(device => isDuplicate(device)).length, tone: devices.some(device => isDuplicate(device)) ? "danger" : "neutral" }
  ];
}

function renderSummaryStats(stats) {
  statsGrid.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const stat of stats) {
    const card = document.createElement("article");
    card.className = `stat-card tone-${stat.tone}`;
    card.innerHTML = `<span>${escapeHtml(stat.label)}</span><strong>${escapeHtml(String(stat.value))}</strong>`;
    fragment.appendChild(card);
  }
  statsGrid.appendChild(fragment);
}

function renderQueuePanel(data) {
  const queue = data.queue || [];
  queueLengthBadge.textContent = `${queue.length} queued`;
  activePrepDevice.textContent = data.preparingSerial || "Idle";
  activePrepCountdown.textContent = data.preparingSerial ? "Countdown not exposed by backend" : "No active countdown";

  const lastCompleteEvent = (data.recentActivity || []).find(event =>
    event.category === "queue" && /Prep completed|Prep failed/.test(event.message)
  );
  if (lastCompleteEvent) {
    lastCompletedPrep.textContent = lastCompleteEvent.serial || lastCompleteEvent.message;
    lastCompletedPrepMeta.textContent = `${lastCompleteEvent.message} | ${formatDateTime(lastCompleteEvent.timestamp)}`;
  } else {
    lastCompletedPrep.textContent = "No completed prep yet";
    lastCompletedPrepMeta.textContent = "Waiting for first completion";
  }

  queueList.innerHTML = "";
  if (!queue.length) {
    queueList.innerHTML = `<div class="queue-item">Queue is empty.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  queue.forEach((serial, index) => {
    const item = document.createElement("div");
    item.className = "queue-item";
    item.innerHTML = `<strong>${index + 1}. ${escapeHtml(serial)}</strong><small>Queued for global prep</small>`;
    fragment.appendChild(item);
  });
  queueList.appendChild(fragment);
}

function renderActivityFeed(events) {
  activityList.innerHTML = "";
  const visibleEvents = events.filter(isOperatorEvent).slice(0, 20);

  if (!visibleEvents.length) {
    activityList.innerHTML = `<div class="activity-item">No recent operator-visible events.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const event of visibleEvents) {
    const item = document.createElement("article");
    item.className = "activity-item";
    const serialLabel = event.serial ? ` | ${escapeHtml(event.serial)}` : "";
    item.innerHTML = `<strong>${escapeHtml(event.category.toUpperCase())}${serialLabel}</strong><div>${escapeHtml(event.message)}</div><small>${escapeHtml(formatDateTime(event.timestamp))}</small>`;
    fragment.appendChild(item);
  }
  activityList.appendChild(fragment);
}

function renderRoutingAudit(audit) {
  routingSummary.textContent = audit.summary || "Routing audit has not completed yet.";
  routingStatusBadge.textContent = audit.overallOk ? "Separated" : "Review Needed";
  routingStatusBadge.className = `badge ${audit.overallOk ? "badge-ready" : "badge-failed"}`;

  routingChecks.innerHTML = "";
  const checks = audit.checks || [];
  if (!checks.length) {
    routingChecks.innerHTML = `<div class="activity-item">No routing audit results yet.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const check of checks) {
    const item = document.createElement("article");
    item.className = "activity-item";
    item.innerHTML = `<strong>${escapeHtml(check.name)}</strong><div>${escapeHtml(check.detail)}</div><small>${check.ok ? "OK" : "Needs review"}</small>`;
    fragment.appendChild(item);
  }
  routingChecks.appendChild(fragment);
}

function renderDeviceViews(devices = filterDevices((state.data?.devices) || [])) {
  cardView.hidden = state.viewMode !== "cards";
  tableView.hidden = state.viewMode !== "table";
  if (state.viewMode === "cards") {
    renderCardView(devices);
    tableView.hidden = true;
  } else {
    renderTableView(devices);
    cardView.hidden = true;
  }
}

function renderCardView(devices) {
  cardView.innerHTML = "";
  if (!devices.length) {
    cardView.innerHTML = `<div class="empty-state">No devices match the current filters.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const device of devices) {
    fragment.appendChild(renderDeviceCard(device));
  }
  cardView.appendChild(fragment);
}

function renderTableView(devices) {
  deviceTableBody.innerHTML = "";
  if (!devices.length) {
    deviceTableBody.innerHTML = `<tr><td colspan="11" class="table-empty">No devices match the current filters.</td></tr>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const device of devices) {
    const row = document.createElement("tr");
    row.className = `table-row prep-${device.prepState || "idle"}`;
    row.innerHTML = `
      <td>
        <div class="table-device-cell">
          <strong>${escapeHtml(formatDeviceName(device))}</strong>
          <small>${escapeHtml(device.serial)}</small>
        </div>
      </td>
      <td>${escapeHtml(device.serial)}</td>
      <td>${renderBadgeMarkup(device.online ? "Online" : "Offline", device.online ? "badge-online" : "badge-offline")}</td>
      <td>${renderBadgeMarkup(formatRole(device.role), "badge-neutral")}</td>
      <td>${renderBadgeMarkup(formatSession(device.sessionState), sessionBadgeClass(device.sessionState))}</td>
      <td>${renderBadgeMarkup((device.prepState || "idle").toUpperCase(), prepBadgeClass(device.prepState))}</td>
      <td>${escapeHtml(formatGmail(device.account))}</td>
      <td>${escapeHtml(device.publicIp?.currentIp || "Not checked")}</td>
      <td>${escapeHtml(device.publicIp?.lastCheckedAt ? formatDateTime(device.publicIp.lastCheckedAt) : "-")}</td>
      <td>${escapeHtml(deviceWarningLabel(device))}</td>
      <td>
        <div class="table-actions">
          <button class="table-action" data-action="open-control">Open Control</button>
          <button class="table-action table-action-primary" data-action="prep">Prep Device</button>
          <button class="table-action" data-action="engage-airplane">Engage Airplane</button>
          <button class="table-action" data-action="recover-radios">Recover Radios</button>
          <button class="table-action" data-action="check-ip">Check IP</button>
          <button class="table-action" data-action="start-session">Start Session</button>
          <button class="table-action" data-action="stop-session">Stop Session</button>
        </div>
      </td>
    `;

    row.querySelectorAll("[data-action]").forEach(button => {
      if (button.dataset.action === "prep" && isPrepBlocked(device)) {
        button.disabled = true;
      }
      button.addEventListener("click", () => invokeDeviceAction(device.serial, button.dataset.action));
    });

    fragment.appendChild(row);
  }
  deviceTableBody.appendChild(fragment);
}

function renderDeviceCard(device) {
  const fragment = template.content.cloneNode(true);
  const root = fragment.querySelector(".device-card");
  const kicker = fragment.querySelector(".device-kicker");
  const name = fragment.querySelector(".device-name");
  const serial = fragment.querySelector(".device-serial");
  const statusBadge = fragment.querySelector(".status-badge");
  const roleBadge = fragment.querySelector(".role-badge");
  const prepBadge = fragment.querySelector(".prep-badge");
  const duplicateBadge = fragment.querySelector(".duplicate-badge");
  const reuseBadge = fragment.querySelector(".reuse-badge");
  const gmailValue = fragment.querySelector(".gmail-value");
  const publicIpValue = fragment.querySelector(".public-ip-value");
  const lastCheckedValue = fragment.querySelector(".last-checked-value");
  const ipStatusValue = fragment.querySelector(".ip-status-value");
  const sessionValue = fragment.querySelector(".session-value");
  const transportValue = fragment.querySelector(".transport-value");
  const changedState = fragment.querySelector(".state-changed");
  const duplicateState = fragment.querySelector(".state-duplicate");
  const prepMessageState = fragment.querySelector(".state-prep-message");
  const prepButton = fragment.querySelector(".action-prep");

  kicker.textContent = device.phoneNumber ? `Device ${String(device.phoneNumber).padStart(2, "0")}` : "Device";
  name.textContent = formatDeviceName(device);
  serial.textContent = device.serial;
  statusBadge.textContent = device.online ? "Online" : "Offline";
  statusBadge.className = `badge status-badge ${device.online ? "badge-online" : "badge-offline"}`;
  roleBadge.textContent = formatRole(device.role);
  roleBadge.className = "badge role-badge badge-neutral";
  prepBadge.textContent = (device.prepState || "idle").toUpperCase();
  prepBadge.className = `badge prep-badge ${prepBadgeClass(device.prepState)}`;
  gmailValue.textContent = formatGmail(device.account);
  publicIpValue.textContent = device.publicIp?.currentIp || "Not checked";
  lastCheckedValue.textContent = device.publicIp?.lastCheckedAt ? formatDateTime(device.publicIp.lastCheckedAt) : "-";
  ipStatusValue.textContent = (device.publicIp?.status || "unknown").toUpperCase();
  sessionValue.textContent = formatSession(device.sessionState);
  transportValue.textContent = device.transportId || device.serial;
  changedState.textContent = `Changed since last prep/session: ${device.publicIp?.changedSinceLastPrep ? "Yes" : "No"}`;
  duplicateState.textContent = `IP warning: ${deviceWarningLabel(device)}`;
  prepMessageState.textContent = device.prepMessage || "No prep message";
  duplicateBadge.hidden = !isDuplicate(device);
  reuseBadge.hidden = !isReused(device);

  root.classList.add(`prep-${device.prepState || "idle"}`);
  if (device.prepState === "preparing") root.classList.add("is-preparing");
  if (device.prepState === "failed") root.classList.add("is-failed");
  prepButton.disabled = isPrepBlocked(device);

  fragment.querySelector(".action-open").addEventListener("click", () => invokeDeviceAction(device.serial, "open-control"));
  fragment.querySelector(".action-prep").addEventListener("click", () => invokeDeviceAction(device.serial, "prep"));
  fragment.querySelector(".action-airplane").addEventListener("click", () => invokeDeviceAction(device.serial, "engage-airplane"));
  fragment.querySelector(".action-recover").addEventListener("click", () => invokeDeviceAction(device.serial, "recover-radios"));
  fragment.querySelector(".action-check-ip").addEventListener("click", () => invokeDeviceAction(device.serial, "check-ip"));
  fragment.querySelector(".action-start").addEventListener("click", () => invokeDeviceAction(device.serial, "start-session"));
  fragment.querySelector(".action-stop").addEventListener("click", () => invokeDeviceAction(device.serial, "stop-session"));

  return fragment;
}

function filterDevices(devices) {
  return devices.filter(device => {
    const searchTarget = `${device.nickname || ""} ${device.serial} ${device.phoneNumber || ""} ${formatGmail(device.account)}`.toLowerCase();
    const statusMatch =
      state.filters.status === "all" ||
      (state.filters.status === "online" && device.online) ||
      (state.filters.status === "offline" && !device.online) ||
      device.prepState === state.filters.status;
    const roleMatch = state.filters.role === "all" || (device.role || "sim-direct") === state.filters.role;
    const warningsMatch = !state.filters.warningsOnly || hasWarning(device);
    const readyMatch = !state.filters.readyOnly || device.prepState === "ready";
    const searchMatch = !state.filters.search || searchTarget.includes(state.filters.search);
    return statusMatch && roleMatch && warningsMatch && readyMatch && searchMatch;
  });
}

function hasWarning(device) {
  return isDuplicate(device) || isReused(device) || device.prepState === "failed" || device.publicIp?.status === "failed" || device.publicIp?.status === "changed";
}

function isDuplicate(device) {
  return Boolean(device.publicIp?.duplicateWith && device.publicIp.duplicateWith.length);
}

function isReused(device) {
  return Boolean(device.publicIp?.reusedRecently);
}

function isPrepBlocked(device) {
  return device.prepState === "queued" || device.prepState === "preparing";
}

function deviceWarningLabel(device) {
  if (isDuplicate(device)) return "Duplicate IP";
  if (isReused(device)) return "Reused IP";
  if (device.publicIp?.status === "changed") return "IP Changed";
  if (device.prepState === "failed") return "Prep Failed";
  if (device.publicIp?.status === "failed") return "IP Check Failed";
  return "None";
}

function renderBadgeMarkup(label, className) {
  return `<span class="badge ${className}">${escapeHtml(label)}</span>`;
}

function prepBadgeClass(prepState) {
  if (prepState === "ready") return "badge-ready";
  if (prepState === "queued") return "badge-queued";
  if (prepState === "preparing") return "badge-preparing";
  if (prepState === "failed") return "badge-failed";
  return "badge-idle";
}

function sessionBadgeClass(sessionState) {
  if (sessionState === "running") return "badge-online";
  return "badge-idle";
}

function isOperatorEvent(event) {
  const text = `${event.category} ${event.message}`.toLowerCase();
  return ["prep started", "prep completed", "prep failed", "scrcpy", "ip-check", "duplicate", "disconnect", "queue"]
    .some(keyword => text.includes(keyword));
}

async function invokeDeviceAction(serial, action, body = {}) {
  const response = await fetch(apiPath(`/api/devices/${encodeURIComponent(serial)}/${action}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Action failed" }));
    window.alert(error.error || "Action failed");
    return;
  }

  await refresh();
}

function formatRole(role) {
  if (role === "hotspot-client") {
    return "Hotspot Client";
  }
  return "SIM Direct";
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function formatGmail(account) {
  if (account?.gmail) {
    return account.gmail;
  }
  return "Gmail not assigned";
}

function formatSession(sessionState) {
  if (sessionState === "running") {
    return "Running";
  }
  return "Stopped";
}

function formatDeviceName(device) {
  if (device.nickname) {
    return device.nickname;
  }
  if (device.phoneNumber) {
    return `Phone ${String(device.phoneNumber).padStart(2, "0")}`;
  }
  return "Unassigned Device";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
