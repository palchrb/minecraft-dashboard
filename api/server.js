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
const multer = require("multer");
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
const WORLDS_DIR = "/mcdata/worlds";
const ACTIVE_WORLD = "/mcdata/world";
const UPLOADS_DIR = "/mcdata/uploads";
const CURRENT_WORLD_TXT = "/mcdata/current-world.txt";

fs.ensureDirSync(BACKUPS_DIR);
fs.ensureDirSync(WORLDS_DIR);
fs.ensureDirSync(UPLOADS_DIR);

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
      // Remove session.lock to prevent AccessDeniedException on startup
      fs.rmSync(`${ACTIVE_WORLD}/session.lock`, { force: true });
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
      // Remove session.lock to prevent AccessDeniedException on startup
      fs.rmSync(`${ACTIVE_WORLD}/session.lock`, { force: true });
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
app.listen(API_PORT, () => {
  console.log(`MC API running on port ${API_PORT}`);
  console.log(`  RCON target: ${RCON_CONFIG.host}:${RCON_CONFIG.port}`);
  console.log(`  MC container: ${MC_CONTAINER}`);
});
