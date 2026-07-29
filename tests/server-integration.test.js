import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../shared/constants.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const protocol = (type, payload = {}) => JSON.stringify({ type, version: PROTOCOL_VERSION, ...payload });

async function waitForServer(url, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return response.json();
    } catch {
      // Server is still starting.
    }
    await delay(50);
  }
  throw new Error("Server did not start");
}

function client(url) {
  const socket = new WebSocket(url.replace("http", "ws") + "/ws", {
    origin: url
  });
  const messages = [];
  const waiters = [];
  socket.on("message", (data) => {
    const value = JSON.parse(data.toString());
    messages.push(value);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(value)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(value);
      }
    }
  });
  const waitFor = (predicate, timeout = 5000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for WebSocket message. Received: ${messages.map((item) => item.type).join(", ")}`));
      }, timeout).unref();
    });
  };
  return { socket, messages, waitFor };
}

test("real HTTP/WebSocket server supports room, input, host, and reconnect flows", { timeout: 20_000 }, async (context) => {
  const port = 18_000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [join(process.cwd(), "server", "index.js")], {
    cwd: process.cwd(),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOutput = "";
  server.stdout.on("data", (data) => { serverOutput += data; });
  server.stderr.on("data", (data) => { serverOutput += data; });
  context.after(async () => {
    if (!server.killed) server.kill("SIGTERM");
    await Promise.race([once(server, "exit"), delay(1500)]);
  });

  const health = await waitForServer(baseUrl);
  assert.equal(health.ok, true);
  assert.equal(health.protocolVersion, PROTOCOL_VERSION);
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /BreadMuncher Sim/);
  const publicPage = await fetch(`${baseUrl}/public/index.html`);
  assert.equal(publicPage.status, 200);
  assert.match(await publicPage.text(), /href="\.\/styles\.css"/);
  const publicStyles = await fetch(`${baseUrl}/public/styles.css`);
  assert.equal(publicStyles.status, 200);
  assert.match(publicStyles.headers.get("content-type"), /text\/css/);
  const sharedModule = await fetch(`${baseUrl}/shared/simulation.js`);
  assert.equal(sharedModule.status, 200);
  assert.match(await sharedModule.text(), /stepSimulation/);

  const host = client(baseUrl);
  await once(host.socket, "open");
  host.socket.send(protocol("createRoom"));
  const created = await host.waitFor((message) => message.type === "roomCreated");
  assert.match(created.roomCode, /^[A-Z2-9]{6}$/);

  const guest = client(baseUrl);
  await once(guest.socket, "open");
  guest.socket.send(protocol("joinRoom", { roomCode: created.roomCode }));
  await guest.waitFor((message) => message.type === "roomState" && message.roomCode === created.roomCode);

  host.socket.send(protocol("claimSeat", { roomCode: created.roomCode, seat: 1 }));
  guest.socket.send(protocol("claimSeat", { roomCode: created.roomCode, seat: 4 }));
  const hostSeat = await host.waitFor((message) => message.type === "seatAssigned" && message.seat === 1);
  const guestSeat = await guest.waitFor((message) => message.type === "seatAssigned" && message.seat === 4);
  assert.ok(hostSeat.reconnectToken);
  assert.ok(guestSeat.reconnectToken);

  guest.socket.send(protocol("startMatch", { roomCode: created.roomCode }));
  assert.equal((await guest.waitFor((message) => message.type === "error" && message.code === "HOST_ONLY")).code, "HOST_ONLY");
  host.socket.send(protocol("startMatch", { roomCode: created.roomCode }));
  const countdown = await host.waitFor((message) => message.type === "snapshot" && message.snapshot.status === "countdown");
  assert.ok(countdown.snapshot.full);

  host.socket.send(protocol("playerInput", {
    roomCode: created.roomCode,
    seat: 1,
    sequence: 1,
    input: { x: 1, y: 0, rotation: 0, action: false }
  }));
  const moving = await host.waitFor((message) => {
    if (message.type !== "snapshot") return false;
    const robot = message.snapshot.robots?.find((tuple) => tuple[1] === 1);
    return robot && robot[15] >= 1;
  });
  assert.ok(moving.snapshot.robots.find((tuple) => tuple[1] === 1)[15] >= 1);

  guest.socket.close();
  await once(guest.socket, "close");
  const reconnected = client(baseUrl);
  await once(reconnected.socket, "open");
  reconnected.socket.send(protocol("joinRoom", {
    roomCode: created.roomCode,
    reconnectToken: guestSeat.reconnectToken
  }));
  const restored = await reconnected.waitFor((message) => message.type === "seatAssigned" && message.reconnected);
  assert.equal(restored.seat, 4);
  assert.ok((await reconnected.waitFor((message) => message.type === "snapshot")).snapshot.full);

  host.socket.send(protocol("stopMatch", { roomCode: created.roomCode }));
  await host.waitFor((message) => message.type === "matchEvent" && message.event?.type === "matchStopped");

  host.socket.send(protocol("createSwapRequest", { roomCode: created.roomCode, targetSeat: 4 }));
  const targetReview = await reconnected.waitFor((message) => message.type === "roomState" && message.swapActions?.[0]?.role === "target");
  const swapId = targetReview.swapActions[0].id;
  reconnected.socket.send(protocol("respondSwapRequest", { roomCode: created.roomCode, requestId: swapId, accepted: true }));
  await host.waitFor((message) => message.type === "roomState" && message.swapActions?.some((action) => action.id === swapId && action.role === "host"));
  host.socket.send(protocol("reviewSwapRequest", { roomCode: created.roomCode, requestId: swapId, accepted: true }));
  const applied = await host.waitFor((message) => message.type === "swapApplied" && message.requestId === swapId);
  assert.equal(applied.sourceSeat, 1);
  assert.equal(applied.targetSeat, 4);
  assert.equal((await host.waitFor((message) => message.type === "roomState" && message.ownedSeat === 4)).ownedSeat, 4);
  assert.equal((await reconnected.waitFor((message) => message.type === "roomState" && message.ownedSeat === 1)).ownedSeat, 1);

  host.socket.close();
  reconnected.socket.close();
  await Promise.all([once(host.socket, "close"), once(reconnected.socket, "close")]);
  assert.doesNotMatch(serverOutput, /uncaught_exception|unhandled_rejection|server_exception/);
});
