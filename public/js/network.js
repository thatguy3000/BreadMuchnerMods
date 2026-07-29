import { INPUT_RESEND_MS, PROTOCOL_VERSION } from "../../shared/constants.js";
import { makeMessage } from "../../shared/protocol.js";
import { applySnapshotDelta } from "../../shared/simulation.js";

export class OnlineClient extends EventTarget {
  constructor() {
    super();
    this.socket = null;
    this.roomCode = null;
    this.ownedSeat = null;
    this.isHost = false;
    this.sequence = 0;
    this.lastSentAt = 0;
    this.lastInputKey = "";
    this.latestSnapshot = null;
    this.lastSnapshotAt = 0;
    this.latency = null;
    this.intentionalClose = false;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.reconnectAttempts = 0;
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect() {
    if (this.connected || this.socket?.readyState === WebSocket.CONNECTING) return Promise.resolve();
    this.intentionalClose = false;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("The online server did not respond."));
      }, 5000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        this.reconnectAttempts = 0;
        this.dispatch("connection", { state: "connected" });
        this.startPings();
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        if (socket.readyState !== WebSocket.OPEN) reject(new Error("The online server is unavailable."));
      }, { once: true });
      socket.addEventListener("message", (event) => this.receive(event.data));
      socket.addEventListener("close", () => this.closed(socket));
    });
  }

  async createRoom() {
    await this.connect();
    this.send("createRoom");
  }

  async joinRoom(roomCode, { reconnect = false } = {}) {
    await this.connect();
    const code = String(roomCode || "").toUpperCase();
    const reconnectToken = reconnect ? sessionStorage.getItem(`breadsim-reconnect:${code}`) : null;
    this.send("joinRoom", { roomCode: code, reconnectToken });
  }

  claimSeat(seat) {
    this.send("claimSeat", { roomCode: this.roomCode, seat });
  }

  releaseSeat() {
    if (this.ownedSeat) this.send("releaseSeat", { roomCode: this.roomCode, seat: this.ownedSeat });
  }

  updatePlayer(player) {
    if (!this.ownedSeat) return;
    this.send("updateLobbyPlayer", { roomCode: this.roomCode, seat: this.ownedSeat, player });
  }

  requestSwap(targetSeat) {
    this.send("createSwapRequest", { roomCode: this.roomCode, targetSeat });
  }

  respondSwap(requestId, accepted) {
    this.send("respondSwapRequest", { roomCode: this.roomCode, requestId, accepted });
  }

  reviewSwap(requestId, accepted) {
    this.send("reviewSwapRequest", { roomCode: this.roomCode, requestId, accepted });
  }

  cancelSwap(requestId) {
    this.send("cancelSwapRequest", { roomCode: this.roomCode, requestId });
  }

  command(type) {
    this.send(type, { roomCode: this.roomCode });
  }

  sendInput(input, { force = false } = {}) {
    if (!this.connected || !this.roomCode || !this.ownedSeat) return null;
    const key = JSON.stringify(input);
    const now = performance.now();
    if (!force && key === this.lastInputKey && now - this.lastSentAt < INPUT_RESEND_MS) return null;
    this.sequence += 1;
    this.lastInputKey = key;
    this.lastSentAt = now;
    this.send("playerInput", {
      roomCode: this.roomCode,
      seat: this.ownedSeat,
      sequence: this.sequence,
      input
    });
    return this.sequence;
  }

  sendNeutral() {
    this.sendInput({ x: 0, y: 0, rotation: 0, action: false, toggleIntake: false, unstick: false }, { force: true });
  }

  requestFullSnapshot() {
    this.send("requestFullSnapshot", { roomCode: this.roomCode });
  }

  leave() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    if (this.connected) this.releaseSeat();
    if (this.roomCode) sessionStorage.removeItem(`breadsim-reconnect:${this.roomCode}`);
    this.socket?.close(1000, "Left room");
    this.socket = null;
    this.roomCode = null;
    this.ownedSeat = null;
    this.isHost = false;
    this.latestSnapshot = null;
    this.dispatch("connection", { state: "offline" });
  }

  send(type, payload = {}) {
    if (!this.connected) return false;
    this.socket.send(JSON.stringify(makeMessage(type, payload)));
    return true;
  }

  receive(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.version !== PROTOCOL_VERSION) {
      this.dispatch("serverError", { code: "VERSION_MISMATCH", message: "Refresh the page to use the current server version." });
      return;
    }
    if (message.roomCode) this.roomCode = message.roomCode;
    if (message.type === "roomCreated") {
      this.roomCode = message.roomCode;
      this.dispatch("roomCreated", message);
    } else if (message.type === "roomState") {
      this.roomCode = message.roomCode;
      this.ownedSeat = message.ownedSeat;
      this.isHost = message.isHost;
      this.dispatch("roomState", message);
    } else if (message.type === "seatAssigned") {
      this.ownedSeat = message.seat;
      sessionStorage.setItem(`breadsim-reconnect:${message.roomCode}`, message.reconnectToken);
      sessionStorage.setItem("breadsim-last-room", message.roomCode);
      this.dispatch("seatAssigned", message);
    } else if (message.type === "snapshot") {
      this.latestSnapshot = applySnapshotDelta(this.latestSnapshot, message.snapshot);
      this.lastSnapshotAt = performance.now();
      this.dispatch("snapshot", this.latestSnapshot);
    } else if (message.type === "pong") {
      this.latency = Number.isFinite(message.clientTime) ? Math.max(0, performance.now() - message.clientTime) : null;
      this.dispatch("quality", { latency: this.latency });
    } else if (message.type === "error") {
      this.dispatch("serverError", message);
    } else {
      this.dispatch(message.type, message);
    }
  }

  closed(socket) {
    if (socket !== this.socket) return;
    clearInterval(this.pingTimer);
    this.socket = null;
    if (this.intentionalClose || !this.roomCode) {
      this.dispatch("connection", { state: "offline" });
      return;
    }
    this.dispatch("connection", { state: "reconnecting" });
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(5000, 500 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(async () => {
      const roomCode = this.roomCode;
      try {
        await this.joinRoom(roomCode, { reconnect: true });
      } catch {
        if (this.reconnectAttempts < 12) this.scheduleReconnect();
        else this.dispatch("connection", { state: "lost" });
      }
    }, delay);
  }

  startPings() {
    clearInterval(this.pingTimer);
    const ping = () => this.send("ping", { clientTime: performance.now() });
    ping();
    this.pingTimer = setInterval(ping, 2000);
  }

  dispatch(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
