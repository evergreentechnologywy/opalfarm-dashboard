const state = {
  data: null
};

const refreshButton = document.getElementById("refreshButton");
const deviceGrid = document.getElementById("deviceGrid");
const deviceCount = document.getElementById("deviceCount");
const queueList = document.getElementById("queueList");
const activityList = document.getElementById("activityList");
const preparingBadge = document.getElementById("preparingBadge");
const template = document.getElementById("deviceCardTemplate");

refreshButton.addEventListener("click", () => refresh(true));

refresh();
setInterval(refresh, 4000);

async function refresh(showToast = false) {
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

function render() {
  const data = state.data || { devices: [], queue: [], recentActivity: [] };
  const devices = data.devices || [];
  deviceCount.textContent = `${devices.length} device${devices.length === 1 ? "" : "s"}`;
  preparingBadge.textContent = data.preparingSerial ? `Preparing ${data.preparingSerial}` : "Idle";
  preparingBadge.className = `badge ${data.preparingSerial ? "badge-preparing" : "badge-neutral"}`;

  queueList.innerHTML = "";
  if (!data.queue.length) {
    queueList.innerHTML = `<div class="queue-item">No queued prep jobs.</div>`;
  } else {
    for (const serial of data.queue) {
      const el = document.createElement("div");
      el.className = "queue-item";
      el.innerHTML = `<strong>${escapeHtml(serial)}</strong><small>Queued for preparation</small>`;
      queueList.appendChild(el);
    }
  }

  deviceGrid.innerHTML = "";
  for (const device of devices) {
    deviceGrid.appendChild(renderDevice(device));
  }

  activityList.innerHTML = "";
  const recent = (data.recentActivity || []).slice(0, 20);
  if (!recent.length) {
    activityList.innerHTML = `<div class="activity-item">No recent events.</div>`;
  } else {
    for (const event of recent) {
      const el = document.createElement("div");
      el.className = "activity-item";
      el.innerHTML = `<strong>${escapeHtml(event.category.toUpperCase())}${event.serial ? ` · ${escapeHtml(event.serial)}` : ""}</strong><div>${escapeHtml(event.message)}</div><small>${escapeHtml(new Date(event.timestamp).toLocaleString())}</small>`;
      activityList.appendChild(el);
    }
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
  const simInput = fragment.querySelector(".sim-input");
  const proxyInput = fragment.querySelector(".proxy-input");

  serial.textContent = device.serial;
  model.textContent = [device.model, device.product].filter(Boolean).join(" · ") || "Unknown model";
  statusBadge.textContent = device.online ? "Online" : "Offline";
  statusBadge.className = `badge status-badge ${device.online ? "badge-online" : "badge-offline"}`;
  prepBadge.textContent = (device.prepState || "idle").toUpperCase();
  prepBadge.className = `badge prep-badge badge-${device.prepState || "idle"}`;
  adbState.textContent = device.adbState || "unknown";
  sessionState.textContent = device.sessionState || "stopped";
  transportId.textContent = device.transportId || "-";
  simInput.value = device.sim || "";
  proxyInput.value = device.proxy || "";

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
