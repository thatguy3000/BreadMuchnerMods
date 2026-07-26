import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION } from "../shared/constants.js";
import { makeMessage, parseClientMessage, validateRoomCode } from "../shared/protocol.js";
import { RoomManager } from "./room-manager.js";

const publicRoot = resolve(fileURLToPath(new URL("../public", import.meta.url)));
const sharedRoot = resolve(fileURLToPath(new URL("../shared", import.meta.url)));
const requestedPort = Number(process.env.PORT);
const port = Number.isInteger(requestedPort) && requestedPort >= 0 && requestedPort <= 65_535 ? requestedPort : 8080;
const host = process.env.HOST || "0.0.0.0";
const production = process.env.NODE_ENV === "production";
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean));
const log = (record) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...record }));
const manager = new RoomManager({ log });
const socketRooms = new WeakMap();
const ipConnections = new Map();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

function safePublicPath(url) {
  const pathname = decodeURIComponent(new URL(url, "http://local").pathname);
  if (pathname.startsWith("/shared/")) {
    const requested = pathname.slice("/shared/".length);
    const candidate = normalize(join(sharedRoot, requested));
    return candidate === sharedRoot || candidate.startsWith(sharedRoot + sep) ? candidate : null;
  }
  // Accept both the canonical root URL and /public/... so the app also works
  // when a local preview tool exposes the repository root.
  const publicPath = pathname === "/public" || pathname === "/public/"
    ? "/"
    : pathname.replace(/^\/public\//, "/");
  const requested = publicPath === "/" ? "index.html" : publicPath.replace(/^\/+/, "");
  const candidate = normalize(join(publicRoot, requested));
  return candidate === publicRoot || candidate.startsWith(publicRoot + sep) ? candidate : null;
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      rooms: manager.rooms.size,
      uptimeSeconds: Math.round(process.uptime())
    }));
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }
  let path;
  try {
    path = safePublicPath(request.url);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypes[extname(path)] || "application/octet-stream",
    "cache-control": production ? "public, max-age=300" : "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "content-security-policy": "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; img-src 'self' data:"
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(path).pipe(response);
});

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return !production;
  if (allowedOrigins.has(origin)) return true;
  try {
    const value = new URL(origin);
    const requestHost = request.headers.host;
    if (value.host === requestHost && (value.protocol === "http:" || value.protocol === "https:")) return true;
    return !production && (value.hostname === "localhost" || value.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

const webSockets = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MESSAGE_BYTES,
  perMessageDeflate: false
});

server.on("upgrade", (request, socket, head) => {
  if (new URL(request.url, "http://local").pathname !== "/ws" || !originAllowed(request)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const ip = request.socket.remoteAddress || "unknown";
  const count = ipConnections.get(ip) || 0;
  if (count >= 12) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10_000);
  webSockets.handleUpgrade(request, socket, head, (webSocket) => {
    webSocket.clientIp = ip;
    webSockets.emit("connection", webSocket, request);
  });
});

webSockets.on("connection", (socket) => {
  const ip = socket.clientIp;
  ipConnections.set(ip, (ipConnections.get(ip) || 0) + 1);
  log({ level: "info", event: "socket_connected", ip });

  socket.on("message", (data) => {
    const parsed = parseClientMessage(data);
    if (parsed.error) {
      socket.send(JSON.stringify(makeMessage("error", {
        code: parsed.error,
        message: parsed.error === "VERSION_MISMATCH"
          ? "This game client is out of date. Refresh the page to update."
          : "The server rejected an invalid message."
      })));
      return;
    }
    const message = parsed.value;
    const currentRoom = socketRooms.get(socket);

    if (message.type === "createRoom") {
      if (currentRoom) {
        currentRoom.error(socket, "ALREADY_IN_ROOM", "Leave the current room before creating another.");
        return;
      }
      const room = manager.createRoom();
      if (!room) {
        socket.send(JSON.stringify(makeMessage("error", { code: "SERVER_FULL", message: "The server cannot create another room right now." })));
        return;
      }
      socketRooms.set(socket, room);
      room.addConnection(socket);
      room.send(socket, makeMessage("roomCreated", { roomCode: room.code }));
      return;
    }

    if (message.type === "joinRoom") {
      if (currentRoom) {
        currentRoom.error(socket, "ALREADY_IN_ROOM", "Leave the current room before joining another.");
        return;
      }
      const code = validateRoomCode(message.roomCode);
      const room = code && manager.getRoom(code);
      if (!room) {
        socket.send(JSON.stringify(makeMessage("error", { code: "ROOM_NOT_FOUND", message: "That room code is invalid or has expired." })));
        return;
      }
      if (room.connections.size >= 6 && !message.reconnectToken) {
        socket.send(JSON.stringify(makeMessage("error", { code: "ROOM_FULL", message: "That room already has six connected players." })));
        return;
      }
      socketRooms.set(socket, room);
      room.addConnection(socket, { reconnectToken: message.reconnectToken });
      return;
    }

    if (message.type === "ping" && !currentRoom) {
      socket.send(JSON.stringify(makeMessage("pong", {
        clientTime: Number.isFinite(message.clientTime) ? message.clientTime : null,
        serverTime: Date.now()
      })));
      return;
    }

    if (!currentRoom) {
      socket.send(JSON.stringify(makeMessage("error", { code: "NOT_IN_ROOM", message: "Create or join a room first." })));
      return;
    }
    currentRoom.handle(socket, message);
  });

  socket.on("close", () => {
    const room = socketRooms.get(socket);
    if (room) room.removeConnection(socket);
    ipConnections.set(ip, Math.max(0, (ipConnections.get(ip) || 1) - 1));
    if (ipConnections.get(ip) === 0) ipConnections.delete(ip);
    log({ level: "info", event: "socket_disconnected", ip });
  });

  socket.on("error", (error) => {
    log({ level: "error", event: "socket_error", ip, message: error.message });
  });
});

export const ready = new Promise((resolveReady, rejectReady) => {
  server.once("error", rejectReady);
  server.listen(port, host, () => {
    server.removeListener("error", rejectReady);
    const address = server.address();
    const listeningPort = typeof address === "object" && address ? address.port : port;
    log({ level: "info", event: "server_started", host, port: listeningPort, protocolVersion: PROTOCOL_VERSION });
    resolveReady({ host, port: listeningPort });
  });
});

let closePromise = null;

export function closeServer() {
  if (closePromise) return closePromise;
  webSockets.close();
  manager.close();
  closePromise = new Promise((resolveClose) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close(resolveClose);
  });
  return closePromise;
}

function shutdown(signal) {
  log({ level: "info", event: "server_shutdown", signal });
  closeServer().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  log({ level: "error", event: "uncaught_exception", message: error.message, stack: error.stack });
});
process.on("unhandledRejection", (error) => {
  log({ level: "error", event: "unhandled_rejection", message: error?.message || String(error) });
});

export { manager, server, webSockets };
