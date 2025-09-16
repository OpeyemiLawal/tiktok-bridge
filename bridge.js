// bridge.js
// Local TikTok LIVE -> WebSocket bridge for Godot

const { TikTokLiveConnection } = require("tiktok-live-connector");
const WebSocket = require("ws");
const http = require("http");

const WS_PORT = process.env.PORT || 8080; // You can override via env
const HOST = process.env.HOST || "0.0.0.0"; // Bind host (use 127.0.0.1 for local-only)
const wss = new WebSocket.Server({ port: WS_PORT, host: HOST });
console.log(`WebSocket server listening on ws://${HOST}:${WS_PORT}`);

// Minimal HTTP health endpoint for PaaS health checks
const HEALTH_PORT = process.env.HEALTH_PORT || (Number(WS_PORT) + 1);
const healthServer = http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok\n");
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthServer.listen(HEALTH_PORT, HOST, () => {
  console.log(`Health server listening on http://${HOST}:${HEALTH_PORT}/healthz`);
});

let currentWebcast = null;
let currentUsername = null; // Username currently being watched (if any)
const clients = new Set();  // Track connected Godot clients
let watchOwner = null; // The WebSocket that requested the current watch (if any)

// TikTok gift ID to human-readable name mapping
const giftNameMap = {
  5655: "Rose",
  7934: "Hearts",
  5269: "TikTok",
  5879: "Doughnut",
  5658: "Heart Me",
  15232: "You are awesome",
  5660: "Hand Hearts",
  8913: "Rosa",
  6064: "GG"
};

function normalizeGiftName(rawNameOrId) {
  if (rawNameOrId === undefined || rawNameOrId === null) return null;
  const strName = String(rawNameOrId).trim();

  // Try direct ID lookup
  if (giftNameMap[strName]) return giftNameMap[strName];

  // If numeric, try parseInt lookup
  const asNumber = parseInt(strName, 10);
  if (!isNaN(asNumber) && giftNameMap[asNumber]) return giftNameMap[asNumber];

  // Fallback to raw (capitalize)
  return strName.charAt(0).toUpperCase() + strName.slice(1);
}

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

async function startWatching(username) {
  if (!username) return;

  // Disconnect any previous connection
  if (currentWebcast) {
    try { await currentWebcast.disconnect(); } catch (_) {}
    currentWebcast = null;
  }

  console.log(`Starting to watch TikTok live of ${username}`);
  const connection = new TikTokLiveConnection(username);

  // Gifts
  connection.on("gift", (data) => {
    try {
      const rawGiftName = data?.gift?.name || data?.giftId || data?.gift?.id;
      const repeatCount = data?.repeat_count || data?.repeatCount || 1;
      const gift = normalizeGiftName(rawGiftName);
      if (!gift) return;

      const from = data?.uniqueId || data?.user?.uniqueId || "unknown";
      console.log(`Gift: ${gift} x${repeatCount} from ${from}`);

      broadcast({ type: "gift", gift, count: Number(repeatCount) || 1, from });
    } catch (err) {
      console.warn("Error handling gift:", err);
    }
  });

  // Chat comments
  connection.on("chat", (data) => {
    try {
      const text = data?.comment || data?.msg || "";
      const from = data?.uniqueId || data?.user?.uniqueId || "unknown";
      if (!text) return;

      console.log(`Chat: ${from}: ${text}`);
      broadcast({ type: "comment", text, from });
    } catch (err) {
      console.warn("Error handling chat:", err);
    }
  });

  connection.on("connected", (state) => {
    console.log("Connected to TikTok room", state.roomId);
    broadcast({ type: "info", message: `Connected to room ${state.roomId}` });
  });

  connection.on("disconnected", (reason) => {
    console.log("TikTok connection disconnected", reason);
    broadcast({ type: "info", message: "Disconnected from TikTok" });
    currentWebcast = null;
    currentUsername = null;
    watchOwner = null;
  });

  connection.on("error", (err) => {
    console.warn("TikTok connection error", err?.toString?.() || err);
    broadcast({ type: "error", message: "Failed to connect to TikTok live for " + username });
  });

  try {
    await connection.connect();
    currentWebcast = connection;
    currentUsername = username;
  } catch (err) {
    console.error("Failed to connect to TikTok live", err?.toString?.() || err);
    broadcast({ type: "error", message: "Failed to connect to TikTok live for " + username });
  }
}

// WebSocket server (for Godot)
wss.on("connection", (ws) => {
  console.log("Godot client connected via WebSocket");
  clients.add(ws);

  // Inform the just-connected client if we're already watching someone
  if (currentUsername) {
    try {
      ws.send(JSON.stringify({ type: "info", message: "Already watching " + currentUsername }));
    } catch (_) {}
  }

  ws.on("message", (msg) => {
    let parsed = null;
    try { parsed = JSON.parse(msg.toString()); } catch (_) { return; }

    if (parsed.cmd === "watch" && parsed.username) {
      if (currentWebcast && currentUsername === parsed.username) {
        // Already watching this user
        ws.send(JSON.stringify({ type: "info", message: "Already watching " + parsed.username }));
      } else {
        startWatching(parsed.username);
        // Track which client initiated this watch so we can auto-disconnect
        watchOwner = ws;
        ws.send(JSON.stringify({ type: "info", message: "Watching " + parsed.username }));
      }
    } else if (parsed.cmd === "ping") {
      // Respond to keep-alive pings from clients
      ws.send(JSON.stringify({ type: "pong" }));
    } else if (parsed.cmd === "test" && parsed.gift) {
      // Simulate a gift to all clients
      const count = Number(parsed.count) || 1;
      broadcast({ type: "gift", gift: parsed.gift, count, from: parsed.from || "test" });
    } else if (parsed.cmd === "test_comment" && parsed.text) {
      // Simulate a chat comment to all clients
      const text = String(parsed.text);
      broadcast({ type: "comment", text, from: parsed.from || "test" });
    } else {
      ws.send(JSON.stringify({ type: "error", message: "Unknown command" }));
    }
  });

  ws.on("close", () => {
    console.log("Godot client disconnected");
    clients.delete(ws);
    // If the disconnecting client initiated the current watch, stop TikTok immediately
    if (watchOwner === ws) {
      (async () => {
        if (currentWebcast) {
          try {
            await currentWebcast.disconnect();
            console.log("Disconnected from TikTok because watch owner disconnected");
          } catch (err) {
            console.warn("Error disconnecting TikTok on watch owner close:", err);
          } finally {
            currentWebcast = null;
            currentUsername = null;
            watchOwner = null;
          }
        } else {
          watchOwner = null;
        }
      })();
    }
    // Only disconnect TikTok if there are no more connected Godot clients
    if (clients.size === 0) {
      (async () => {
        if (currentWebcast) {
          try {
            await currentWebcast.disconnect();
            console.log("Disconnected from TikTok because last client disconnected");
          } catch (err) {
            console.warn("Error disconnecting TikTok on last client close:", err);
          } finally {
            currentWebcast = null;
            currentUsername = null;
            watchOwner = null;
          }
        }
      })();
    }
  });
});

// CLI simulation removed for deployment-only usage. Use WebSocket messages from clients instead.

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`Shutting down due to ${signal}...`);
  try {
    // Inform clients the bridge is going down
    broadcast({ type: "bridge_shutdown", message: `Bridge shutting down (${signal})` });
  } catch (_) {}
  try {
    if (currentWebcast) await currentWebcast.disconnect();
  } catch (err) {
    console.warn("Error disconnecting TikTok on shutdown:", err);
  }
  try {
    wss.close(() => process.exit(0));
  } catch (_) {
    process.exit(0);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));