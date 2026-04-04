const state = {
  data: null,
  user: {
    username: "operator",
    displayName: "Operator",
    role: "admin",
    allowedDevices: ["*"]
  },
  viewMode: "cards",
  pendingActions: {},
  filters: {
    search: "",
    status: "all",
    role: "all",
    warningsOnly: false,
    readyOnly: false
  },
  userLoaded: false,
  refreshInFlight: false
};

const desktopBridge = window.phoneFarmDesktop || null;

const BASE_PATH = window.location.pathname.startsWith("/phonefarm") ? "/phonefarm" : "";

const appShell = document.getElementById("appShell");
const currentUser = document.getElementById("currentUser");
const logoutButton = document.getElementById("logoutButton");
const refreshButton = document.getElementById("refreshButton");
const routeGuardBadge = document.getElementById("routeGuardBadge");
const liveClock = document.getElementById("liveClock");
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
const routingPaths = document.getElementById("routingPaths");
const routingChecks = document.getElementById("routingChecks");
const searchInput = document.getElementById("searchInput");
const statusFilter = document.getElementById("statusFilter");
const roleFilter = document.getElementById("roleFilter");
const warningsOnlyToggle = document.getElementById("warningsOnlyToggle");
const readyOnlyToggle = document.getElementById("readyOnlyToggle");
const cardViewButton = document.getElementById("cardViewButton");
const tableViewButton = document.getElementById("tableViewButton");
const contextSummary = document.getElementById("contextSummary");
const contextChips = document.getElementById("contextChips");
const template = document.getElementById("deviceCardTemplate");

let searchDebounce = 0;

logoutButton.addEventListener("click", handleLogout);
refreshButton.addEventListener("click", () => refresh(true));
searchInput.addEventListener("input", event => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.filters.search = event.target.value.trim().toLowerCase();
    render();
  }, 120);
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

setInterval(() => {
  liveClock.textContent = formatNow();
}, 1000);

async function refresh(showToast = false) {
  if (state.refreshInFlight) {
    return;
  }

  state.refreshInFlight = true;
  try {
    await ensureUserLoaded();

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
  } finally {
    state.refreshInFlight = false;
  }
}

async function ensureUserLoaded(force = false) {
  if (state.userLoaded && !force) {
    return state.user;
  }

  const meResponse = await fetch(apiPath("/api/me"), {
    credentials: "same-origin",
    cache: "no-store"
  });
  if (meResponse.status === 401) {
    state.user = null;
    state.userLoaded = false;
    state.data = null;
    render();
    throw new Error("Authentication required");
  }
  if (!meResponse.ok) {
    throw new Error(`Login session check failed (${meResponse.status})`);
  }

  const mePayload = await meResponse.json();
  state.user = mePayload.user;
  state.userLoaded = true;
  return state.user;
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
  state.userLoaded = false;
  await refresh();
}

function apiPath(pathname) {
  return `${BASE_PATH}${pathname}`;
}

function render() {
  appShell.hidden = false;
  appShell.classList.toggle("table-mode", state.viewMode === "table");
  currentUser.textContent = `${state.user?.displayName || "Operator"} (${state.user?.role || "admin"})`;
  liveClock.textContent = formatNow();

  const data = state.data || buildEmptyData();
  const visibleDevices = filterDevices(data.devices || []);

  syncControls();
  renderHeroGuard(data.routingGuard || {});
  renderSummaryStats(buildSummaryStats(data.devices || []));
  renderContextBar(data.devices || [], visibleDevices);
  renderQueuePanel(data);
  renderActivityFeed(data.recentActivity || []);
  renderRoutingAudit(data.routingAudit || { overallOk: false, summary: "Routing audit has not completed yet.", checks: [] }, data.routingGuard || {});

  deviceCount.textContent = `${visibleDevices.length} visible device${visibleDevices.length === 1 ? "" : "s"}`;
  renderDeviceViews(visibleDevices);
}

function buildEmptyData() {
  return {
    devices: [],
    queue: [],
    recentActivity: [],
    routingAudit: { overallOk: false, summary: "Routing audit has not completed yet.", checks: [] },
    routingGuard: { blocked: false, reasons: [] },
    prepTelemetry: { active: null, lastCompleted: null }
  };
}

function syncControls() {
  searchInput.value = state.filters.search ? state.filters.search : searchInput.value;
  statusFilter.value = state.filters.status;
  roleFilter.value = state.filters.role;
  warningsOnlyToggle.checked = state.filters.warningsOnly;
  readyOnlyToggle.checked = state.filters.readyOnly;
}

function renderHeroGuard(routingGuard) {
  const blocked = Boolean(routingGuard?.blocked);
  routeGuardBadge.textContent = blocked ? "Prep Guard Blocked" : "Prep Guard Clear";
  routeGuardBadge.className = `badge ${blocked ? "badge-failed" : "badge-ready"}`;
}

function buildSummaryStats(devices) {
  return [
    { label: "Total Devices", value: devices.length, tone: "neutral", onClick: () => clearQuickFilters() },
    { label: "Online", value: devices.filter(device => device.online).length, tone: "success", onClick: () => applyQuickFilter({ status: "online" }) },
    { label: "Queued", value: devices.filter(device => device.prepState === "queued").length, tone: "warning", onClick: () => applyQuickFilter({ status: "queued" }) },
    { label: "Preparing", value: devices.filter(device => device.prepState === "preparing").length, tone: "info", onClick: () => applyQuickFilter({ status: "preparing" }) },
    { label: "Ready", value: devices.filter(device => device.prepState === "ready").length, tone: "success", onClick: () => applyQuickFilter({ status: "ready", readyOnly: true }) },
    { label: "Failed", value: devices.filter(device => device.prepState === "failed").length, tone: "danger", onClick: () => applyQuickFilter({ status: "failed" }) },
    {
      label: "Duplicate IP",
      value: devices.filter(device => isDuplicate(device)).length,
      tone: devices.some(device => isDuplicate(device)) ? "danger" : "neutral",
      onClick: () => applyQuickFilter({ warningsOnly: true })
    }
  ];
}

function renderSummaryStats(stats) {
  statsGrid.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const stat of stats) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stat-card tone-${stat.tone}`;
    button.innerHTML = `<span>${escapeHtml(stat.label)}</span><strong>${escapeHtml(String(stat.value))}</strong>`;
    button.addEventListener("click", stat.onClick);
    fragment.appendChild(button);
  }
  statsGrid.appendChild(fragment);
}

function renderContextBar(allDevices, visibleDevices) {
  const hiddenCount = Math.max((allDevices || []).length - (visibleDevices || []).length, 0);
  const modeLabel = state.viewMode === "table" ? "Table view" : "Card view";
  const warningCount = (visibleDevices || []).filter(hasWarning).length;
  contextSummary.textContent = `${visibleDevices.length} visible, ${hiddenCount} filtered out, ${warningCount} with warnings, ${modeLabel.toLowerCase()}.`;

  contextChips.innerHTML = "";
  const chips = [];
  if (state.filters.search) chips.push(`Search: ${state.filters.search}`);
  if (state.filters.status !== "all") chips.push(`Status: ${state.filters.status}`);
  if (state.filters.role !== "all") chips.push(`Role: ${state.filters.role}`);
  if (state.filters.warningsOnly) chips.push("Warnings only");
  if (state.filters.readyOnly) chips.push("Ready only");
  if (!chips.length) chips.push("All devices");
  chips.push(modeLabel);

  const fragment = document.createDocumentFragment();
  for (const chipLabel of chips) {
    const chip = document.createElement("div");
    chip.className = "context-chip";
    chip.textContent = chipLabel;
    fragment.appendChild(chip);
  }
  contextChips.appendChild(fragment);
}

function applyQuickFilter(patch) {
  state.filters = {
    ...state.filters,
    ...patch
  };
  render();
}

function clearQuickFilters() {
  state.filters = {
    search: "",
    status: "all",
    role: "all",
    warningsOnly: false,
    readyOnly: false
  };
  render();
}

function renderQueuePanel(data) {
  const queue = data.queue || [];
  const prepTelemetry = data.prepTelemetry || {};
  queueLengthBadge.textContent = `${queue.length} queued`;

  if (prepTelemetry.active) {
    activePrepDevice.textContent = prepTelemetry.active.label || prepTelemetry.active.serial;
    activePrepCountdown.textContent = `Elapsed ${formatDuration(prepTelemetry.active.elapsedMs)} | Started ${formatShortTime(prepTelemetry.active.startedAt)}`;
  } else {
    activePrepDevice.textContent = "Idle";
    activePrepCountdown.textContent = "No active prep worker";
  }

  if (prepTelemetry.lastCompleted) {
    lastCompletedPrep.textContent = prepTelemetry.lastCompleted.label || prepTelemetry.lastCompleted.serial;
    lastCompletedPrepMeta.textContent = `${prepTelemetry.lastCompleted.prepState.toUpperCase()} in ${formatDuration(prepTelemetry.lastCompleted.durationMs)} | ${formatDateTime(prepTelemetry.lastCompleted.finishedAt)}`;
  } else {
    lastCompletedPrep.textContent = "No completed prep yet";
    lastCompletedPrepMeta.textContent = "Waiting for first completion";
  }

  queueList.innerHTML = "";
  if (!queue.length) {
    queueList.innerHTML = `<div class="queue-item">Queue is empty.</div>`;
    return;
  }

  const devicesBySerial = new Map((data.devices || []).map(device => [device.serial, device]));
  const fragment = document.createDocumentFragment();
  queue.forEach((serial, index) => {
    const device = devicesBySerial.get(serial);
    const item = document.createElement("div");
    item.className = "queue-item";
    const label = device ? formatDeviceName(device) : serial;
    const waitMs = device?.queueWaitMs || 0;
    item.innerHTML = `<strong>${index + 1}. ${escapeHtml(label)}</strong><small>${escapeHtml(serial)} | Waiting ${escapeHtml(formatDuration(waitMs))}</small>`;
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

function renderRoutingAudit(audit, routingGuard) {
  routingSummary.textContent = audit.summary || "Routing audit has not completed yet.";
  routingStatusBadge.textContent = routingGuard.blocked ? "Blocked" : (audit.overallOk ? "Separated" : "Review Needed");
  routingStatusBadge.className = `badge ${routingGuard.blocked ? "badge-failed" : (audit.overallOk ? "badge-ready" : "badge-queued")}`;

  routingPaths.innerHTML = "";
  const pathFragment = document.createDocumentFragment();
  for (const line of [
    routingGuard.dashboardAccessPath ? `Dashboard path: ${routingGuard.dashboardAccessPath}` : "",
    routingGuard.deviceTrafficPath ? `Device path: ${routingGuard.deviceTrafficPath}` : "",
    routingGuard.pcPublicIp ? `PC public IP: ${routingGuard.pcPublicIp}` : ""
  ].filter(Boolean)) {
    const chip = document.createElement("div");
    chip.className = "route-chip";
    chip.textContent = line;
    pathFragment.appendChild(chip);
  }
  if (routingGuard.blocked && routingGuard.reasons?.length) {
    for (const reason of routingGuard.reasons) {
      const chip = document.createElement("div");
      chip.className = "route-chip route-chip-danger";
      chip.textContent = reason;
      pathFragment.appendChild(chip);
    }
  }
  routingPaths.appendChild(pathFragment);

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
          <div class="table-subline table-subline-strong">${escapeHtml(device.transportId || device.serial)}</div>
        </div>
      </td>
      <td>
        <div class="table-stack">
          <strong class="table-code">${escapeHtml(device.serial)}</strong>
          <span class="table-subline">${escapeHtml(device.model || "Unknown model")}</span>
        </div>
      </td>
      <td>${renderBadgeMarkup(device.online ? "Online" : "Offline", device.online ? "badge-online" : "badge-offline")}</td>
      <td>${renderBadgeMarkup(formatRole(device.role), "badge-neutral")}</td>
      <td>${renderBadgeMarkup(formatSession(device.sessionState), sessionBadgeClass(device.sessionState))}</td>
      <td>${renderBadgeMarkup((device.prepState || "idle").toUpperCase(), prepBadgeClass(device.prepState))}<div class="table-subline">${escapeHtml(formatPrepTimer(device))}</div><div class="table-subline">${escapeHtml(formatViewerLaunch(device.viewerLaunch))}</div></td>
      <td>
        <div class="table-stack">
          <strong>${escapeHtml(formatGmail(device.account))}</strong>
          <span class="table-subline">${escapeHtml(device.account?.status || "unknown")}</span>
        </div>
      </td>
      <td>
        <div class="table-stack">
          <strong class="table-code">${escapeHtml(device.publicIp?.currentIp || "Not checked")}</strong>
          <span class="table-subline">${escapeHtml((device.publicIp?.status || "unknown").toUpperCase())}</span>
        </div>
      </td>
      <td>
        <div class="table-stack">
          <strong>${escapeHtml(device.publicIp?.lastCheckedAt ? formatShortTime(device.publicIp.lastCheckedAt) : "-")}</strong>
          <span class="table-subline">${escapeHtml(device.publicIp?.lastCheckedAt ? formatDateTime(device.publicIp.lastCheckedAt) : "No successful check")}</span>
        </div>
      </td>
      <td>
        <div class="table-warning ${hasWarning(device) ? "table-warning-active" : ""}">
          <strong>${escapeHtml(isReused(device) ? "Cross-device IP reuse" : (device.routingRisk?.label || deviceWarningLabel(device)))}</strong>
          <span class="table-subline">${escapeHtml(buildCompactWarning(device))}</span>
        </div>
      </td>
      <td>
        <div class="table-actions">
          ${renderTableActionButton(device, "open-control", "Open")}
          ${renderTableActionButton(device, "prep", "Prep", true)}
          ${renderTableActionButton(device, "engage-airplane", "Airplane")}
          ${renderTableActionButton(device, "recover-radios", "Recover")}
          ${renderTableActionButton(device, "check-ip", "IP")}
          ${renderTableActionButton(device, "start-session", "Start")}
          ${renderTableActionButton(device, "stop-session", "Stop")}
        </div>
      </td>
    `;

    row.querySelectorAll("[data-action]").forEach(button => {
      if (shouldDisableAction(device, button.dataset.action)) {
        button.disabled = true;
      }
      button.addEventListener("click", () => invokeDeviceAction(device.serial, button.dataset.action));
    });

    fragment.appendChild(row);
  }
  deviceTableBody.appendChild(fragment);
}

function renderTableActionButton(device, action, label, primary = false) {
  const busy = isActionPending(device.serial, action);
  const disabled = shouldDisableAction(device, action);
  return `<button class="table-action${primary ? " table-action-primary" : ""}" data-action="${escapeHtml(action)}"${disabled ? " disabled" : ""}>${escapeHtml(busy ? "Working..." : label)}</button>`;
}

function buildCompactWarning(device) {
  if (isReused(device)) {
    const count = device.publicIp?.reusedWithinLast100?.length || 0;
    return `${count} other device${count === 1 ? "" : "s"} matched this IP.`;
  }
  if (isDuplicate(device)) {
    return "Duplicate IP detected in the current set.";
  }
  if (device.prepState === "failed") {
    return device.prepMessage || "Prep failed.";
  }
  if (device.publicIp?.status === "failed") {
    return device.publicIp?.lastError || "IP check failed.";
  }
  return device.routingRisk?.detail || "No active warning.";
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
  const routeRiskValue = fragment.querySelector(".route-risk-value");
  const sessionValue = fragment.querySelector(".session-value");
  const prepTimerValue = fragment.querySelector(".prep-timer-value");
  const lastPrepValue = fragment.querySelector(".last-prep-value");
  const viewerLaunchValue = fragment.querySelector(".viewer-launch-value");
  const transportValue = fragment.querySelector(".transport-value");
  const changedState = fragment.querySelector(".state-changed");
  const duplicateState = fragment.querySelector(".state-duplicate");
  const ipHistoryState = fragment.querySelector(".state-ip-history");
  const viewerLaunchState = fragment.querySelector(".state-viewer-launch");
  const prepMessageState = fragment.querySelector(".state-prep-message");

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
  routeRiskValue.textContent = device.routingRisk?.label || "Unknown";
  sessionValue.textContent = formatSession(device.sessionState);
  prepTimerValue.textContent = formatPrepTimer(device);
  lastPrepValue.textContent = device.lastPrepDurationMs ? formatDuration(device.lastPrepDurationMs) : "No recorded prep";
  viewerLaunchValue.textContent = formatViewerLaunch(device.viewerLaunch);
  transportValue.textContent = device.transportId || device.serial;
  changedState.textContent = `Changed since last prep/session: ${device.publicIp?.changedSinceLastPrep ? "Yes" : "No"}`;
  duplicateState.textContent = buildReuseWarning(device);
  duplicateState.classList.toggle("state-pill-danger", Boolean(device.publicIp?.reusedRecently));
  ipHistoryState.textContent = buildIpHistorySummary(device);
  viewerLaunchState.textContent = buildViewerLaunchDetails(device.viewerLaunch);
  viewerLaunchState.classList.toggle("state-pill-danger", device.viewerLaunch?.status === "failed");
  prepMessageState.textContent = device.prepMessage || "No prep message";
  duplicateBadge.hidden = !isDuplicate(device);
  reuseBadge.hidden = !isReused(device);

  root.classList.add(`prep-${device.prepState || "idle"}`);
  root.classList.add(`risk-${device.routingRisk?.level || "neutral"}`);
  if (device.prepState === "preparing") root.classList.add("is-preparing");
  if (device.prepState === "failed") root.classList.add("is-failed");

  bindCardAction(fragment.querySelector(".action-open"), device, "open-control", "Open Control");
  bindCardAction(fragment.querySelector(".action-prep"), device, "prep", "Prep Device");
  bindCardAction(fragment.querySelector(".action-airplane"), device, "engage-airplane", "Engage Airplane");
  bindCardAction(fragment.querySelector(".action-recover"), device, "recover-radios", "Recover Radios");
  bindCardAction(fragment.querySelector(".action-check-ip"), device, "check-ip", "Check IP");
  bindCardAction(fragment.querySelector(".action-start"), device, "start-session", "Start Session");
  bindCardAction(fragment.querySelector(".action-stop"), device, "stop-session", "Stop Session");

  return fragment;
}

function bindCardAction(button, device, action, label) {
  const busy = isActionPending(device.serial, action);
  button.disabled = shouldDisableAction(device, action);
  button.textContent = busy ? "Working..." : label;
  button.addEventListener("click", () => invokeDeviceAction(device.serial, action));
}

function filterDevices(devices) {
  return devices.filter(device => {
    const searchTarget = `${device.nickname || ""} ${device.serial} ${device.phoneNumber || ""} ${formatGmail(device.account)} ${device.publicIp?.currentIp || ""}`.toLowerCase();
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
  return isDuplicate(device) ||
    isReused(device) ||
    device.prepState === "failed" ||
    device.publicIp?.status === "failed" ||
    device.publicIp?.status === "changed" ||
    ["critical", "warning"].includes(device.routingRisk?.level);
}

function isDuplicate(device) {
  return Boolean(device.publicIp?.duplicateWith && device.publicIp.duplicateWith.length);
}

function isReused(device) {
  return Boolean(device.publicIp?.reusedRecently);
}

function buildReuseWarning(device) {
  if (device.publicIp?.reusedRecently) {
    const count = device.publicIp?.reusedWithinLast100?.length || 0;
    return `BIG WARNING: this IP was also seen on ${count} other device${count === 1 ? "" : "s"} in the last 100 successful checks.`;
  }
  return `Route risk: ${device.routingRisk?.detail || deviceWarningLabel(device)}`;
}

function buildIpHistorySummary(device) {
  const entries = device.publicIp?.last100History || [];
  if (!entries.length) {
    return "IP monitor: no successful history yet.";
  }
  const uniqueIps = new Set(entries.map(entry => entry.ip).filter(Boolean));
  if (device.publicIp?.reusedRecently) {
    return `IP monitor: ${entries.length} successful checks tracked. Cross-device reuse detected.`;
  }
  return `IP monitor: ${entries.length} successful checks across ${uniqueIps.size} unique IPs.`;
}

function deviceWarningLabel(device) {
  if (isDuplicate(device)) return "Duplicate IP";
  if (isReused(device)) return "Reused IP";
  if (device.publicIp?.status === "changed") return "IP Changed";
  if (device.prepState === "failed") return "Prep Failed";
  if (device.publicIp?.status === "failed") return "IP Check Failed";
  return "None";
}

function shouldDisableAction(device, action) {
  if (isActionPending(device.serial, action)) return true;
  if (action === "prep") {
    return device.prepState === "queued" || device.prepState === "preparing" || Boolean(state.data?.routingGuard?.blocked);
  }
  if (action === "start-session") {
    return Boolean(state.data?.routingGuard?.blocked);
  }
  return false;
}

function isActionPending(serial, action) {
  return Boolean(state.pendingActions[`${serial}:${action}`]);
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
  return ["prep", "scrcpy", "ip-check", "duplicate", "disconnect", "queue", "session", "recover", "airplane", "routing"]
    .some(keyword => text.includes(keyword));
}

async function invokeDeviceAction(serial, action, body = {}) {
  const pendingKey = `${serial}:${action}`;
  state.pendingActions[pendingKey] = true;
  render();

  try {
    if (desktopBridge?.isDesktopApp && (action === "open-control" || action === "start-session")) {
      await invokeDesktopViewerAction(serial, action, body);
      await refresh();
      return;
    }

    const response = await fetch(apiPath(`/api/devices/${encodeURIComponent(serial)}/${action}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Action failed" }));
      throw new Error(error.error || "Action failed");
    }

    await refresh();
  } catch (error) {
    window.alert(error.message || "Action failed");
  } finally {
    delete state.pendingActions[pendingKey];
    render();
  }
}

async function invokeDesktopViewerAction(serial, action, body = {}) {
  if (action === "start-session") {
    const startResponse = await fetch(apiPath(`/api/devices/${encodeURIComponent(serial)}/start-session`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ ...body, skipViewerLaunch: true })
    });

    if (!startResponse.ok) {
      const error = await startResponse.json().catch(() => ({ error: "Session start failed" }));
      throw new Error(error.error || "Session start failed");
    }
  }

  try {
    const nativeLaunch = await desktopBridge.launchViewer(serial);
    await desktopBridge.syncViewerState({
      serial,
      sourceAction: action,
      status: nativeLaunch.fallbackViewer ? "fallback" : (nativeLaunch.windowReady ? "confirmed" : "unverified"),
      requestedAt: new Date().toISOString(),
      confirmedAt: nativeLaunch.startedAt || new Date().toISOString(),
      pid: nativeLaunch.pid || null,
      processName: nativeLaunch.processName || "",
      filePath: nativeLaunch.filePath || "",
      aliveAfterLaunch: Boolean(nativeLaunch.aliveAfterLaunch),
      windowReady: Boolean(nativeLaunch.windowReady),
      fallbackViewer: nativeLaunch.fallbackViewer || "",
      manualSelectionRequired: Boolean(nativeLaunch.manualSelectionRequired),
      lastError: nativeLaunch.fallbackViewer ? (nativeLaunch.scrcpyError || "") : ""
    });
  } catch (error) {
    if (action === "start-session") {
      await fetch(apiPath(`/api/devices/${encodeURIComponent(serial)}/stop-session`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({})
      }).catch(() => undefined);
    }
    throw error;
  }
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

function formatShortTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatNow() {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatGmail(account) {
  if (account?.gmail) {
    return account.gmail;
  }
  return "Gmail not assigned";
}

function formatSession(sessionState) {
  return sessionState === "running" ? "Running" : "Stopped";
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

function formatPrepTimer(device) {
  if (device.prepState === "preparing") {
    return `Live ${formatDuration(device.prepElapsedMs || 0)}`;
  }
  if (device.prepState === "queued") {
    return `Waiting ${formatDuration(device.queueWaitMs || 0)}`;
  }
  if (device.lastPrepDurationMs) {
    return `Last ${formatDuration(device.lastPrepDurationMs)}`;
  }
  return "Not started";
}

function formatViewerLaunch(viewerLaunch) {
  const status = viewerLaunch?.status || "unknown";
  if (status === "fallback") {
    return `Vysor Fallback${viewerLaunch?.pid ? ` PID ${viewerLaunch.pid}` : ""}`;
  }
  if (status === "confirmed") {
    return `Confirmed${viewerLaunch?.pid ? ` PID ${viewerLaunch.pid}` : ""}`;
  }
  if (status === "launching") {
    return "Launching";
  }
  if (status === "unverified") {
    return `Unverified${viewerLaunch?.pid ? ` PID ${viewerLaunch.pid}` : ""}`;
  }
  if (status === "failed") {
    return "Failed";
  }
  return "Unknown";
}

function buildViewerLaunchDetails(viewerLaunch) {
  const status = viewerLaunch?.status || "unknown";
  if (status === "fallback") {
    return `scrcpy failed, so Vysor was opened${viewerLaunch?.manualSelectionRequired ? " for manual device selection" : ""}.${viewerLaunch?.pid ? ` PID ${viewerLaunch.pid}` : ""}${viewerLaunch?.lastError ? ` | scrcpy: ${viewerLaunch.lastError}` : ""}`;
  }
  if (status === "confirmed" || status === "unverified") {
    const pidText = viewerLaunch?.pid ? `PID ${viewerLaunch.pid}` : "PID unknown";
    return `Viewer launch ${status}. ${pidText}${viewerLaunch?.filePath ? ` | ${viewerLaunch.filePath}` : ""}`;
  }
  if (status === "launching") {
    return `Viewer launch in progress since ${formatShortTime(viewerLaunch?.requestedAt)}`;
  }
  if (status === "failed") {
    return `Viewer launch failed: ${viewerLaunch?.lastError || "Unknown error"}`;
  }
  return "Viewer launch has not been tested yet.";
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round((durationMs || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
