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
        // For gift messages, completely replace the problematic logic
        if (type === 'WebcastGiftMessage') {
          const webcastObject = { ...originalObject };
          
          // Safe gift object creation
          webcastObject.repeatEnd = !!webcastObject.repeatEnd;
          webcastObject.gift = {
            gift_id: webcastObject.giftId,
            repeat_count: webcastObject.repeatCount,
            repeat_end: webcastObject.repeatEnd ? 1 : 0,
            gift_type: webcastObject.giftDetails?.giftType
          };

          // Safely merge giftDetails without accessing giftImage
          if (webcastObject.giftDetails) {
            // Copy all properties except giftImage to avoid the crash
            const safeGiftDetails = { ...webcastObject.giftDetails };
            delete safeGiftDetails.giftImage;
            
            // Merge the safe giftDetails
            Object.assign(webcastObject, safeGiftDetails);
            delete webcastObject.giftDetails;
          }

          // Handle giftExtra safely
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

          // Handle monitorExtra safely
          if (webcastObject.monitorExtra?.startsWith('{')) {
            try {
              webcastObject.monitorExtra = JSON.parse(webcastObject.monitorExtra);
            } catch (err) {}
          }

          return webcastObject;
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
  
  // Disconnect from any existing live stream
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

  // Enhanced gift event handling with multiple fallback strategies
  // Note: This event might be problematic due to TikTok library issues
  // We'll use rawData handler as primary method
  connection.on("gift", (data) => {
    try {
      // Log the raw data for debugging (first 200 chars)
      console.log("Gift event received (processed):", JSON.stringify(data).substring(0, 200));
      
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
      } else if (data?.gift_id) {
        rawGiftName = data.gift_id;
      } else if (data?.gift_type) {
        rawGiftName = data.gift_type;
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
      } else if (data?.userId) {
        from = data.userId;
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
  
  // Add a raw message handler to catch gifts before they go through the problematic processing
  connection.on("rawData", (rawData) => {
    try {
      // Look for gift-related data in raw messages
      if (rawData && typeof rawData === 'object') {
        // Check if this looks like a gift message
        if (rawData.giftId || rawData.giftDetails || rawData.gift) {
          console.log("Raw gift data detected, processing directly:", JSON.stringify(rawData).substring(0, 200));
          
          // Extract gift information directly from raw data
          let giftName = rawData.giftId || rawData.gift?.id || "UnknownGift";
          let count = rawData.repeatCount || rawData.repeat_count || 1;
          let sender = rawData.userId || rawData.user?.uniqueId || "unknown";
          
          const gift = normalizeGiftName(giftName);
          console.log(`Direct gift processing → ${gift} x${count} from ${sender}`);
          
          broadcast({
            type: "gift",
            gift,
            count: Number(count) || 1,
            from: sender
          });
        }
      }
    } catch (err) {
      console.warn("Error in raw data handler:", err);
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
  
  // Add a global error handler for the connection to catch any unhandled errors
  connection.on("error", (err) => {
    console.warn("TikTok connection error (global):", err?.toString?.() || err);
    // Don't broadcast this to avoid spam, just log it
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
    } else if (parsed.cmd === "status") {
      // Return current status
      const status = {
        type: "status",
        connected: currentWebcast !== null,
        watching: currentWebcast ? "TikTok live stream" : "No stream",
        clients: wss.clients.size
      };
      ws.send(JSON.stringify(status));
    } else {
      ws.send(JSON.stringify({ type: "error", message: "Unknown command" }));
    }
  });

  ws.on("close", () => {
    console.log(`Godot client disconnected (Remaining clients: ${wss.clients.size - 1})`);
    
    // Only disconnect from TikTok live if no clients remain
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

// Periodic status logging
setInterval(() => {
  const clientCount = wss.clients.size;
  const isWatching = currentWebcast !== null;
  
  if (clientCount === 0) {
    console.log("Status: No clients connected, awaiting connection...");
  } else if (clientCount === 1) {
    console.log(`Status: ${clientCount} client connected, TikTok live: ${isWatching ? 'Active' : 'Inactive'}`);
  } else {
    console.log(`Status: ${clientCount} clients connected, TikTok live: ${isWatching ? 'Active' : 'Inactive'}`);
  }
}, 30000); // Log status every 30 seconds
