/**
 * Minecraft Server Management API
 * Kjorer som egen Docker-container i samme stack som itzg/minecraft-server
 */

require("dotenv").config();
const express = require("express");
const { Rcon } = require("rcon-client");
const fs = require("fs-extra");
const { exec } = require("child_process");
const cors = require("cors");
const path = require("path");

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
const ACTIVE_WORLD = "/mcdata/world";

fs.ensureDirSync(BACKUPS_DIR);

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
    res.json({ status: "started", online: count, players });
  } catch {
    res.json({ status: "stopped", online: 0, players: [] });
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
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${BACKUPS_DIR}/world-${timestamp}`;
  try {
    if (isConnected) await sendRcon("say Server backup in progress...").catch(() => {});
    fs.copySync(ACTIVE_WORLD, backupPath);

    // Keep only the 3 most recent backups
    const allBackups = fs
      .readdirSync(BACKUPS_DIR)
      .filter((f) => fs.statSync(`${BACKUPS_DIR}/${f}`).isDirectory())
      .sort(
        (a, b) =>
          fs.statSync(`${BACKUPS_DIR}/${b}`).mtime -
          fs.statSync(`${BACKUPS_DIR}/${a}`).mtime
      );
    while (allBackups.length > 3) {
      const oldest = allBackups.pop();
      fs.rmSync(`${BACKUPS_DIR}/${oldest}`, { recursive: true, force: true });
    }

    res.json({ success: true, message: `Backup saved: world-${timestamp}` });
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
app.listen(API_PORT, () => {
  console.log(`MC API running on port ${API_PORT}`);
  console.log(`  RCON target: ${RCON_CONFIG.host}:${RCON_CONFIG.port}`);
  console.log(`  MC container: ${MC_CONTAINER}`);
});
