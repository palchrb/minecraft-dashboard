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

    // Update current world from status (no extra request needed)
    if (status.currentWorld) {
      document.getElementById("current-world").textContent = status.currentWorld;
    }
  }

  if (rcon) {
    document.getElementById("rcon-status").textContent = rcon.connected
      ? "Connected"
      : "Disconnected";
  }
}

// Slow-poll worlds and backups (every 30s)
let pollCount = 0;
function poll() {
  refreshStatus();
  pollCount++;
  if (pollCount % 3 === 0) {
    loadWorlds();
    listBackups();
    loadFirewallRules();
    loadAttempts();
  }
}

let pollTimer = setInterval(poll, 10000);
refreshStatus();

// Pause polling when tab is hidden, resume when visible
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInterval(pollTimer);
    pollTimer = null;
  } else {
    refreshStatus();
    loadWorlds();
    listBackups();
    loadFirewallRules();
    loadAttempts();
    pollTimer = setInterval(poll, 10000);
    pollCount = 0;
  }
});

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

// --- Worlds ---
async function loadWorlds() {
  const data = await api("/api/list-worlds");
  if (!data) return;

  document.getElementById("current-world").textContent = data.currentWorld || "unknown";

  const list = document.getElementById("world-list");
  if (data.worlds && data.worlds.length) {
    list.innerHTML = data.worlds
      .map(
        (w) =>
          `<li class="world-item ${w === data.currentWorld ? "world-active" : ""}">
            <span>${w}${w === data.currentWorld ? " (active)" : ""}</span>
            ${
              w !== data.currentWorld
                ? `<button onclick="switchWorld('${w}')" class="btn btn-sm btn-green">Load</button>`
                : ""
            }
          </li>`
      )
      .join("");
  } else {
    list.innerHTML = "<li>No saved worlds</li>";
  }
}

async function saveCurrentWorld() {
  const data = await api("/api/save-current");
  if (data) {
    toast(data.message || data.error || "OK");
    loadWorlds();
  }
}

async function switchWorld(name) {
  if (!confirm(`Switch to world "${name}"? Server will restart.`)) return;
  const data = await api(`/api/change-world/${encodeURIComponent(name)}`);
  if (data) toast(data.message || data.error || "OK");
}

async function createNewWorld() {
  const input = document.getElementById("new-world-name");
  const name = input.value.trim();
  if (!name) return toast("Enter a world name", "error");
  if (!confirm(`Generate new world "${name}"? Server will restart.`)) return;

  const data = await api(`/api/new-world/${encodeURIComponent(name)}`);
  if (data) toast(data.message || data.error || "OK");
  input.value = "";
}

async function uploadWorld() {
  const fileInput = document.getElementById("world-file");
  if (!fileInput.files.length) return toast("Select a .zip file first", "error");

  const formData = new FormData();
  formData.append("worldFile", fileInput.files[0]);

  toast("Uploading world...");
  const data = await api("/api/upload-world", { method: "POST", body: formData });
  if (data) {
    toast(data.message || data.error || "OK", data.success ? "success" : "error");
    fileInput.value = "";
    loadWorlds();
  }
}

loadWorlds();

// --- Backups ---
async function listBackups() {
  const data = await api("/api/list-backups");
  const list = document.getElementById("backup-list");
  if (data && data.backups) {
    list.innerHTML = data.backups.length
      ? data.backups
          .map(
            (b) =>
              `<li class="backup-item">
                <span>${b}</span>
                <button onclick="restoreBackup('${b}')" class="btn btn-sm btn-blue">Restore</button>
              </li>`
          )
          .join("")
      : "<li>No backups found</li>";
  }
}

async function restoreBackup(name) {
  if (!confirm(`Restore backup "${name}"? Server will restart.`)) return;
  const data = await api(`/api/restore-backup/${encodeURIComponent(name)}`);
  if (data) toast(data.message || data.error || "OK");
}

listBackups();

// --- Firewall ---
async function loadFirewallRules() {
  const data = await api("/api/firewall");
  const list = document.getElementById("firewall-list");
  if (data && data.rules) {
    list.innerHTML = data.rules.length
      ? data.rules
          .map(
            (r) =>
              `<li class="firewall-item">
                <span>
                  <span class="firewall-ip">${escapeHtml(r.ip)}</span>
                  <span class="firewall-meta">${escapeHtml(r.label || "")}</span>
                </span>
                <button onclick="removeFirewallIp('${escapeHtml(r.ip)}')" class="btn btn-sm btn-red">Remove</button>
              </li>`
          )
          .join("")
      : "<li>No IPs allowed</li>";
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function detectPublicIp() {
  const services = [
    "https://api.ipify.org?format=json",
    "https://api64.ipify.org?format=json",
    "https://jsonip.com",
  ];
  for (const url of services) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      const data = await res.json();
      if (data.ip) return data.ip;
    } catch { /* try next */ }
  }
  return null;
}

async function allowMyIp() {
  toast("Detecting your public IP...");
  const ip = await detectPublicIp();
  if (!ip) return toast("Could not detect your public IP. Use manual input instead.", "error");
  if (!confirm(`Allow your public IP ${ip}?`)) return;
  const data = await api("/api/firewall/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ip, label: "My IP" }),
  });
  if (data) {
    toast(data.message || data.error || "OK", data.success ? "success" : "error");
    loadFirewallRules();
  }
}

async function addFirewallIp() {
  const ip = document.getElementById("firewall-ip").value.trim();
  const label = document.getElementById("firewall-label").value.trim();
  if (!ip) return toast("Enter an IP address", "error");
  const data = await api("/api/firewall/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ip, label }),
  });
  if (data) {
    toast(data.message || data.error || "OK", data.success ? "success" : "error");
    if (data.success) {
      document.getElementById("firewall-ip").value = "";
      document.getElementById("firewall-label").value = "";
      loadFirewallRules();
    }
  }
}

async function removeFirewallIp(ip) {
  if (!confirm(`Remove ${ip} from firewall allowlist?`)) return;
  const data = await api("/api/firewall/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ip }),
  });
  if (data) {
    toast(data.message || data.error || "OK", data.success ? "success" : "error");
    loadFirewallRules();
  }
}

loadFirewallRules();

// --- Connection Attempts ---
async function loadAttempts() {
  const data = await api("/api/firewall/attempts");
  const list = document.getElementById("attempts-list");
  if (data && data.attempts) {
    list.innerHTML = data.attempts.length
      ? data.attempts
          .map(
            (a) =>
              `<li class="firewall-item">
                <span>
                  <span class="firewall-ip">${escapeHtml(a.ip)}</span>
                  <span class="firewall-meta">${escapeHtml(a.country)}${a.countryCode ? ` (${escapeHtml(a.countryCode)})` : ""} &middot; ${a.count} attempt${a.count !== 1 ? "s" : ""} &middot; ports ${a.ports.join(", ")}</span>
                </span>
                <button onclick="allowAttemptIp('${escapeHtml(a.ip)}')" class="btn btn-sm btn-green">Allow</button>
              </li>`
          )
          .join("")
      : "<li>No blocked attempts in the last 5 minutes</li>";
  }
}

async function allowAttemptIp(ip) {
  const label = prompt(`Label for ${ip} (optional):`, "");
  if (label === null) return; // cancelled
  const data = await api("/api/firewall/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ip, label }),
  });
  if (data) {
    toast(data.message || data.error || "OK", data.success ? "success" : "error");
    loadFirewallRules();
    loadAttempts();
  }
}

loadAttempts();

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
