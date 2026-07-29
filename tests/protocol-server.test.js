import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION } from "../shared/constants.js";
import {
  normalizeInput,
  parseClientMessage,
  sanitizeLobbyUpdate,
  validateRoomCode
} from "../shared/protocol.js";
import { GameRoom } from "../server/game-room.js";

class FakeSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    this.closed = false;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this.closed = true;
  }

  take(type) {
    return [...this.sent].reverse().find((message) => message.type === type);
  }
}

const message = (type, payload = {}) => ({ type, version: PROTOCOL_VERSION, ...payload });

test("protocol rejects malformed, oversized, unknown, and mismatched messages", () => {
  assert.equal(parseClientMessage("{").error, "INVALID_JSON");
  assert.equal(parseClientMessage(JSON.stringify({ type: "ping", version: 999 })).error, "VERSION_MISMATCH");
  assert.equal(parseClientMessage(JSON.stringify(message("secretAdminCommand"))).error, "UNKNOWN_MESSAGE");
  assert.equal(parseClientMessage("x".repeat(17 * 1024)).error, "MESSAGE_TOO_LARGE");
  assert.equal(validateRoomCode("abc234"), "ABC234");
  assert.equal(validateRoomCode("O0I1ZZ"), null);
});

test("axes clamp and action values require real booleans", () => {
  assert.deepEqual(normalizeInput({ x: 90, y: -80, rotation: 0.5, action: 1, unstick: true }, 7), {
    x: 1,
    y: -1,
    rotation: 0.5,
    action: false,
    toggleIntake: false,
    unstick: true,
    sequence: 7
  });
  assert.equal(sanitizeLobbyUpdate({ name: "<img onerror=1>", model: "turret", start: 2 }).name, "<img onerror=1>");
  assert.equal(sanitizeLobbyUpdate({ model: "not-a-robot" }), null);
});

test("six clients can claim unique seats and the seventh is rejected", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const sockets = Array.from({ length: 7 }, () => new FakeSocket());
  sockets.forEach((socket) => room.addConnection(socket));
  for (let seat = 1; seat <= 6; seat += 1) {
    room.handle(sockets[seat - 1], message("claimSeat", { seat }));
    assert.equal(sockets[seat - 1].take("seatAssigned").seat, seat);
  }
  room.handle(sockets[6], message("claimSeat", { seat: 1 }));
  assert.equal(sockets[6].take("error").code, "SEAT_TAKEN");
  assert.equal(room.ownership.size, 6);
});

test("only owners edit/send input and only the host starts", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const host = new FakeSocket();
  const guest = new FakeSocket();
  room.addConnection(host);
  room.addConnection(guest);
  room.handle(host, message("claimSeat", { seat: 1 }));
  room.handle(guest, message("claimSeat", { seat: 2 }));

  room.handle(guest, message("updateLobbyPlayer", { seat: 1, player: { name: "Hacker" } }));
  assert.equal(guest.take("error").code, "NOT_SEAT_OWNER");
  assert.notEqual(room.state.players[0].name, "Hacker");

  room.handle(guest, message("playerInput", {
    roomCode: room.code,
    seat: 1,
    sequence: 1,
    input: { x: 1 }
  }));
  assert.equal(guest.take("error").code, "NOT_SEAT_OWNER");

  room.handle(guest, message("startMatch", { roomCode: room.code }));
  assert.equal(guest.take("error").code, "HOST_ONLY");
  room.handle(host, message("startMatch", { roomCode: room.code }));
  assert.equal(room.state.status, "countdown");

  room.handle(host, message("updateLobbyPlayer", { seat: 1, player: { name: "Locked" } }));
  assert.equal(host.take("error").code, "LOBBY_LOCKED");
});

test("occupied online swaps require target then host approval and preserve robot state", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const host = new FakeSocket();
  const guest = new FakeSocket();
  room.addConnection(host);
  room.addConnection(guest);
  room.handle(host, message("claimSeat", { seat: 1 }));
  room.handle(guest, message("claimSeat", { seat: 2 }));
  room.state.players[0].name = "Host Driver";
  room.state.players[1].name = "Guest Driver";
  Object.assign(room.state.robots[0], { x: 123, y: 45, score: 7 });
  Object.assign(room.state.robots[1], { x: 678, y: 90, score: 11 });
  const robotsBefore = room.state.robots.slice(0, 2).map(({ x, y, score, model, team }) => ({ x, y, score, model, team }));

  room.handle(host, message("createSwapRequest", { targetSeat: 2 }));
  const request = [...room.pendingSwaps.values()][0];
  assert.equal(request.status, "awaiting_target");
  assert.equal(guest.take("roomState").swapActions[0].role, "target");
  room.handle(host, message("startMatch"));
  assert.equal(host.take("error").code, "SWAPS_PENDING");

  room.handle(guest, message("respondSwapRequest", { requestId: request.id, accepted: true }));
  assert.equal(request.status, "awaiting_host");
  assert.equal(host.take("roomState").swapActions[0].role, "host");
  room.handle(host, message("reviewSwapRequest", { requestId: request.id, accepted: true }));

  assert.equal(room.connections.get(host).seat, 2);
  assert.equal(room.connections.get(guest).seat, 1);
  assert.equal(room.ownership.get(2).socket, host);
  assert.equal(room.ownership.get(1).socket, guest);
  assert.deepEqual(room.state.players.slice(0, 2).map((player) => player.name), ["Guest Driver", "Host Driver"]);
  assert.deepEqual(room.state.robots.slice(0, 2).map(({ x, y, score, model, team }) => ({ x, y, score, model, team })), robotsBefore);
  assert.equal(room.pendingSwaps.size, 0);
  assert.equal(host.take("swapApplied").targetSeat, 2);
});

test("moving to an open online spot needs host approval and opens the source", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const host = new FakeSocket();
  const challenger = new FakeSocket();
  room.addConnection(host);
  room.addConnection(challenger);
  room.handle(host, message("claimSeat", { seat: 1 }));
  room.state.players[0].name = "Solo Driver";
  const targetRobot = { ...room.state.robots[2] };

  room.handle(host, message("createSwapRequest", { targetSeat: 3 }));
  const request = [...room.pendingSwaps.values()][0];
  assert.equal(request.status, "awaiting_host");
  room.handle(challenger, message("claimSeat", { seat: 3 }));
  assert.equal(challenger.take("error").code, "SEAT_SWAP_RESERVED");
  room.handle(host, message("reviewSwapRequest", { requestId: request.id, accepted: true }));

  assert.equal(room.connections.get(host).seat, 3);
  assert.equal(room.ownership.has(1), false);
  assert.equal(room.ownership.get(3).socket, host);
  assert.equal(room.state.players[0].name, "Player 1");
  assert.equal(room.state.players[2].name, "Solo Driver");
  assert.deepEqual(room.state.robots[2], targetRobot);
});

test("live-match swap requests queue until play stops", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const host = new FakeSocket();
  const guest = new FakeSocket();
  room.addConnection(host);
  room.addConnection(guest);
  room.handle(host, message("claimSeat", { seat: 1 }));
  room.handle(guest, message("claimSeat", { seat: 2 }));
  room.state.status = "running";

  room.handle(host, message("createSwapRequest", { targetSeat: 2 }));
  const request = [...room.pendingSwaps.values()][0];
  assert.equal(request.status, "queued");
  assert.deepEqual(guest.take("roomState").swapActions, []);
  room.handle(guest, message("respondSwapRequest", { requestId: request.id, accepted: true }));
  assert.equal(guest.take("error").code, "SWAP_NOT_READY");

  room.handle(host, message("stopMatch"));
  assert.equal(request.status, "awaiting_target");
  assert.equal(guest.take("roomState").swapActions[0].role, "target");
});

test("swap queue permits disjoint requests, rejects conflicts, and supports manual cancellation", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const sockets = Array.from({ length: 4 }, () => new FakeSocket());
  sockets.forEach((socket) => room.addConnection(socket));
  sockets.forEach((socket, index) => room.handle(socket, message("claimSeat", { seat: index + 1 })));

  room.handle(sockets[0], message("createSwapRequest", { targetSeat: 2 }));
  room.handle(sockets[2], message("createSwapRequest", { targetSeat: 4 }));
  assert.equal(room.pendingSwaps.size, 2);
  room.handle(sockets[1], message("createSwapRequest", { targetSeat: 3 }));
  assert.equal(sockets[1].take("error").code, "SWAP_CONFLICT");
  const first = [...room.pendingSwaps.values()][0];
  room.handle(sockets[0], message("cancelSwapRequest", { requestId: first.id }));
  assert.equal(room.pendingSwaps.size, 1);
  assert.equal(sockets[0].take("swapRejected").requestId, first.id);
});

test("denied swaps change nothing and the host can cancel an unanswered target request", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const host = new FakeSocket();
  const guest = new FakeSocket();
  room.addConnection(host);
  room.addConnection(guest);
  room.handle(host, message("claimSeat", { seat: 1 }));
  room.handle(guest, message("claimSeat", { seat: 2 }));

  room.handle(host, message("createSwapRequest", { targetSeat: 2 }));
  let request = [...room.pendingSwaps.values()][0];
  room.handle(guest, message("respondSwapRequest", { requestId: request.id, accepted: false }));
  assert.equal(room.connections.get(host).seat, 1);
  assert.equal(room.connections.get(guest).seat, 2);
  assert.equal(room.pendingSwaps.size, 0);

  room.handle(guest, message("createSwapRequest", { targetSeat: 1 }));
  request = [...room.pendingSwaps.values()][0];
  room.handle(host, message("cancelSwapRequest", { requestId: request.id }));
  assert.equal(room.pendingSwaps.size, 0);
  assert.equal(guest.take("swapRejected").requestId, request.id);
});

test("pending host review follows host transfer", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const originalHost = new FakeSocket();
  const target = new FakeSocket();
  room.addConnection(originalHost);
  room.addConnection(target);
  room.handle(originalHost, message("claimSeat", { seat: 1 }));
  room.handle(target, message("claimSeat", { seat: 2 }));
  room.handle(originalHost, message("createSwapRequest", { targetSeat: 2 }));
  const request = [...room.pendingSwaps.values()][0];
  room.handle(target, message("respondSwapRequest", { requestId: request.id, accepted: true }));

  room.removeConnection(originalHost);
  const transferred = target.take("roomState");
  assert.equal(transferred.isHost, true);
  assert.equal(transferred.swapActions[0].role, "host");
  room.handle(target, message("reviewSwapRequest", { requestId: request.id, accepted: true }));
  assert.equal(room.connections.get(target).seat, 1);
  assert.equal(room.ownership.get(2).connected, false);
});

test("stale input is ignored and valid axes are clamped", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const socket = new FakeSocket();
  room.addConnection(socket);
  room.handle(socket, message("claimSeat", { seat: 1 }));
  room.handle(socket, message("playerInput", {
    roomCode: room.code,
    seat: 1,
    sequence: 9,
    input: { x: 10, y: -10, action: true }
  }));
  room.handle(socket, message("playerInput", {
    roomCode: room.code,
    seat: 1,
    sequence: 8,
    input: { x: 0 }
  }));
  const input = room.inputs.get(1);
  assert.equal(input.sequence, 9);
  assert.equal(input.x, 1);
  assert.equal(input.y, -1);
  assert.equal(input.action, true);
});

test("disconnect neutralizes input and reconnect token restores the seat", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const original = new FakeSocket();
  room.addConnection(original);
  room.handle(original, message("claimSeat", { seat: 3 }));
  const assigned = original.take("seatAssigned");
  room.handle(original, message("playerInput", {
    roomCode: room.code,
    seat: 3,
    sequence: 2,
    input: { x: 1, action: true }
  }));
  room.removeConnection(original);
  assert.equal(room.inputs.get(3).x, 0);
  assert.equal(room.inputs.get(3).action, false);
  assert.equal(room.ownership.get(3).connected, false);

  const replacement = new FakeSocket();
  room.addConnection(replacement, { reconnectToken: assigned.reconnectToken });
  assert.equal(replacement.take("seatAssigned").reconnected, true);
  assert.equal(room.connections.get(replacement).seat, 3);
  assert.equal(room.ownership.get(3).connected, true);
  assert.ok(replacement.take("snapshot").snapshot.full);
});

test("host transfers to the oldest connected guest", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const first = new FakeSocket();
  const second = new FakeSocket();
  room.addConnection(first);
  room.addConnection(second);
  const secondId = room.connections.get(second).id;
  room.removeConnection(first);
  assert.equal(room.hostId, secondId);
  assert.equal(second.take("roomState").isHost, true);
});

test("stale held input times out to neutral in the authoritative tick", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const socket = new FakeSocket();
  room.addConnection(socket);
  room.handle(socket, message("claimSeat", { seat: 1 }));
  room.state.balls = [];
  for (const player of room.state.players) player.enabled = player.seat === 1;
  const robot = room.state.robots[0];
  robot.x = 100;
  robot.y = 100;
  robot.vx = 0;
  robot.vy = 0;
  room.inputs.set(1, { x: 1, y: 0, rotation: 0, action: false, toggleIntake: false, unstick: false, sequence: 3, receivedAt: 0 });
  room.accumulator = 1 / 60;
  room.loop();
  assert.equal(robot.x, 100);
  assert.equal(robot.lastInputSequence, 3, "neutral timeout retains sequence acknowledgement");
});

test("authoritative rooms emit the new 30 Hz snapshot cadence", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const socket = new FakeSocket();
  room.addConnection(socket);
  socket.sent = [];
  room.lastSnapshotAt = Date.now() - 35;
  room.loop();
  assert.ok(socket.take("snapshot"), "35 ms is enough to trigger a 30 Hz snapshot");
});

test("expired reconnect reservations release their seats", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const socket = new FakeSocket();
  room.addConnection(socket);
  room.handle(socket, message("claimSeat", { seat: 2 }));
  room.removeConnection(socket);
  room.ownership.get(2).disconnectDeadline = Date.now() - 1;
  room.loop();
  assert.equal(room.ownership.has(2), false);
  assert.equal(room.inputs.has(2), false);
});

test("every connected client receives the same authoritative final result", (context) => {
  const room = new GameRoom("ABC234", { log: () => {} });
  context.after(() => room.close());
  const host = new FakeSocket();
  const guest = new FakeSocket();
  room.addConnection(host);
  room.addConnection(guest);
  room.handle(host, message("claimSeat", { seat: 1 }));
  room.handle(guest, message("claimSeat", { seat: 4 }));
  room.state.balls = [];
  room.state.status = "running";
  room.state.matchElapsed = 162.99;
  room.state.scoreRed = 7;
  room.state.scoreBlue = 4;
  room.state.robots[0].score = 7;
  room.state.robots[3].score = 4;
  room.accumulator = 1 / 60;
  room.loop();
  const hostResult = host.take("matchEnded");
  const guestResult = guest.take("matchEnded");
  assert.deepEqual(hostResult, guestResult);
  assert.equal(hostResult.scoreRed, 7);
  assert.equal(hostResult.scoreBlue, 4);
});
