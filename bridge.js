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
        // For gift messages, safely handle giftDetails before processing
        if (type === 'WebcastGiftMessage' && originalObject && originalObject.giftDetails) {
          // Create a safe copy and ensure giftImage exists
          const safeObject = { ...originalObject };
          if (safeObject.giftDetails && !safeObject.giftDetails.giftImage) {
            safeObject.giftDetails.giftImage = {};
          }
          return originalSimplifyObject.call(this, type, safeObject);
        }
        // For all other types, use original function
        return originalSimplifyObject.call(this, type, originalObject);
      } catch (err) {
        console.warn("Error in simplified data converter, using safe fallback:", err);
        // Return a safe fallback object for gifts
        if (type === 'WebcastGiftMessage') {
          return {
            type: "gift",
            gift: "UnknownGift",
            count: 1,
            from: "unknown"
          };
        }
        // For other types, try to return original object
        return originalObject;
      }
    };
    console.log("Successfully patched TikTok data converter to prevent crashes");
  }
} catch (err) {
  console.warn("Could not patch TikTok data converter:", err);
}

const WS_PORT = process.env.PORT || 8081; // allow cloud platforms like Render
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

  // Fallback to raw with capitalization
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
    try { currentWebcast.disconnect(); } catch (e) {}
    currentWebcast = null;
  }

  console.log(`Starting to watch TikTok live of ${username}`);
  const connection = new WebcastPushConnection(username);

  // Enhanced gift event handling with multiple fallback strategies
  connection.on("gift", (data) => {
    try {
      // Multiple fallback strategies for gift data extraction
      let rawGiftName = null;
      let repeatCount = 1;
      let from = "unknown";

      // Strategy 1: Try to get gift name from various possible locations
      if (data?.gift?.name) {
        rawGiftName = data.gift.name;
      } else if (data?.giftId) {
        rawGiftName = data.giftId;
      } else if (data?.gift?.id) {
        rawGiftName = data.gift.id;
      } else if (data?.giftDetails?.giftName) {
        rawGiftName = data.giftDetails.giftName;
      } else if (data?.giftDetails?.giftId) {
        rawGiftName = data.giftDetails.giftId;
      } else {
        rawGiftName = "UnknownGift";
      }

      // Strategy 2: Try to get repeat count
      if (data?.repeat_count !== undefined) {
        repeatCount = Number(data.repeat_count);
      } else if (data?.repeatCount !== undefined) {
        repeatCount = Number(data.repeatCount);
      } else if (data?.giftDetails?.repeatCount !== undefined) {
        repeatCount = Number(data.giftDetails.repeatCount);
      }

      // Strategy 3: Try to get sender information
      if (data?.uniqueId) {
        from = data.uniqueId;
      } else if (data?.user?.uniqueId) {
        from = data.user.uniqueId;
      } else if (data?.sender?.uniqueId) {
        from = data.sender.uniqueId;
      }

      // Validate and normalize data
      if (isNaN(repeatCount) || repeatCount < 1) repeatCount = 1;
      const gift = normalizeGiftName(rawGiftName) || "UnknownGift";

      console.log(`Gift event → ${gift} x${repeatCount} from ${from}`);

      broadcast({
        type: "gift",
        gift,
        count: repeatCount,
        from
      });
    } catch (err) {
      console.warn("Error handling gift:", err);
      broadcast({
        type: "error",
        message: "Error while processing a gift event"
      });
    }
  });

  connection.on("connected", (state) => {
    console.log("Connected to TikTok room", state.roomId);
  });

  connection.on("disconnected", (reason) => {
    console.log("TikTok connection disconnected", reason);
  });

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
      const safeGift = normalizeGiftName(parsed.gift) || "UnknownGift";
      broadcast({ type: "gift", gift: safeGift, count: parsed.count || 1, from: "test" });
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
    const gift = normalizeGiftName(parts[1]) || "UnknownGift";
    const count = Number(parts[2]) || 1;
    broadcast({ type: "gift", gift, count, from: "cli" });
    console.log(`Simulated gift ${gift} x${count}`);
  } else if (cmd === "watch") {
    const username = parts[1];
    if (!username) return console.log("Usage watch username");
    startWatching(username);
  } else {
    console.log("Unknown command", line);
  }
});
