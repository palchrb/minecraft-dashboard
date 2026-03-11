const API = window.location.origin;

function toast(msg, type = "success") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast show ${type}`;
  setTimeout(() => (el.className = "toast"), 3000);
}

async function api(path, opts) {
  try {
    const res = await fetch(`${API}${path}`, opts);
    return await res.json();
  } catch (err) {
    toast(err.message, "error");
    return null;
  }
}

// --- Status polling ---
async function refreshStatus() {
  const [status, rcon] = await Promise.all([
    api("/api/status"),
    api("/api/rcon-status"),
  ]);

  if (status) {
    const badge = document.getElementById("status-badge");
    const isOnline = status.status === "started";
    badge.textContent = isOnline ? "Online" : "Offline";
    badge.className = `badge ${isOnline ? "badge-online" : "badge-offline"}`;

    document.getElementById("server-status").textContent = isOnline
      ? "Running"
      : "Stopped";
    document.getElementById("player-count").textContent = status.online;

    const list = document.getElementById("player-list");
    list.innerHTML = status.players
      .map((p) => `<span class="player-tag">${p}</span>`)
      .join("");
  }

  if (rcon) {
    document.getElementById("rcon-status").textContent = rcon.connected
      ? "Connected"
      : "Disconnected";
  }
}

setInterval(refreshStatus, 10000);
refreshStatus();

// --- Server actions ---
async function serverAction(action) {
  const data = await api(`/api/${action}`);
  if (data) toast(data.message || data.error || "OK");
}

// --- Gamemode ---
async function setGamemode(mode) {
  const data = await api(`/api/gamemode-all/${mode}`);
  if (data) toast(data.message || data.error || "OK");
}

// --- RCON command ---
async function sendCommand() {
  const input = document.getElementById("rcon-cmd");
  const cmd = input.value.trim();
  if (!cmd) return;

  const data = await api(`/api/command/${encodeURIComponent(cmd)}`);
  const output = document.getElementById("cmd-output");
  if (data) {
    output.textContent = data.response || data.error || JSON.stringify(data);
    output.classList.add("visible");
  }
  input.value = "";
}

// --- Whitelist ---
async function whitelistAction(action) {
  const player = document.getElementById("whitelist-player").value.trim();
  if (!player) return toast("Enter a player name", "error");

  const data = await api(`/api/whitelist/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player }),
  });
  if (data) toast(data.response || data.error || "OK");
}

async function showWhitelist() {
  const data = await api("/api/whitelist");
  const output = document.getElementById("whitelist-output");
  if (data) {
    output.textContent = data.response || "No data";
    output.classList.add("visible");
  }
}

// --- OP ---
async function opAction(action) {
  const player = document.getElementById("op-player").value.trim();
  if (!player) return toast("Enter a player name", "error");

  const data = await api(`/api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player }),
  });
  if (data) toast(data.response || data.error || "OK");
}

// --- Backups ---
async function listBackups() {
  const data = await api("/api/list-backups");
  const list = document.getElementById("backup-list");
  if (data && data.backups) {
    list.innerHTML = data.backups.length
      ? data.backups.map((b) => `<li>${b}</li>`).join("")
      : "<li>No backups found</li>";
  }
}

listBackups();

// --- Logs ---
async function loadLogs() {
  const data = await api("/api/logs?lines=100");
  const output = document.getElementById("log-output");
  if (data && data.logs) {
    output.textContent = data.logs.join("\n");
    output.classList.add("visible");
    output.scrollTop = output.scrollHeight;
  }
}
