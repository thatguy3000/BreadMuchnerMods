import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  EMPTY_ROOM_GRACE_MS,
  FIXED_DT,
  FULL_SNAPSHOT_INTERVAL_MS,
  INPUT_TIMEOUT_MS,
  LOBBY_IDLE_MS,
  NEUTRAL_INPUT,
  RECONNECT_GRACE_MS,
  SNAPSHOT_RATE
} from "../shared/constants.js";
import {
  makeMessage,
  normalizeInput,
  publicLobbyPlayer,
  sanitizeLobbyUpdate,
  validateSeat
} from "../shared/protocol.js";
import { createGameState, reconfigurePlayer } from "../shared/state.js";
import {
  createSnapshotDelta,
  resetMatch,
  serializeSnapshot,
  startMatch,
  stepSimulation,
  stopMatch
} from "../shared/simulation.js";

const token = () => randomBytes(24).toString("base64url");
const connectionId = () => randomBytes(9).toString("base64url");
const socketOpen = (socket) => socket.readyState === 1;

export class GameRoom {
  constructor(code, { onEmpty, log = console.log, seed } = {}) {
    this.code = code;
    this.state = createGameState({ seed });
    this.connections = new Map();
    this.ownership = new Map();
    this.inputs = new Map();
    this.pendingSwaps = new Map();
    this.nextSwapId = 1;
    this.hostId = null;
    this.onEmpty = onEmpty;
    this.log = log;
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.emptySince = null;
    this.previousSnapshot = null;
    this.lastFullSnapshotAt = 0;
    this.lastSnapshotAt = 0;
    this.lastLoopAt = performance.now();
    this.accumulator = 0;
    this.closed = false;
    this.timer = setInterval(() => this.loop(), 8);
    this.timer.unref?.();
  }

  addConnection(socket, { reconnectToken } = {}) {
    const entry = {
      id: connectionId(),
      socket,
      seat: null,
      joinedAt: Date.now(),
      commandWindowAt: Date.now(),
      commandsInWindow: 0,
      inputWindowAt: Date.now(),
      inputsInWindow: 0
    };
    this.connections.set(socket, entry);
    if (!this.hostId) this.hostId = entry.id;
    this.emptySince = null;
    this.touch();

    if (typeof reconnectToken === "string") {
      for (const [seat, owner] of this.ownership) {
        if (owner.token === reconnectToken && !owner.connected && owner.disconnectDeadline > Date.now()) {
          owner.connectionId = entry.id;
          owner.socket = socket;
          owner.connected = true;
          owner.disconnectDeadline = null;
          entry.seat = seat;
          this.send(socket, makeMessage("seatAssigned", {
            roomCode: this.code,
            seat,
            reconnectToken: owner.token,
            reconnected: true
          }));
          this.sendSnapshot(socket, true);
          this.logEvent("seat_reconnected", { seat });
          break;
        }
      }
    }

    this.sendRoomState(socket);
    this.broadcastRoomState();
    return entry;
  }

  removeConnection(socket) {
    const entry = this.connections.get(socket);
    if (!entry) return;
    this.connections.delete(socket);
    if (entry.seat) {
      const owner = this.ownership.get(entry.seat);
      if (owner?.connectionId === entry.id) {
        owner.connected = false;
        owner.socket = null;
        owner.disconnectDeadline = Date.now() + RECONNECT_GRACE_MS;
        this.inputs.set(entry.seat, { ...NEUTRAL_INPUT, receivedAt: Date.now() });
        this.logEvent("seat_disconnected", { seat: entry.seat });
      }
    }
    if (entry.id === this.hostId) this.transferHost();
    if (this.connections.size === 0) this.emptySince = Date.now();
    this.broadcastRoomState();
  }

  handle(socket, message) {
    const entry = this.connections.get(socket);
    if (!entry) return;
    this.touch();
    if (message.type !== "playerInput" && !this.allowCommand(entry)) {
      this.error(socket, "RATE_LIMITED", "Too many room commands. Please wait a moment.");
      return;
    }

    switch (message.type) {
      case "claimSeat":
        this.claimSeat(entry, message);
        break;
      case "releaseSeat":
        this.releaseSeat(entry, false);
        break;
      case "updateLobbyPlayer":
        this.updateLobby(entry, message);
        break;
      case "createSwapRequest":
        this.createSwapRequest(entry, message);
        break;
      case "respondSwapRequest":
        this.respondSwapRequest(entry, message);
        break;
      case "reviewSwapRequest":
        this.reviewSwapRequest(entry, message);
        break;
      case "cancelSwapRequest":
        this.cancelSwapRequest(entry, message);
        break;
      case "startMatch":
        this.hostCommand(entry, "start");
        break;
      case "stopMatch":
        this.hostCommand(entry, "stop");
        break;
      case "resetMatch":
        this.hostCommand(entry, "reset");
        break;
      case "playerInput":
        this.playerInput(entry, message);
        break;
      case "requestFullSnapshot":
        this.sendSnapshot(socket, true);
        break;
      case "ping":
        this.send(socket, makeMessage("pong", {
          clientTime: Number.isFinite(message.clientTime) ? message.clientTime : null,
          serverTime: Date.now()
        }));
        break;
      default:
        this.error(socket, "INVALID_ROOM_COMMAND", "That command is not valid while inside a room.");
    }
  }

  claimSeat(entry, message) {
    if (entry.seat) {
      this.error(entry.socket, "SEAT_ALREADY_CLAIMED", "This browser already owns a seat.");
      return;
    }
    if (this.state.status !== "lobby" && this.state.status !== "results") {
      this.error(entry.socket, "LOBBY_LOCKED", "Seats cannot change during countdown or play.");
      return;
    }
    const seat = validateSeat(message.seat);
    if (!seat) {
      this.error(entry.socket, "INVALID_SEAT", "Choose a seat from 1 through 6.");
      return;
    }
    const existing = this.ownership.get(seat);
    if (existing) {
      this.error(entry.socket, existing.connected ? "SEAT_TAKEN" : "SEAT_RESERVED", existing.connected
        ? "That seat is already claimed."
        : "That seat is temporarily reserved for a reconnecting player.");
      return;
    }
    if (this.swapSeatReserved(seat)) {
      this.error(entry.socket, "SEAT_SWAP_RESERVED", "That spot is reserved by a pending swap request.");
      return;
    }
    const reconnectToken = token();
    entry.seat = seat;
    this.ownership.set(seat, {
      connectionId: entry.id,
      socket: entry.socket,
      token: reconnectToken,
      connected: true,
      disconnectDeadline: null
    });
    this.inputs.set(seat, { ...NEUTRAL_INPUT, receivedAt: Date.now() });
    this.send(entry.socket, makeMessage("seatAssigned", { roomCode: this.code, seat, reconnectToken }));
    this.sendSnapshot(entry.socket, true);
    this.broadcastRoomState();
    this.logEvent("seat_claimed", { seat });
  }

  releaseSeat(entry, disconnecting) {
    if (!entry.seat) return;
    if (!disconnecting && this.state.status !== "lobby" && this.state.status !== "results") {
      this.error(entry.socket, "LOBBY_LOCKED", "Stop the match before releasing a seat.");
      return;
    }
    const seat = entry.seat;
    this.cancelSwapRequestsForSeat(seat, "A player involved in the request left their spot.");
    const owner = this.ownership.get(seat);
    if (owner?.connectionId === entry.id) {
      this.ownership.delete(seat);
      this.inputs.delete(seat);
    }
    entry.seat = null;
    this.broadcastRoomState();
    this.logEvent("seat_released", { seat });
  }

  updateLobby(entry, message) {
    if (!entry.seat) {
      this.error(entry.socket, "NO_SEAT", "Claim a seat before changing player settings.");
      return;
    }
    if (message.seat !== entry.seat) {
      this.error(entry.socket, "NOT_SEAT_OWNER", "You can only update your own player.");
      return;
    }
    if (this.state.status !== "lobby" && this.state.status !== "results") {
      this.error(entry.socket, "LOBBY_LOCKED", "Player settings are locked during countdown and play.");
      return;
    }
    const update = sanitizeLobbyUpdate(message.player);
    if (!update) {
      this.error(entry.socket, "INVALID_PLAYER_UPDATE", "The player settings were invalid.");
      return;
    }
    reconfigurePlayer(this.state, entry.seat, update);
    this.previousSnapshot = null;
    this.broadcastRoomState();
    this.broadcastSnapshot(true);
  }

  matchActive() {
    return this.state.status === "countdown" || this.state.status === "running";
  }

  swapSeatReserved(seat) {
    return [...this.pendingSwaps.values()].some((request) => request.sourceSeat === seat || request.targetSeat === seat);
  }

  swapSummary(request) {
    return {
      id: request.id,
      sourceSeat: request.sourceSeat,
      targetSeat: request.targetSeat,
      status: request.status,
      createdAt: request.createdAt
    };
  }

  createSwapRequest(entry, message) {
    if (!entry.seat) {
      this.error(entry.socket, "NO_SEAT", "Claim a player spot before requesting a swap.");
      return;
    }
    const targetSeat = validateSeat(message.targetSeat);
    if (!targetSeat || targetSeat === entry.seat) {
      this.error(entry.socket, "INVALID_SWAP_TARGET", "Choose a different spot from 1 through 6.");
      return;
    }
    if (this.swapSeatReserved(entry.seat) || this.swapSeatReserved(targetSeat)) {
      this.error(entry.socket, "SWAP_CONFLICT", "One of those spots already has a pending request.");
      return;
    }
    const targetOwner = this.ownership.get(targetSeat);
    const request = {
      id: `swap-${this.nextSwapId++}`,
      requesterId: entry.id,
      sourceSeat: entry.seat,
      targetSeat,
      targetConnectionId: targetOwner?.connectionId || null,
      status: this.matchActive() ? "queued" : targetOwner ? "awaiting_target" : "awaiting_host",
      createdAt: Date.now()
    };
    this.pendingSwaps.set(request.id, request);
    this.broadcastRoomState();
    this.logEvent("swap_requested", this.swapSummary(request));
  }

  getSwapRequest(entry, message) {
    if (typeof message.requestId !== "string" || message.requestId.length > 32) {
      this.error(entry.socket, "INVALID_SWAP_REQUEST", "That swap request is invalid.");
      return null;
    }
    const request = this.pendingSwaps.get(message.requestId);
    if (!request) {
      this.error(entry.socket, "SWAP_NOT_FOUND", "That swap request is no longer pending.");
      return null;
    }
    return request;
  }

  respondSwapRequest(entry, message) {
    const request = this.getSwapRequest(entry, message);
    if (!request) return;
    if (this.matchActive() || request.status !== "awaiting_target") {
      this.error(entry.socket, "SWAP_NOT_READY", "This request is not awaiting the target player's response.");
      return;
    }
    if (entry.seat !== request.targetSeat || entry.id !== request.targetConnectionId) {
      this.error(entry.socket, "SWAP_TARGET_ONLY", "Only the requested target player can answer this step.");
      return;
    }
    if (typeof message.accepted !== "boolean") {
      this.error(entry.socket, "INVALID_SWAP_RESPONSE", "Swap responses must explicitly accept or deny the request.");
      return;
    }
    if (!message.accepted) {
      this.rejectSwap(request, "The target player denied the swap request.");
      return;
    }
    request.status = "awaiting_host";
    this.broadcastRoomState();
    this.logEvent("swap_target_accepted", this.swapSummary(request));
  }

  reviewSwapRequest(entry, message) {
    const request = this.getSwapRequest(entry, message);
    if (!request) return;
    if (entry.id !== this.hostId) {
      this.error(entry.socket, "HOST_ONLY", "Only the room host can approve the final swap.");
      return;
    }
    if (this.matchActive() || request.status !== "awaiting_host") {
      this.error(entry.socket, "SWAP_NOT_READY", "This request is not ready for host review.");
      return;
    }
    if (typeof message.accepted !== "boolean") {
      this.error(entry.socket, "INVALID_SWAP_RESPONSE", "Swap responses must explicitly accept or deny the request.");
      return;
    }
    if (!message.accepted) {
      this.rejectSwap(request, "The host denied the swap request.");
      return;
    }
    this.applySwap(request, entry.socket);
  }

  cancelSwapRequest(entry, message) {
    const request = this.getSwapRequest(entry, message);
    if (!request) return;
    if (entry.id !== request.requesterId && entry.id !== this.hostId) {
      this.error(entry.socket, "SWAP_CANCEL_FORBIDDEN", "Only the requester or host can cancel this request.");
      return;
    }
    this.rejectSwap(request, "The swap request was canceled.");
  }

  rejectSwap(request, message) {
    this.pendingSwaps.delete(request.id);
    this.broadcast(makeMessage("swapRejected", { roomCode: this.code, requestId: request.id, message }));
    this.broadcastRoomState();
    this.logEvent("swap_rejected", { ...this.swapSummary(request), message });
  }

  applySwap(request, socket) {
    const sourceOwner = this.ownership.get(request.sourceSeat);
    const targetOwner = this.ownership.get(request.targetSeat);
    if (!sourceOwner || sourceOwner.connectionId !== request.requesterId) {
      this.error(socket, "SWAP_STALE", "The requesting player no longer owns the original spot.");
      this.rejectSwap(request, "The requesting player changed spots before approval.");
      return;
    }
    if ((request.targetConnectionId && targetOwner?.connectionId !== request.targetConnectionId)
      || (!request.targetConnectionId && targetOwner)) {
      this.error(socket, "SWAP_STALE", "The destination spot changed before approval.");
      this.rejectSwap(request, "The destination spot changed before approval.");
      return;
    }

    const sourcePlayer = this.state.players.find((player) => player.seat === request.sourceSeat);
    const targetPlayer = this.state.players.find((player) => player.seat === request.targetSeat);
    if (targetOwner) {
      this.ownership.set(request.sourceSeat, targetOwner);
      this.ownership.set(request.targetSeat, sourceOwner);
      const targetEntry = [...this.connections.values()].find((item) => item.id === targetOwner.connectionId);
      if (targetEntry) targetEntry.seat = request.sourceSeat;
      [sourcePlayer.name, targetPlayer.name] = [targetPlayer.name, sourcePlayer.name];
    } else {
      this.ownership.delete(request.sourceSeat);
      this.ownership.set(request.targetSeat, sourceOwner);
      targetPlayer.name = sourcePlayer.name;
      sourcePlayer.name = `Player ${request.sourceSeat}`;
      this.inputs.delete(request.sourceSeat);
    }
    const sourceEntry = [...this.connections.values()].find((item) => item.id === sourceOwner.connectionId);
    if (sourceEntry) sourceEntry.seat = request.targetSeat;
    const neutral = () => ({ ...NEUTRAL_INPUT, receivedAt: Date.now() });
    this.inputs.set(request.targetSeat, neutral());
    if (targetOwner) this.inputs.set(request.sourceSeat, neutral());

    this.pendingSwaps.delete(request.id);
    this.previousSnapshot = null;
    this.broadcast(makeMessage("swapApplied", {
      roomCode: this.code,
      requestId: request.id,
      sourceSeat: request.sourceSeat,
      targetSeat: request.targetSeat,
      occupied: Boolean(targetOwner)
    }));
    this.broadcastRoomState();
    this.broadcastSnapshot(true);
    this.logEvent("swap_applied", this.swapSummary(request));
  }

  activateQueuedSwaps() {
    let changed = false;
    for (const request of this.pendingSwaps.values()) {
      if (request.status !== "queued") continue;
      const targetOwner = this.ownership.get(request.targetSeat);
      request.targetConnectionId = targetOwner?.connectionId || null;
      request.status = targetOwner ? "awaiting_target" : "awaiting_host";
      changed = true;
    }
    if (changed) this.broadcastRoomState();
  }

  cancelSwapRequestsForSeat(seat, message) {
    const requests = [...this.pendingSwaps.values()].filter((request) => request.sourceSeat === seat || request.targetSeat === seat);
    for (const request of requests) this.rejectSwap(request, message);
  }

  hostCommand(entry, command) {
    if (entry.id !== this.hostId) {
      this.error(entry.socket, "HOST_ONLY", "Only the room host can control the match.");
      return;
    }
    if (command === "start") {
      if (!entry.seat) {
        this.error(entry.socket, "HOST_NEEDS_SEAT", "The host must claim a seat before starting.");
        return;
      }
      if (this.ownership.size === 0) {
        this.error(entry.socket, "EMPTY_LOBBY", "At least one seat must be claimed.");
        return;
      }
      if (this.pendingSwaps.size > 0) {
        this.error(entry.socket, "SWAPS_PENDING", "Resolve or cancel every swap request before starting another match.");
        return;
      }
      if (!startMatch(this.state)) {
        this.error(entry.socket, "MATCH_ACTIVE", "The match is already starting or running.");
        return;
      }
      this.previousSnapshot = null;
      this.broadcast(makeMessage("matchEvent", { roomCode: this.code, event: { type: "countdownStarted" } }));
      this.logEvent("match_countdown", { players: this.ownership.size });
    } else if (command === "stop") {
      if (!stopMatch(this.state)) {
        this.error(entry.socket, "MATCH_NOT_ACTIVE", "There is no active match to stop.");
        return;
      }
      this.broadcast(makeMessage("matchEvent", { roomCode: this.code, event: { type: "matchStopped" } }));
      this.logEvent("match_stopped");
      this.activateQueuedSwaps();
    } else {
      resetMatch(this.state);
      this.previousSnapshot = null;
      this.broadcast(makeMessage("matchEvent", { roomCode: this.code, event: { type: "matchReset" } }));
      this.logEvent("match_reset");
    }
    this.broadcastRoomState();
    this.broadcastSnapshot(true);
  }

  playerInput(entry, message) {
    if (!this.allowInput(entry)) return;
    if (!entry.seat || message.seat !== entry.seat || message.roomCode !== this.code) {
      this.error(entry.socket, "NOT_SEAT_OWNER", "Input was rejected because this browser does not own that seat.");
      return;
    }
    if (!Number.isSafeInteger(message.sequence) || message.sequence < 0) {
      this.error(entry.socket, "INVALID_SEQUENCE", "Input sequence must be a non-negative integer.");
      return;
    }
    const previous = this.inputs.get(entry.seat);
    if (previous && message.sequence <= previous.sequence) return;
    const input = normalizeInput(message.input, message.sequence);
    input.receivedAt = Date.now();
    this.inputs.set(entry.seat, input);
  }

  loop() {
    if (this.closed) return;
    const now = performance.now();
    const elapsed = Math.min(0.25, (now - this.lastLoopAt) / 1000);
    this.lastLoopAt = now;
    this.accumulator += elapsed;
    const wallNow = Date.now();

    for (const [seat, owner] of this.ownership) {
      if (!owner.connected && owner.disconnectDeadline <= wallNow) {
        this.cancelSwapRequestsForSeat(seat, "A player involved in the request disconnected.");
        this.ownership.delete(seat);
        this.inputs.delete(seat);
        this.logEvent("seat_reservation_expired", { seat });
        this.broadcastRoomState();
      }
    }

    while (this.accumulator >= FIXED_DT) {
      const activeInputs = {};
      for (const [seat, input] of this.inputs) {
        activeInputs[seat] = wallNow - input.receivedAt > INPUT_TIMEOUT_MS
          ? { ...NEUTRAL_INPUT, sequence: input.sequence }
          : input;
      }
      const simulationClock = this.state.simulationTime + FIXED_DT;
      const events = stepSimulation(this.state, activeInputs, FIXED_DT, simulationClock);
      for (const [seat, input] of this.inputs) {
        if (input.toggleIntake || input.unstick) {
          this.inputs.set(seat, { ...input, toggleIntake: false, unstick: false });
        }
      }
      for (const event of events) {
        if (event.type === "matchStarted") {
          this.broadcast(makeMessage("matchStarted", { roomCode: this.code }));
          this.logEvent("match_started");
        } else if (event.type === "matchEnded") {
          this.broadcast(makeMessage("matchEnded", {
            roomCode: this.code,
            scoreRed: event.scoreRed,
            scoreBlue: event.scoreBlue,
            players: this.state.robots.map((robot) => ({ seat: robot.seat, score: robot.score }))
          }));
          this.activateQueuedSwaps();
          this.logEvent("match_ended", { scoreRed: event.scoreRed, scoreBlue: event.scoreBlue });
        } else {
          this.broadcast(makeMessage("matchEvent", { roomCode: this.code, event }));
        }
      }
      this.accumulator -= FIXED_DT;
    }

    if (wallNow - this.lastSnapshotAt >= 1000 / SNAPSHOT_RATE) {
      this.broadcastSnapshot(wallNow - this.lastFullSnapshotAt >= FULL_SNAPSHOT_INTERVAL_MS);
      this.lastSnapshotAt = wallNow;
    }
    if (this.connections.size === 0 && this.emptySince && wallNow - this.emptySince >= EMPTY_ROOM_GRACE_MS) {
      this.onEmpty?.(this.code, "empty");
    } else if (
      (this.state.status === "lobby" || this.state.status === "results")
      && wallNow - this.lastActivityAt >= LOBBY_IDLE_MS
    ) {
      for (const { socket } of this.connections.values()) socket.close(1001, "Room expired");
      this.onEmpty?.(this.code, "inactive");
    }
  }

  swapActionsFor(entry) {
    if (!entry || this.matchActive()) return [];
    const actions = [];
    for (const request of this.pendingSwaps.values()) {
      if (request.status === "awaiting_target" && entry.id === request.targetConnectionId) {
        actions.push({ ...this.swapSummary(request), role: "target" });
      } else if (request.status === "awaiting_host" && entry.id === this.hostId) {
        actions.push({ ...this.swapSummary(request), role: "host" });
      }
    }
    return actions;
  }

  roomState(entry = null) {
    const hostEntry = [...this.connections.values()].find((entry) => entry.id === this.hostId);
    return makeMessage("roomState", {
      roomCode: this.code,
      hostConnectionId: this.hostId,
      hostSeat: hostEntry?.seat || null,
      status: this.state.status,
      players: this.state.players.map((player) => publicLobbyPlayer(player, this.ownership)),
      claimedSeats: this.ownership.size,
      pendingSwaps: [...this.pendingSwaps.values()].map((request) => this.swapSummary(request)),
      pendingSwapCount: this.pendingSwaps.size,
      startBlockedBySwaps: this.pendingSwaps.size > 0,
      swapActions: this.swapActionsFor(entry)
    });
  }

  sendRoomState(socket) {
    const entry = this.connections.get(socket);
    this.send(socket, {
      ...this.roomState(entry),
      connectionId: entry?.id || null,
      isHost: entry?.id === this.hostId,
      ownedSeat: entry?.seat || null
    });
  }

  broadcastRoomState() {
    for (const { socket } of this.connections.values()) this.sendRoomState(socket);
  }

  sendSnapshot(socket, full = true) {
    const snapshot = serializeSnapshot(this.state, { full: true });
    this.send(socket, makeMessage("snapshot", { roomCode: this.code, snapshot }));
  }

  broadcastSnapshot(forceFull = false) {
    if (this.connections.size === 0) return;
    const full = serializeSnapshot(this.state, { full: true });
    const snapshot = forceFull || !this.previousSnapshot ? full : createSnapshotDelta(this.previousSnapshot, full);
    this.broadcast(makeMessage("snapshot", { roomCode: this.code, snapshot }));
    this.previousSnapshot = full;
    if (forceFull) this.lastFullSnapshotAt = Date.now();
  }

  transferHost() {
    const next = [...this.connections.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
    this.hostId = next?.id || null;
    if (next) this.logEvent("host_transferred", { connectionId: next.id });
  }

  allowCommand(entry) {
    const now = Date.now();
    if (now - entry.commandWindowAt >= 1000) {
      entry.commandWindowAt = now;
      entry.commandsInWindow = 0;
    }
    entry.commandsInWindow += 1;
    return entry.commandsInWindow <= 15;
  }

  allowInput(entry) {
    const now = Date.now();
    if (now - entry.inputWindowAt >= 1000) {
      entry.inputWindowAt = now;
      entry.inputsInWindow = 0;
    }
    entry.inputsInWindow += 1;
    return entry.inputsInWindow <= 90;
  }

  send(socket, message) {
    if (!socketOpen(socket)) return;
    socket.send(JSON.stringify(message));
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    for (const { socket } of this.connections.values()) {
      if (socketOpen(socket)) socket.send(data);
    }
  }

  error(socket, code, message) {
    this.send(socket, makeMessage("error", { code, message }));
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  logEvent(event, details = {}) {
    this.log({ level: "info", event, roomCode: this.code, ...details });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const { socket } of this.connections.values()) {
      if (socketOpen(socket)) socket.close(1001, "Room closed");
    }
    this.connections.clear();
  }
}
