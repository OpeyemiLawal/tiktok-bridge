import WebSocket, { WebSocketServer } from "ws";
import { WebcastPushConnection } from "tiktok-live-connector";

// Pick Render’s assigned port or default to 8080 locally
const PORT = process.env.PORT || 8080;

// WebSocket server for Godot (and other clients)
const wss = new WebSocketServer({ port: PORT });
console.log(`WebSocket server listening on ws://0.0.0.0:${PORT}`);

// Active TikTok connection
let tiktokLiveConnection = null;

// Broadcast to all connected WebSocket clients
function broadcast(msg) {
    const json = JSON.stringify(msg);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(json);
        }
    });
}

// Handle messages from Godot/clients
wss.on("connection", (ws) => {
    console.log("Godot client connected via WebSocket");

    ws.on("message", (message) => {
        const msg = message.toString().trim();

        if (msg.startsWith("watch ")) {
            const username = msg.split(" ")[1];
            if (!username) return;
            startTikTok(username);
        } else if (msg.startsWith("gift ")) {
            const parts = msg.split(" ");
            const giftName = parts[1] || "TestGift";
            const count = parseInt(parts[2] || "1");
            const from = parts[3] || "Tester";

            broadcast({ type: "gift", gift: giftName, count, from });
        }
    });
});

// Start TikTok connection
function startTikTok(username) {
    if (tiktokLiveConnection) {
        tiktokLiveConnection.disconnect();
    }

    console.log(`Starting to watch TikTok live of ${username}`);
    tiktokLiveConnection = new WebcastPushConnection(username);

    tiktokLiveConnection.connect()
        .then(state => {
            console.log(`Connected to TikTok room ${state.roomId}`);
        })
        .catch(err => {
            console.error("TikTok connection error", err);
        });

    // Chat
    tiktokLiveConnection.on("chat", (data) => {
        console.log(`${data.uniqueId}: ${data.comment}`);
        broadcast({
            type: "chat",
            from: data.uniqueId,
            text: data.comment
        });
    });

    // Gift
    tiktokLiveConnection.on("gift", (data) => {
        const giftId = data.giftId || "unknown";
        const giftName = data.giftName || "Unknown Gift";
        const giftCount = data.repeatCount || 1;
        const username = data.uniqueId || "anonymous";

        let giftImage = null;
        if (data.giftDetails && data.giftDetails.giftImage) {
            giftImage = data.giftDetails.giftImage.url;
        }

        console.log(`Gift event: ${giftName} (${giftId}) count ${giftCount} from ${username}`);

        broadcast({
            type: "gift",
            gift: giftName,
            giftId: giftId,
            count: giftCount,
            from: username,
            image: giftImage
        });
    });

    // Other events
    tiktokLiveConnection.on("follow", (data) => {
        broadcast({ type: "follow", from: data.uniqueId });
    });

    tiktokLiveConnection.on("share", (data) => {
        broadcast({ type: "share", from: data.uniqueId });
    });

    tiktokLiveConnection.on("like", (data) => {
        broadcast({ type: "like", from: data.uniqueId, likes: data.likeCount });
    });
}

// Local terminal input (for testing)
process.stdin.on("data", (chunk) => {
    const cmd = chunk.toString().trim();
    if (cmd.startsWith("watch ")) {
        const username = cmd.split(" ")[1];
        startTikTok(username);
    } else if (cmd.startsWith("gift ")) {
        const parts = cmd.split(" ");
        const giftName = parts[1] || "TestGift";
        const count = parseInt(parts[2] || "1");
        const from = parts[3] || "Tester";

        broadcast({ type: "gift", gift: giftName, count, from });
    }
});
