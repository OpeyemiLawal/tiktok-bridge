// bridge.js (UPDATED) -----------------------------------------------------
const { WebcastPushConnection } = require("tiktok-live-connector");
const WebSocket = require("ws");
const readline = require("readline");

// Monkey patch to prevent giftDetails.giftImage crashes
try {
  const dataConverter = require("tiktok-live-connector/dist/lib/_legacy/data-converter");
  if (dataConverter && dataConverter.simplifyObject) {
    const originalSimplifyObject = dataConverter.simplifyObject;
    dataConverter.simplifyObject = function(type, originalObject) {
      try {
        if (type === 'WebcastGiftMessage') {
          const webcastObject = { ...originalObject };
          webcastObject.repeatEnd = !!webcastObject.repeatEnd;
          webcastObject.gift = {
            gift_id: webcastObject.giftId,
            repeat_count: webcastObject.repeatCount,
            repeat_end: webcastObject.repeatEnd ? 1 : 0,
            gift_type: webcastObject.giftDetails?.giftType
          };

          if (webcastObject.giftDetails) {
            const safeGiftDetails = { ...webcastObject.giftDetails };
            delete safeGiftDetails.giftImage;
            Object.assign(webcastObject, safeGiftDetails);
            delete webcastObject.giftDetails;
          }

          if (webcastObject.giftExtra) {
            if (webcastObject.giftExtra.toUserId) {
              webcastObject.receiverUserId = webcastObject.giftExtra.toUserId;
              delete webcastObject.giftExtra.toUserId;
            }
            if (webcastObject.giftExtra.sendGiftSendMessageSuccessMs) {
              webcastObject.timestamp = parseInt(webcastObject.giftExtra.sendGiftSendMessageSuccessMs);
              delete webcastObject.giftExtra.sendGiftSendMessageSuccessMs;
            }
            Object.assign(webcastObject, webcastObject.giftExtra);
            delete webcastObject.giftExtra;
          }

          if (webcastObject.monitorExtra?.startsWith('{')) {
            try { webcastObject.monitorExtra = JSON.parse(webcastObject.monitorExtra); } catch (err) {}
          }

          return webcastObject;
        }
        return originalSimplifyObject.call(this, type, originalObject);
      } catch (err) {
        console.warn("Error in simplified data converter, using safe fallback:", err);
        if (type === 'WebcastGiftMessage') {
          return { type: "gift", gift: "UnknownGift", count: 1, from: "unknown" };
        }
        return originalObject;
      }
    };
    console.log("Successfully patched TikTok data converter to prevent crashes");
  }
} catch (err) {
  console.warn("Could not patch TikTok data converter:", err);
}

// --- PORT / Railway URL logging ------------------------------------------
const WS_PORT = process.env.PORT || 8081; // required by many cloud hosts
let wss = new WebSocket.Server({ port: WS_PORT });

// Detect common static/service URL env vars (Railway / other hosts)
const publicUrlEnv =
  process.env.RAILWAY_URL ||
  process.env.RAILWAY_STATIC_URL ||
  process.env.DEPLOYMENT_URL ||
  process.env.PUBLIC_URL ||
  process.env.SERVICE_URL ||
  null;

function makeWsFromHttp(url) {
  if (!url) return null;
  // if the env var contains protocol, convert it; otherwise assume hostname
  if (url.startsWith("http://")) return url.replace(/^http:\/\//, "ws://");
  if (url.startsWith("https://")) return url.replace(/^https:\/\//, "wss://");
  // else assume domain-only, prefer secure wss
  return "wss://" + url;
}

const suggestedWsUrl = makeWsFromHttp(publicUrlEnv);

console.log(`WebSocket server listening on ws://0.0.0.0:${WS_PORT}`);
if (publicUrlEnv) {
  console.log(`Detected public URL env variable: ${publicUrlEnv}`);
  console.log(`Suggested WebSocket URL for clients: ${suggestedWsUrl}`);
} else {
  console.log("No public URL env var detected (set RAILWAY_URL to your Railway domain if deploying).");
}

// --- rest of your bridge implementation ---------------------------------
let currentWebcast = null;

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
  if (giftNameMap[strName]) return giftNameMap[strName];
  const asNumber = parseInt(strName, 10);
  if (!isNaN(asNumber) && giftNameMap[asNumber]) return giftNameMap[asNumber];
  return strName.charAt(0).toUpperCase() + strName.slice(1);
}

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

async function startWatching(username) {
  if (!username) return;
  if (currentWebcast) {
    try { 
      console.log("Disconnecting from previous TikTok live stream");
      currentWebcast.disconnect(); 
    } catch (e) {
      console.warn("Error disconnecting from previous stream:", e);
    }
    currentWebcast = null;
  }

  console.log(`Starting to watch TikTok live of ${username}`);
  const connection = new WebcastPushConnection(username);

  connection.on("gift", (data) => {
    try {
      console.log("Gift event received (processed):", JSON.stringify(data).substring(0, 200));
      let rawGiftName = null;
      let repeatCount = 1;
      let from = "unknown";

      if (data?.gift?.name) rawGiftName = data.gift.name;
      else if (data?.giftId) rawGiftName = data.giftId;
      else if (data?.gift?.id) rawGiftName = data.gift.id;
      else if (data?.giftDetails?.giftName) rawGiftName = data.giftDetails.giftName;
      else if (data?.giftDetails?.giftId) rawGiftName = data.giftDetails.giftId;
      else if (data?.gift_id) rawGiftName = data.gift_id;
      else if (data?.gift_type) rawGiftName = data.gift_type;
      else rawGiftName = "UnknownGift";

      if (data?.repeat_count !== undefined) repeatCount = Number(data.repeat_count);
      else if (data?.repeatCount !== undefined) repeatCount = Number(data.repeatCount);
      else if (data?.giftDetails?.repeatCount !== undefined) repeatCount = Number(data.giftDetails.repeatCount);

      if (data?.uniqueId) from = data.uniqueId;
      else if (data?.user?.uniqueId) from = data.user.uniqueId;
      else if (data?.sender?.uniqueId) from = data.sender.uniqueId;
      else if (data?.userId) from = data.userId;

      if (isNaN(repeatCount) || repeatCount < 1) repeatCount = 1;
      const gift = normalizeGiftName(rawGiftName) || "UnknownGift";

      console.log(`Gift event → ${gift} x${repeatCount} from ${from}`);

      broadcast({ type: "gift", gift, count: repeatCount, from });
    } catch (err) {
      console.warn("Error handling gift:", err);
      broadcast({ type: "error", message: "Error while processing a gift event" });
    }
  });

  connection.on("rawData", (rawData) => {
    try {
      if (rawData && typeof rawData === 'object') {
        if (rawData.giftId || rawData.giftDetails || rawData.gift) {
          console.log("Raw gift data detected, processing directly:", JSON.stringify(rawData).substring(0, 200));
          let giftName = rawData.giftId || rawData.gift?.id || "UnknownGift";
          let count = rawData.repeatCount || rawData.repeat_count || 1;
          let sender = rawData.userId || rawData.user?.uniqueId || "unknown";
          const gift = normalizeGiftName(giftName);
          console.log(`Direct gift processing → ${gift} x${count} from ${sender}`);
          broadcast({ type: "gift", gift, count: Number(count) || 1, from: sender });
        }
      }
    } catch (err) {
      console.warn("Error in raw data handler:", err);
    }
  });

  connection.on("connected", (state) => { console.log("Connected to TikTok room", state.roomId); });
  connection.on("disconnected", (reason) => { console.log("TikTok connection disconnected", reason); });
  connection.on("error", (err) => {
    console.warn("TikTok connection error", err?.toString?.() || err);
    broadcast({ type: "error", message: "Failed to connect to TikTok live for " + username });
  });

  try {
    await connection.connect();
    currentWebcast = connection;
  } catch (err) {
    console.error("Failed to connect to TikTok live", err?.toString?.() || err);
    broadcast({ type: "error", message: "Failed to connect to TikTok live for " + username });
  }

  // global error logging
  connection.on("error", (err) => {
    console.warn("TikTok connection error (global):", err?.toString?.() || err);
  });
}

// WebSocket server
wss.on("connection", (ws) => {
  console.log(`Godot client connected via WebSocket (Total clients: ${wss.clients.size})`);

  ws.on("message", (msg) => {
    let parsed = null;
    try { parsed = JSON.parse(msg.toString()); } catch (e) { return; }

    if (parsed.cmd === "watch" && parsed.username) {
      startWatching(parsed.username);
      ws.send(JSON.stringify({ type: "info", message: "Watching " + parsed.username }));
    } else if (parsed.cmd === "test" && parsed.gift) {
      const safeGift = normalizeGiftName(parsed.gift) || "UnknownGift";
      broadcast({ type: "gift", gift: safeGift, count: parsed.count || 1, from: "test" });
    } else if (parsed.cmd === "test_comment" && parsed.text) {
      const text = String(parsed.text);
      broadcast({ type: "comment", text, from: parsed.from || "test" });
    } else if (parsed.cmd === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      console.log("Bridge: responded to ping with pong");
    } else if (parsed.cmd === "status") {
      const status = { type: "status", connected: currentWebcast !== null, watching: currentWebcast ? "TikTok live stream" : "No stream", clients: wss.clients.size };
      ws.send(JSON.stringify(status));
    } else {
      ws.send(JSON.stringify({ type: "error", message: "Unknown command" }));
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`Godot client disconnected (Remaining clients: ${wss.clients.size - 1})`);
    console.log(`Close code: ${code}, reason: ${reason}`);
    if (wss.clients.size === 0 && currentWebcast) {
      try {
        console.log("All clients disconnected - disconnecting from TikTok live");
        currentWebcast.disconnect();
        currentWebcast = null;
        console.log("TikTok live disconnected, awaiting new client connection");
      } catch (err) {
        console.warn("Error disconnecting from TikTok live:", err);
        currentWebcast = null;
      }
    } else if (wss.clients.size > 0) {
      console.log("Other clients still connected, keeping TikTok live active");
    }
  });

  ws.on("error", (error) => {
    console.log(`WebSocket error for client: ${error?.message || error}`);
  });
});

// CLI simulation
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("Type commands here for testing:");
console.log('gift Lion 2  // sends a Lion gift count 2 to Godot clients');
console.log('watch username  // asks bridge to start watching that username');
console.log('comment 3  // sends a chat comment "3" to Godot clients');
rl.on("line", (line) => {
  const parts = line.trim().split(/\s+/);
  if (!parts[0]) return;
  const cmd = parts[0].toLowerCase();
  if (cmd === "gift") {
    const gift = normalizeGiftName(parts[1]) || "UnknownGift";
    const count = Number(parts[2]) || 1;
    broadcast({ type: "gift", gift, count, from: "cli" });
    console.log(`Simulated gift ${gift} x${count}`);
  } else if (cmd === "watch") {
    const username = parts[1];
    if (!username) return console.log("Usage watch username");
    startWatching(username);
  } else if (cmd === "comment") {
    const text = parts.slice(1).join(" ") || "1";
    broadcast({ type: "comment", text, from: "cli" });
    console.log(`Simulated comment "${text}"`);
  } else {
    console.log("Unknown command", line);
  }
});

// Periodic status logging
setInterval(() => {
  const clientCount = wss.clients.size;
  const isWatching = currentWebcast !== null;
  if (clientCount === 0) console.log("Status: No clients connected, awaiting connection...");
  else if (clientCount === 1) console.log(`Status: ${clientCount} client connected, TikTok live: ${isWatching ? 'Active' : 'Inactive'}`);
  else console.log(`Status: ${clientCount} clients connected, TikTok live: ${isWatching ? 'Active' : 'Inactive'}`);
}, 30000);

// Graceful shutdown handling
function gracefulShutdown() {
  console.log("Bridge shutting down gracefully...");
  broadcast({ type: "bridge_shutdown", message: "Bridge is shutting down. Please reconnect." });
  wss.clients.forEach((client) => { if (client.readyState === WebSocket.OPEN) client.close(1000, "Bridge shutting down"); });
  if (currentWebcast) {
    try { currentWebcast.disconnect(); currentWebcast = null; } catch (err) { console.warn("Error disconnecting from TikTok live during shutdown:", err); }
  }
  wss.close(() => { console.log("WebSocket server closed"); process.exit(0); });
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('SIGHUP', gracefulShutdown);
// -------------------------------------------------------------------------
