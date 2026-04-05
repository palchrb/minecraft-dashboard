/**
 * Minecraft Server Management API
 * Kjorer som egen Docker-container i samme stack som itzg/minecraft-server
 */

require("dotenv").config();
const express = require("express");
const { Rcon } = require("rcon-client");
const fs = require("fs-extra");
const { exec, execFile } = require("child_process");
const cors = require("cors");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const path = require("path");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const API_PORT = 3000;

// --- Konfig fra miljovariabler ---
const RCON_CONFIG = {
  host: process.env.RCON_HOST || "mc",
  port: parseInt(process.env.RCON_PORT) || 25575,
  password: process.env.RCON_PASSWORD || "changeme",
};

const MC_CONTAINER = process.env.MC_CONTAINER || "minecraft-mc-1";
const MC_LOG_FILE = process.env.MC_LOG_FILE || "/mcdata/logs/latest.log";
const BACKUPS_DIR = "/mcdata/backups";
const WORLDS_DIR = "/mcdata/worlds";
const ACTIVE_WORLD = "/mcdata/world";
const UPLOADS_DIR = "/mcdata/uploads";
const CURRENT_WORLD_TXT = "/mcdata/current-world.txt";

// --- Firewall (UFW) konfig ---
const UFW_AGENT_CONTAINER = process.env.UFW_AGENT_CONTAINER || "ufw-agent";
const FIREWALL_RULES_FILE = "/mcdata/firewall-rules.json";
const UFW_PORTS = [
  { port: "25565", proto: "tcp" }, // Java Edition
  { port: "19132", proto: "udp" }, // Bedrock Edition
  { port: "24454", proto: "udp" }, // Simple Voice Chat
];

// --- Knock (BlueMap proxy) konfig ---
const BLUEMAP_HOST = process.env.BLUEMAP_HOST || "";
const KNOCK_PORT = parseInt(process.env.KNOCK_PORT) || 8100;
const PENDING_KNOCKS_FILE = "/mcdata/pending-knocks.json";
const KNOCK_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// CIDR ranges to silently ignore for knocks (comma-separated, e.g. "100.64.0.0/10,10.0.0.0/8")
const KNOCK_IGNORE_RANGES = (process.env.KNOCK_IGNORE_RANGES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((cidr) => {
    const [net, bits] = cidr.split("/");
    const parts = net.split(".").map(Number);
    const ip32 = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    const mask = bits ? (~0 << (32 - parseInt(bits))) >>> 0 : 0xffffffff;
    return { ip32, mask };
  });

function isIgnoredRange(ip) {
  const parts = ip.split(".").map(Number);
  const ip32 = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  return KNOCK_IGNORE_RANGES.some((r) => (ip32 & r.mask) === (r.ip32 & r.mask));
}

fs.ensureDirSync(BACKUPS_DIR);
fs.ensureDirSync(WORLDS_DIR);
fs.ensureDirSync(UPLOADS_DIR);

/** Fix ownership of a path so the MC container (uid=1000) can access it */
function fixOwnership(targetPath) {
  return new Promise((resolve) => {
    exec(`chown -R 1000:1000 "${targetPath}"`, (err) => {
      if (err) console.error("chown failed:", err.message);
      resolve();
    });
  });
}

// Fix ownership of active world on API startup (in case previous copy left root-owned files)
if (fs.existsSync(ACTIVE_WORLD)) {
  fixOwnership(ACTIVE_WORLD).then(() => console.log("Startup: fixed world ownership"));
}

const upload = multer({ dest: UPLOADS_DIR });

// --- RCON ---
let rcon;
let isConnecting = false;
let isConnected = false;

async function connectRcon() {
  if (isConnecting || isConnected) return;
  isConnecting = true;
  try {
    rcon = await Rcon.connect(RCON_CONFIG);
    isConnected = true;
    console.log("RCON connected");

    rcon.on("end", () => {
      console.log("RCON ended. Reconnecting in 30s...");
      isConnected = false;
      isConnecting = false;
      setTimeout(() => tryConnectRcon().catch(console.error), 30000);
    });

    rcon.on("error", (err) => {
      console.error("RCON error:", err.message);
      isConnected = false;
      isConnecting = false;
      setTimeout(() => tryConnectRcon().catch(console.error), 30000);
    });
  } catch (err) {
    console.error("RCON connection failed:", err.message);
    isConnecting = false;
    isConnected = false;
    throw err;
  }
  isConnecting = false;
}

async function tryConnectRcon(retries = 15, delay = 10000) {
  for (let i = 0; i < retries; i++) {
    try {
      await connectRcon();
      if (isConnected) return;
    } catch (err) {
      console.log(`RCON attempt ${i + 1}/${retries} failed. Waiting ${delay / 1000}s...`);
    }
    await new Promise((res) => setTimeout(res, delay));
  }
  console.error("Could not connect to RCON after all retries.");
}

// Vent 40s pa oppstart siden MC-server bruker tid
setTimeout(() => tryConnectRcon().catch(console.error), 40000);

// --- Hjelpefunksjon for RCON-kommandoer ---
async function sendRcon(cmd) {
  if (!rcon || !isConnected) throw new Error("Not connected to RCON");
  return await rcon.send(cmd);
}

// --- Docker-hjelper ---
function dockerAction(action) {
  return new Promise((resolve, reject) => {
    const cmd =
      action === "start"
        ? `docker start ${MC_CONTAINER}`
        : `docker stop ${MC_CONTAINER}`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

// ============================================================
// API-ENDEPUNKTER
// ============================================================

/** GET /api/status */
app.get("/api/status", async (req, res) => {
  try {
    const response = await sendRcon("list");
    const match = response.match(/There are (\d+) of a max of \d+ players online:(.*)/);
    const count = match ? parseInt(match[1]) : 0;
    const players = match
      ? match[2].split(",").map((p) => p.trim()).filter(Boolean)
      : [];
    const currentWorld = fs.existsSync(CURRENT_WORLD_TXT)
      ? fs.readFileSync(CURRENT_WORLD_TXT, "utf8").trim()
      : null;
    res.json({ status: "started", online: count, players, currentWorld });
  } catch {
    const currentWorld = fs.existsSync(CURRENT_WORLD_TXT)
      ? fs.readFileSync(CURRENT_WORLD_TXT, "utf8").trim()
      : null;
    res.json({ status: "stopped", online: 0, players: [], currentWorld });
  }
});

/** GET /api/rcon-status */
app.get("/api/rcon-status", (req, res) => {
  res.json({ connected: isConnected });
});

/** GET /api/start */
app.get("/api/start", async (req, res) => {
  try {
    await dockerAction("start");
    setTimeout(() => tryConnectRcon().catch(console.error), 40000);
    res.json({ success: true, message: "Server starting - RCON ready in ~40s" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/stop */
app.get("/api/stop", async (req, res) => {
  try {
    await sendRcon("stop");
    isConnected = false;
    res.json({ success: true, message: "Server stopping..." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/command/:cmd */
app.get("/api/command/:cmd", async (req, res) => {
  try {
    const response = await sendRcon(decodeURIComponent(req.params.cmd));
    res.json({ success: true, response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/gamemode-all/:mode */
app.get("/api/gamemode-all/:mode", async (req, res) => {
  try {
    const listResponse = await sendRcon("list");
    const playersStr = listResponse.split(":")[1] || "";
    const players = playersStr.split(",").map((p) => p.trim()).filter(Boolean);
    for (const player of players) {
      await sendRcon(`gamemode ${req.params.mode} ${player}`);
    }
    res.json({
      success: true,
      message: `Gamemode ${req.params.mode} set for: ${players.join(", ") || "no players online"}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/whitelist */
app.get("/api/whitelist", async (req, res) => {
  try {
    const response = await sendRcon("whitelist list");
    res.json({ success: true, response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/whitelist/add  body: { player } */
app.post("/api/whitelist/add", async (req, res) => {
  const { player } = req.body;
  if (!player) return res.status(400).json({ error: "Missing player name" });
  try {
    const response = await sendRcon(`whitelist add ${player}`);
    res.json({ success: true, response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/whitelist/remove  body: { player } */
app.post("/api/whitelist/remove", async (req, res) => {
  const { player } = req.body;
  if (!player) return res.status(400).json({ error: "Missing player name" });
  try {
    const response = await sendRcon(`whitelist remove ${player}`);
    res.json({ success: true, response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/op  body: { player } */
app.post("/api/op", async (req, res) => {
  const { player } = req.body;
  if (!player) return res.status(400).json({ error: "Missing player name" });
  try {
    const response = await sendRcon(`op ${player}`);
    res.json({ success: true, response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/deop  body: { player } */
app.post("/api/deop", async (req, res) => {
  const { player } = req.body;
  if (!player) return res.status(400).json({ error: "Missing player name" });
  try {
    const response = await sendRcon(`deop ${player}`);
    res.json({ success: true, response });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/backup */
app.get("/api/backup", async (req, res) => {
  if (!fs.existsSync(ACTIVE_WORLD)) {
    return res.status(404).json({ error: "No active world found" });
  }
  let currentWorldName = "world";
  if (fs.existsSync(CURRENT_WORLD_TXT)) {
    currentWorldName = fs.readFileSync(CURRENT_WORLD_TXT, "utf8").trim() || "world";
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `${currentWorldName}-${timestamp}`;
  const backupPath = `${BACKUPS_DIR}/${backupName}`;
  try {
    if (isConnected) await sendRcon("say Server backup in progress...").catch(() => {});
    fs.copySync(ACTIVE_WORLD, backupPath);

    // Keep only the 5 most recent backups
    const allBackups = fs
      .readdirSync(BACKUPS_DIR)
      .filter((f) => fs.statSync(`${BACKUPS_DIR}/${f}`).isDirectory())
      .sort(
        (a, b) =>
          fs.statSync(`${BACKUPS_DIR}/${b}`).mtime -
          fs.statSync(`${BACKUPS_DIR}/${a}`).mtime
      );
    while (allBackups.length > 5) {
      const oldest = allBackups.pop();
      fs.rmSync(`${BACKUPS_DIR}/${oldest}`, { recursive: true, force: true });
    }

    res.json({ success: true, message: `Backup saved: ${backupName}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/list-backups */
app.get("/api/list-backups", (req, res) => {
  try {
    const backups = fs
      .readdirSync(BACKUPS_DIR)
      .filter((f) => fs.statSync(`${BACKUPS_DIR}/${f}`).isDirectory())
      .sort(
        (a, b) =>
          fs.statSync(`${BACKUPS_DIR}/${b}`).mtime -
          fs.statSync(`${BACKUPS_DIR}/${a}`).mtime
      );
    res.json({ backups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/logs - hent siste linjer fra server-loggen */
app.get("/api/logs", (req, res) => {
  const lines = parseInt(req.query.lines) || 50;
  try {
    if (!fs.existsSync(MC_LOG_FILE)) {
      return res.json({ logs: [] });
    }
    const content = fs.readFileSync(MC_LOG_FILE, "utf8");
    const allLines = content.split("\n").filter(Boolean);
    res.json({ logs: allLines.slice(-lines) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// WORLD MANAGEMENT
// ============================================================

/** GET /api/list-worlds */
app.get("/api/list-worlds", (req, res) => {
  try {
    const worlds = fs
      .readdirSync(WORLDS_DIR)
      .filter((f) => fs.statSync(`${WORLDS_DIR}/${f}`).isDirectory());
    let currentWorld = null;
    if (fs.existsSync(CURRENT_WORLD_TXT)) {
      currentWorld = fs.readFileSync(CURRENT_WORLD_TXT, "utf8").trim() || null;
    }
    res.json({ worlds, currentWorld });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/save-current - save active world to worlds folder */
app.get("/api/save-current", (req, res) => {
  if (!fs.existsSync(ACTIVE_WORLD)) {
    return res.status(404).json({ error: "No active world folder found" });
  }
  if (!fs.existsSync(CURRENT_WORLD_TXT)) {
    return res.status(404).json({ error: "No current-world.txt found - unknown world name" });
  }
  const currentWorldName = fs.readFileSync(CURRENT_WORLD_TXT, "utf8").trim();
  if (!currentWorldName) {
    return res.status(400).json({ error: "current-world.txt is empty" });
  }
  const destPath = `${WORLDS_DIR}/${currentWorldName}`;
  try {
    fs.copySync(ACTIVE_WORLD, destPath);
    res.json({ success: true, message: `Saved active world to worlds/${currentWorldName}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/change-world/:worldName - switch to another saved world */
app.get("/api/change-world/:worldName", async (req, res) => {
  const newWorldName = req.params.worldName;
  const newWorldPath = `${WORLDS_DIR}/${newWorldName}`;
  if (!fs.existsSync(newWorldPath)) {
    return res.status(404).json({ error: "World not found in worlds/ folder" });
  }

  let oldWorldName = null;
  if (fs.existsSync(CURRENT_WORLD_TXT)) {
    oldWorldName = fs.readFileSync(CURRENT_WORLD_TXT, "utf8").trim();
  }

  res.json({
    success: true,
    message: `Switching from ${oldWorldName || "unknown"} to ${newWorldName}... server restarting`,
  });

  // Stop server via RCON
  if (isConnected) {
    try {
      await sendRcon("say Switching world... server restarting!");
      await sendRcon("stop");
    } catch (err) {
      console.error("Error stopping server for world switch:", err.message);
    }
  }
  isConnected = false;

  // Wait for server to stop, then swap world
  setTimeout(async () => {
    try {
      // Save current world back to worlds/ folder
      if (oldWorldName && fs.existsSync(ACTIVE_WORLD)) {
        fs.copySync(ACTIVE_WORLD, `${WORLDS_DIR}/${oldWorldName}`);
      }
      // Remove active world and copy new one
      fs.rmSync(ACTIVE_WORLD, { recursive: true, force: true });
      fs.copySync(newWorldPath, ACTIVE_WORLD);
      fs.rmSync(`${ACTIVE_WORLD}/session.lock`, { force: true });
      await fixOwnership(ACTIVE_WORLD);
      fs.writeFileSync(CURRENT_WORLD_TXT, newWorldName);

      // Start server
      await dockerAction("start");
    } catch (err) {
      console.error("Error during world switch:", err.message);
    }
  }, 15000);

  // Reconnect RCON after server starts
  setTimeout(() => {
    tryConnectRcon().catch(console.error);
  }, 60000);
});

/** GET /api/new-world/:worldName - generate a fresh new world */
app.get("/api/new-world/:worldName", async (req, res) => {
  const newWorldName = req.params.worldName;

  // Save current world first
  let oldWorldName = null;
  if (fs.existsSync(CURRENT_WORLD_TXT)) {
    oldWorldName = fs.readFileSync(CURRENT_WORLD_TXT, "utf8").trim();
  }

  res.json({
    success: true,
    message: `Creating new world: ${newWorldName}. Server restarting to generate it...`,
  });

  // Stop server
  if (isConnected) {
    try {
      await sendRcon("say Generating new world... server restarting!");
      await sendRcon("stop");
    } catch (err) {
      console.error("Error stopping server for new world:", err.message);
    }
  }
  isConnected = false;

  setTimeout(async () => {
    try {
      // Save old world
      if (oldWorldName && fs.existsSync(ACTIVE_WORLD)) {
        fs.copySync(ACTIVE_WORLD, `${WORLDS_DIR}/${oldWorldName}`);
      }
      // Remove active world so MC generates a new one
      fs.rmSync(ACTIVE_WORLD, { recursive: true, force: true });
      fs.writeFileSync(CURRENT_WORLD_TXT, newWorldName);

      // Start server - it will generate a new world
      await dockerAction("start");
    } catch (err) {
      console.error("Error creating new world:", err.message);
    }
  }, 15000);

  // After world is generated, save a copy to worlds/
  setTimeout(() => {
    if (fs.existsSync(ACTIVE_WORLD)) {
      fs.copySync(ACTIVE_WORLD, `${WORLDS_DIR}/${newWorldName}`);
    }
  }, 60000);

  // Reconnect RCON
  setTimeout(() => {
    tryConnectRcon().catch(console.error);
  }, 65000);
});

/** GET /api/restore-backup/:backupName */
app.get("/api/restore-backup/:backupName", async (req, res) => {
  const backupName = req.params.backupName;
  const backupPath = `${BACKUPS_DIR}/${backupName}`;
  if (!fs.existsSync(backupPath)) {
    return res.status(404).json({ error: "Backup folder not found" });
  }

  res.json({ success: true, message: `Restoring backup: ${backupName}. Server restarting...` });

  // Stop server
  if (isConnected) {
    try {
      await sendRcon("say Restoring backup... server restarting!");
      await sendRcon("stop");
    } catch (err) {
      console.error("Error stopping server for restore:", err.message);
    }
  }
  isConnected = false;

  setTimeout(async () => {
    try {
      fs.rmSync(ACTIVE_WORLD, { recursive: true, force: true });
      fs.copySync(backupPath, ACTIVE_WORLD);
      fs.rmSync(`${ACTIVE_WORLD}/session.lock`, { force: true });
      await fixOwnership(ACTIVE_WORLD);
      // Extract world name from backup name (everything before the timestamp)
      const worldName = backupName.replace(/-\d{4}-\d{2}-\d{2}T.*$/, "");
      if (worldName) {
        fs.writeFileSync(CURRENT_WORLD_TXT, worldName);
      }
      await dockerAction("start");
    } catch (err) {
      console.error("Error restoring backup:", err.message);
    }
  }, 15000);

  setTimeout(() => {
    tryConnectRcon().catch(console.error);
  }, 60000);
});

/** POST /api/upload-world - upload a .zip world file */
app.post("/api/upload-world", upload.single("worldFile"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const baseName = req.file.originalname.replace(/\.[^/.]+$/, "");
  const newWorldPath = `${WORLDS_DIR}/${baseName}`;

  if (fs.existsSync(newWorldPath)) {
    fs.unlinkSync(req.file.path);
    return res.status(409).json({ error: `World "${baseName}" already exists` });
  }

  exec(
    `unzip -o "${req.file.path}" -d "${newWorldPath}" && rm "${req.file.path}"`,
    (error, stdout, stderr) => {
      if (error) {
        console.error("Failed to extract world:", error);
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(500).json({ error: "Failed to extract world zip" });
      }
      // Check if the zip contained a single subfolder and flatten if so
      const contents = fs.readdirSync(newWorldPath);
      if (contents.length === 1) {
        const inner = `${newWorldPath}/${contents[0]}`;
        if (fs.statSync(inner).isDirectory() && fs.existsSync(`${inner}/level.dat`)) {
          const tmpPath = `${newWorldPath}_tmp`;
          fs.moveSync(inner, tmpPath);
          fs.rmSync(newWorldPath, { recursive: true, force: true });
          fs.moveSync(tmpPath, newWorldPath);
        }
      }
      res.json({ success: true, message: `World "${baseName}" uploaded and ready` });
    }
  );
});

// ============================================================
// FIREWALL (UFW) MANAGEMENT
// ============================================================

const firewallLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests, try again later" },
});

/** Strict IPv4 validation - rejects private, loopback, multicast, reserved */
function isValidPublicIPv4(ip) {
  if (typeof ip !== "string") return false;
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = [match[1], match[2], match[3], match[4]];
  const octets = parts.map(Number);
  if (octets.some((o) => o > 255)) return false;
  // Reject leading zeros (prevents octal interpretation tricks)
  if (parts.some((s) => s.length > 1 && s.startsWith("0"))) return false;
  const [a, b] = octets;
  if (a === 0) return false; // 0.0.0.0/8
  if (a === 10) return false; // 10.0.0.0/8
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
  if (a === 192 && b === 168) return false; // 192.168.0.0/16
  if (a >= 224) return false; // multicast + reserved
  return true;
}

/** Run a UFW command on the host via the ufw-agent sidecar + nsenter */
function ufwExec(action, ip, port, proto) {
  const nsenterBase = [
    "exec", UFW_AGENT_CONTAINER,
    "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--",
  ];
  const ufwArgs = action === "allow"
    ? ["ufw", "route", "allow", "from", ip, "to", "any", "port", port, "proto", proto]
    : ["ufw", "route", "delete", "allow", "from", ip, "to", "any", "port", port, "proto", proto];

  return new Promise((resolve, reject) => {
    execFile("docker", [...nsenterBase, ...ufwArgs], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout.trim());
    });
  });
}

function loadFirewallRules() {
  try {
    if (fs.existsSync(FIREWALL_RULES_FILE)) {
      return JSON.parse(fs.readFileSync(FIREWALL_RULES_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load firewall rules:", e.message);
  }
  return { rules: [] };
}

function saveFirewallRules(data) {
  fs.writeFileSync(FIREWALL_RULES_FILE, JSON.stringify(data, null, 2));
}

/** GET /api/firewall - list allowed IPs */
app.get("/api/firewall", (req, res) => {
  const data = loadFirewallRules();
  res.json({ success: true, rules: data.rules });
});

/** GET /api/firewall/my-ip - detect client IP */
app.get("/api/firewall/my-ip", (req, res) => {
  const raw = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .split(",")[0]
    .trim()
    .replace(/^::ffff:/, "");
  res.json({ success: true, ip: raw, valid: isValidPublicIPv4(raw) });
});

/** POST /api/firewall/add  body: { ip, label? } */
app.post("/api/firewall/add", firewallLimiter, async (req, res) => {
  const { ip, label } = req.body;
  if (!ip || !isValidPublicIPv4(ip)) {
    return res.status(400).json({ success: false, error: "Invalid or non-public IPv4 address" });
  }

  const data = loadFirewallRules();
  if (data.rules.some((r) => r.ip === ip)) {
    return res.status(409).json({ success: false, error: "IP already in allowlist" });
  }

  try {
    for (const { port, proto } of UFW_PORTS) {
      await ufwExec("allow", ip, port, proto);
    }
    data.rules.push({ ip, addedAt: new Date().toISOString(), label: label || "" });
    saveFirewallRules(data);
    res.json({ success: true, message: `Allowed ${ip} on all Minecraft ports` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/firewall/remove  body: { ip } */
app.post("/api/firewall/remove", firewallLimiter, async (req, res) => {
  const { ip } = req.body;
  if (!ip || !isValidPublicIPv4(ip)) {
    return res.status(400).json({ success: false, error: "Invalid IPv4 address" });
  }

  const data = loadFirewallRules();
  if (!data.rules.some((r) => r.ip === ip)) {
    return res.status(404).json({ success: false, error: "IP not in allowlist" });
  }

  try {
    for (const { port, proto } of UFW_PORTS) {
      await ufwExec("delete", ip, port, proto);
    }
    data.rules = data.rules.filter((r) => r.ip !== ip);
    saveFirewallRules(data);
    res.json({ success: true, message: `Removed ${ip} from all Minecraft ports` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Try to read UFW log lines from host - checks multiple log locations */
function readUfwLog() {
  const logFiles = ["/var/log/ufw.log", "/var/log/syslog", "/var/log/kern.log"];
  const nsenterBase = [
    "exec", UFW_AGENT_CONTAINER,
    "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--",
  ];

  return new Promise((resolve, reject) => {
    let tried = 0;
    function tryNext() {
      if (tried >= logFiles.length) {
        return reject(new Error(
          `UFW log not found. Tried: ${logFiles.join(", ")}. ` +
          "Ensure UFW logging is enabled: sudo ufw logging on"
        ));
      }
      const logFile = logFiles[tried++];
      execFile(
        "docker",
        [...nsenterBase, "tail", "-n", "2000", logFile],
        { timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return tryNext();
          // For syslog/kern.log, only keep UFW lines
          const lines = stdout.split("\n").filter((l) => l.includes("[UFW"));
          if (lines.length === 0 && tried < logFiles.length) return tryNext();
          resolve(lines.join("\n"));
        }
      );
    }
    tryNext();
  });
}

/** GET /api/firewall/attempts - blocked connection attempts on MC ports (last 5 min) */
app.get("/api/firewall/attempts", async (req, res) => {
  try {
    const logContent = await readUfwLog();

    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;
    const mcPorts = new Set(UFW_PORTS.map((p) => p.port));
    const ipCounts = {};

    for (const line of logContent.split("\n")) {
      if (!line.includes("UFW") || !line.includes("BLOCK")) continue;

      // Extract DPT (destination port)
      const dptMatch = line.match(/DPT=(\d+)/);
      if (!dptMatch || !mcPorts.has(dptMatch[1])) continue;

      // Parse timestamp - try ISO 8601 (with tz offset) first, then syslog format
      const isoMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[\d.]*[+-]\d{2}:\d{2})/);
      const syslogMatch = !isoMatch && line.match(/(\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2})/);
      if (isoMatch) {
        const logDate = new Date(isoMatch[1]);
        if (logDate.getTime() < fiveMinAgo) continue;
      } else if (syslogMatch) {
        const logDate = new Date(`${syslogMatch[1]} ${new Date().getFullYear()}`);
        if (logDate.getTime() < fiveMinAgo) continue;
      }

      // Extract source IP
      const srcMatch = line.match(/SRC=([\d.]+)/);
      if (!srcMatch) continue;
      const ip = srcMatch[1];
      if (!isValidPublicIPv4(ip)) continue;

      if (!ipCounts[ip]) ipCounts[ip] = { count: 0, ports: new Set() };
      ipCounts[ip].count++;
      ipCounts[ip].ports.add(dptMatch[1]);
    }

    // Look up country for each IP via ip-api.com (free, no key needed)
    const attempts = [];
    const ips = Object.keys(ipCounts);

    if (ips.length > 0 && ips.length <= 100) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const batchRes = await fetch("http://ip-api.com/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ips.map((ip) => ({ query: ip, fields: "query,country,countryCode" }))),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const geoData = await batchRes.json();
        const geoMap = {};
        for (const g of geoData) {
          if (g.query) geoMap[g.query] = { country: g.country || "Unknown", code: g.countryCode || "" };
        }
        for (const ip of ips) {
          const geo = geoMap[ip] || { country: "Unknown", code: "" };
          attempts.push({
            ip,
            count: ipCounts[ip].count,
            ports: [...ipCounts[ip].ports],
            country: geo.country,
            countryCode: geo.code,
          });
        }
      } catch {
        for (const ip of ips) {
          attempts.push({
            ip,
            count: ipCounts[ip].count,
            ports: [...ipCounts[ip].ports],
            country: "Unknown",
            countryCode: "",
          });
        }
      }
    }

    attempts.sort((a, b) => b.count - a.count);
    res.json({ success: true, attempts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// KNOCK (BlueMap Proxy) SYSTEM
// ============================================================

function loadPendingKnocks() {
  try {
    if (fs.existsSync(PENDING_KNOCKS_FILE)) {
      return JSON.parse(fs.readFileSync(PENDING_KNOCKS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load pending knocks:", e.message);
  }
  return { knocks: [] };
}

function savePendingKnocks(data) {
  fs.writeFileSync(PENDING_KNOCKS_FILE, JSON.stringify(data, null, 2));
}

function cleanExpiredKnocks(data) {
  const cutoff = Date.now() - KNOCK_EXPIRY_MS;
  data.knocks = data.knocks.filter((k) => new Date(k.timestamp).getTime() > cutoff);
  return data;
}

/** Register a knock (deduplicated). Runs async, does not throw. */
async function registerKnock(ip) {
  if (!isValidPublicIPv4(ip)) return;
  if (isIgnoredRange(ip)) return;

  // Skip if already approved in firewall rules
  const fwData = loadFirewallRules();
  if (fwData.rules.some((r) => r.ip === ip)) return;

  const data = cleanExpiredKnocks(loadPendingKnocks());

  // Deduplicate: update timestamp if already pending
  const existing = data.knocks.find((k) => k.ip === ip);
  if (existing) {
    existing.timestamp = new Date().toISOString();
    savePendingKnocks(data);
    return;
  }

  // GeoIP lookup for new IP
  let country = "Unknown";
  let countryCode = "";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=country,countryCode`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const geo = await geoRes.json();
    if (geo.country) country = geo.country;
    if (geo.countryCode) countryCode = geo.countryCode;
  } catch { /* ignore geo failures */ }

  data.knocks.push({ ip, timestamp: new Date().toISOString(), country, countryCode });
  savePendingKnocks(data);
  console.log(`Knock registered: ${ip} (${country})`);
}

/** GET /api/firewall/knocks - list pending knocks */
app.get("/api/firewall/knocks", (req, res) => {
  const data = cleanExpiredKnocks(loadPendingKnocks());
  savePendingKnocks(data);
  res.json({ success: true, knocks: data.knocks });
});

/** POST /api/firewall/knocks/approve  body: { ip, label? } */
app.post("/api/firewall/knocks/approve", firewallLimiter, async (req, res) => {
  const { ip, label } = req.body;
  if (!ip || !isValidPublicIPv4(ip)) {
    return res.status(400).json({ success: false, error: "Invalid IPv4 address" });
  }

  // Check not already in firewall
  const fwData = loadFirewallRules();
  if (fwData.rules.some((r) => r.ip === ip)) {
    // Remove from pending anyway
    const knockData = loadPendingKnocks();
    knockData.knocks = knockData.knocks.filter((k) => k.ip !== ip);
    savePendingKnocks(knockData);
    return res.status(409).json({ success: false, error: "IP already in allowlist" });
  }

  try {
    for (const { port, proto } of UFW_PORTS) {
      await ufwExec("allow", ip, port, proto);
    }
    fwData.rules.push({ ip, addedAt: new Date().toISOString(), label: label || "" });
    saveFirewallRules(fwData);

    // Remove from pending
    const knockData = loadPendingKnocks();
    knockData.knocks = knockData.knocks.filter((k) => k.ip !== ip);
    savePendingKnocks(knockData);

    res.json({ success: true, message: `Approved ${ip} on all Minecraft ports` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /api/firewall/knocks/dismiss  body: { ip } */
app.post("/api/firewall/knocks/dismiss", (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ success: false, error: "Missing IP" });

  const data = loadPendingKnocks();
  const before = data.knocks.length;
  data.knocks = data.knocks.filter((k) => k.ip !== ip);
  savePendingKnocks(data);

  if (data.knocks.length === before) {
    return res.status(404).json({ success: false, error: "IP not in pending knocks" });
  }
  res.json({ success: true, message: `Dismissed ${ip}` });
});

// --- BlueMap knock-proxy on dedicated port ---
if (BLUEMAP_HOST) {
  const knockApp = express();

  // Middleware: register visitor IP as knock (async, non-blocking)
  knockApp.use((req, res, next) => {
    const raw = (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.socket.remoteAddress || "")
      .split(",")[0]
      .trim()
      .replace(/^::ffff:/, "");
    // Fire and forget - don't delay the proxy response
    registerKnock(raw).catch((err) => console.error("Knock registration error:", err.message));
    next();
  });

  // Proxy to BlueMap
  knockApp.use(
    createProxyMiddleware({
      target: `http://${BLUEMAP_HOST}`,
      changeOrigin: true,
      ws: true,
    })
  );

  knockApp.listen(KNOCK_PORT, () => {
    console.log(`BlueMap knock-proxy on port ${KNOCK_PORT} → ${BLUEMAP_HOST}`);
  });
} else {
  console.log("BLUEMAP_HOST not set - BlueMap knock-proxy disabled");
}

// ============================================================
app.listen(API_PORT, () => {
  console.log(`MC API running on port ${API_PORT}`);
  console.log(`  RCON target: ${RCON_CONFIG.host}:${RCON_CONFIG.port}`);
  console.log(`  MC container: ${MC_CONTAINER}`);
});
