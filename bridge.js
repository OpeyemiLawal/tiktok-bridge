const { WebcastPushConnection } = require("tiktok-live-connector");
const WebSocket = require("ws");
const readline = require("readline");

const WS_PORT = process.env.PORT || 8080; // allow cloud platforms like Render
let wss = new WebSocket.Server({ port: WS_PORT });
console.log(`WebSocket server listening on ws://0.0.0.0:${WS_PORT}`);

let currentWebcast = null;

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

  // Fallback to raw
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
    try { await currentWebcast.disconnect(); } catch (e) {}
    currentWebcast = null;
  }

  console.log(`Starting to watch TikTok live of ${username}`);
  const connection = new WebcastPushConnection(username);

  // Gift event
  connection.on("gift", (data) => {
    try {
      if (!data) return;

      // Extract gift info safely
      const rawGiftName = data?.gift?.name || data?.giftId || data?.gift?.id;
      const repeatCount = data?.repeat_count || data?.repeatCount || 1;
      const gift = normalizeGiftName(rawGiftName);
      if (!gift) {
        console.warn("Gift event with missing gift info, skipping");
        return;
      }

      const from = data?.uniqueId || data?.user?.uniqueId || "unknown";

      // Log gifts only
      console.log(`Gift: ${gift} x${repeatCount} from ${from}`);

      // Broadcast only gifts to clients
      broadcast({
        type: "gift",
        gift,
        count: Number(repeatCount) || 1,
        from
      });
    } catch (err) {
      console.warn("Error handling gift:", err?.toString?.() || err);
    }
  });

  // No chat listener at all

  connection.on("connected", (state) => {
    console.log("Connected to TikTok room", state.roomId);
  });

  connection.on("disconnected", (reason) => {
    console.log("TikTok connection disconnected", reason);
  });

  connection.on("error", (err) => {
    console.warn("TikTok connection error", err?.toString?.() || err);
    broadcast({
      type: "error",
      message: "Failed to connect to TikTok live for " + username
    });
  });

  try {
    await connection.connect();
    currentWebcast = connection;
  } catch (err) {
    console.error("Failed to connect to TikTok live", err?.toString?.() || err);
    broadcast({
      type: "error",
      message: "Failed to connect to TikTok live for " + username
    });
  }
}

// WebSocket server
wss.on("connection", (ws) => {
  console.log("Godot client connected via WebSocket");

  ws.on("message", (msg) => {
    let parsed = null;
    try { parsed = JSON.parse(msg.toString()); } catch (e) { return; }

    if (parsed.cmd === "watch" && parsed.username) {
      startWatching(parsed.username);
      ws.send(JSON.stringify({ type: "info", message: "Watching " + parsed.username }));
    } else if (parsed.cmd === "test" && parsed.gift) {
      broadcast({ type: "gift", gift: parsed.gift, count: parsed.count || 1, from: "test" });
    } else {
      ws.send(JSON.stringify({ type: "error", message: "Unknown command" }));
    }
  });

  ws.on("close", () => {
    console.log("Godot client disconnected");
  });
});

// CLI simulation
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("Type commands here for testing:");
console.log('gift Lion 2  // sends a Lion gift count 2 to Godot clients');
console.log('watch username  // asks bridge to start watching that username');

rl.on("line", (line) => {
  const parts = line.trim().split(/\s+/);
  if (!parts[0]) return;
  const cmd = parts[0].toLowerCase();
  if (cmd === "gift") {
    const gift = parts[1] || "GG";
    const count = Number(parts[2]) || 1;
    broadcast({ type: "gift", gift, count, from: "cli" });
    console.log(`Simulated gift ${gift} x${count}`);
  } else if (cmd === "watch") {
    const username = parts[1];
    if (!username) return console.log("Usage: watch username");
    startWatching(username);
  } else {
    console.log("Unknown command", line);
  }
});
