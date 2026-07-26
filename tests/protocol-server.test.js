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
