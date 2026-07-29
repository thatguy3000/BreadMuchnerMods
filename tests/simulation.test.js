import assert from "node:assert/strict";
import test from "node:test";
import {
  BOT_MODELS,
  FIELD_W,
  FIXED_DT,
  MATCH_PHASES,
  NEUTRAL_INPUT
} from "../shared/constants.js";
import { createGameState, getStartPosition, reconfigurePlayer } from "../shared/state.js";
import {
  applySnapshotDelta,
  createSnapshotDelta,
  resetMatch,
  serializeSnapshot,
  startMatch,
  stepSimulation
} from "../shared/simulation.js";

function stripSnapshotSequence(snapshot) {
  const clone = structuredClone(snapshot);
  delete clone.sequence;
  return clone;
}

function advance(state, seconds, inputs = {}) {
  const ticks = Math.ceil(seconds / FIXED_DT);
  for (let index = 0; index < ticks; index += 1) {
    stepSimulation(state, inputs, FIXED_DT, state.simulationTime + FIXED_DT);
  }
}

test("a seeded simulation is deterministic for the same inputs", () => {
  const first = createGameState({ seed: 12345 });
  const second = createGameState({ seed: 12345 });
  first.balls = first.balls.slice(0, 30);
  second.balls = second.balls.slice(0, 30);
  for (let tick = 0; tick < 180; tick += 1) {
    const inputs = {
      1: { x: tick < 90 ? 1 : -0.3, y: 0.4, rotation: 0.2, action: false, sequence: tick },
      4: { x: -0.2, y: -0.4, rotation: -0.5, action: false, sequence: tick }
    };
    stepSimulation(first, inputs, FIXED_DT, first.simulationTime + FIXED_DT);
    stepSimulation(second, inputs, FIXED_DT, second.simulationTime + FIXED_DT);
  }
  assert.deepEqual(stripSnapshotSequence(serializeSnapshot(first)), stripSnapshotSequence(serializeSnapshot(second)));
});

test("robot motion accelerates, damps, rotates, and remains inside the field", () => {
  const state = createGameState();
  state.balls = [];
  const robot = state.robots[0];
  const originalX = robot.x;
  advance(state, 1, { 1: { x: 1, y: 0, rotation: 1, action: false, sequence: 1 } });
  assert.ok(robot.x > originalX, "robot should move right");
  assert.ok(robot.angle > 0, "robot should rotate");
  advance(state, 10, { 1: { x: 1, y: 0, rotation: 0, action: false, sequence: 2 } });
  assert.ok(robot.x + BOT_MODELS[robot.model].w <= FIELD_W);
  const velocity = Math.abs(robot.vx);
  advance(state, 1, { 1: NEUTRAL_INPUT });
  assert.ok(Math.abs(robot.vx) < velocity, "velocity should damp without input");
});

test("grouped starting positions do not overlap and mirror alliances", () => {
  const state = createGameState();
  for (const player of state.players) player.start = 1;
  const red = state.players.slice(0, 3).map((player) => getStartPosition(state.players, player));
  const blue = state.players.slice(3).map((player) => getStartPosition(state.players, player));
  assert.equal(new Set(red.map((position) => `${position.x}:${position.y}`)).size, 3);
  assert.equal(new Set(blue.map((position) => `${position.x}:${position.y}`)).size, 3);
  assert.ok(red.every((position) => position.angle === 0));
  assert.ok(blue.every((position) => position.angle === Math.PI));
});

test("every offline player can be disabled and can select an explicit input source", () => {
  const state = createGameState();
  assert.equal(reconfigurePlayer(state, 1, { enabled: false, inputSource: "gamepad:0" }), true);
  assert.equal(reconfigurePlayer(state, 4, { inputSource: "keyboard" }), true);
  assert.equal(state.players[0].enabled, false);
  assert.equal(state.players[0].inputSource, "gamepad:0");
  assert.equal(state.players[3].inputSource, "keyboard");
  assert.equal(state.robots[0].x, -1000);

  resetMatch(state);
  assert.equal(state.players[0].enabled, false);
  assert.equal(state.players[0].inputSource, "gamepad:0");
  assert.equal(state.players[3].inputSource, "keyboard");
});

test("match countdown and phase boundaries are simulation-clock driven", () => {
  const state = createGameState();
  state.balls = [];
  assert.equal(startMatch(state), true);
  state.balls = [];
  advance(state, 2.99);
  assert.equal(state.status, "countdown");
  advance(state, 0.02);
  assert.equal(state.status, "running");
  assert.equal(state.phaseIndex, 0);

  while (state.matchElapsed < 20.01) advance(state, FIXED_DT);
  assert.equal(state.autoResolved, true);
  assert.equal(state.phaseIndex, 1);
  assert.equal(state.redHubActive, false);
  assert.equal(state.blueHubActive, false);

  while (state.matchElapsed < 23.01) advance(state, FIXED_DT);
  assert.equal(state.phaseIndex, 2);
  assert.equal(state.redHubActive, true);
  assert.equal(state.blueHubActive, true);

  while (state.matchElapsed < 163) advance(state, FIXED_DT);
  assert.equal(state.status, "results");
  assert.equal(state.phaseName, "MATCH OVER");
  assert.equal(state.matchElapsed, 163);
  assert.equal(MATCH_PHASES.at(-1).end, 163);
});

test("pre-match countdown locks every robot action until AUTO", () => {
  const state = createGameState({ seed: 41 });
  reconfigurePlayer(state, 1, { model: "Blitz" });
  assert.equal(startMatch(state), true);
  state.balls = [];
  const robot = state.robots[0];
  robot.inventory = 5;
  const before = {
    x: robot.x,
    y: robot.y,
    angle: robot.angle,
    inventory: robot.inventory,
    intakeSide: robot.intakeSide,
    unstickUsed: robot.unstickUsed
  };
  advance(state, 2, {
    1: {
      ...NEUTRAL_INPUT,
      x: 1,
      y: 1,
      rotation: 1,
      action: true,
      toggleIntake: true,
      unstick: true,
      sequence: 1
    }
  });
  assert.equal(state.status, "countdown");
  assert.deepEqual({
    x: robot.x,
    y: robot.y,
    angle: robot.angle,
    inventory: robot.inventory,
    intakeSide: robot.intakeSide,
    unstickUsed: robot.unstickUsed
  }, before);
  assert.equal(state.projectiles.length, 0);
});

test("auto winner controls the alternating shift sequence", () => {
  const state = createGameState();
  state.balls = [];
  startMatch(state);
  state.balls = [];
  advance(state, 3.01);
  state.autoScoreBlue = 2;
  while (state.matchElapsed < 33.01) advance(state, FIXED_DT);
  assert.equal(state.autoWinner, "blue");
  assert.equal(state.phaseIndex, 3);
  assert.equal(state.redHubActive, true);
  assert.equal(state.blueHubActive, false);
  while (state.matchElapsed < 58.01) advance(state, FIXED_DT);
  assert.equal(state.redHubActive, false);
  assert.equal(state.blueHubActive, true);
});

test("unstick is one-use and freezes the robot for three seconds", () => {
  const state = createGameState();
  state.balls = [];
  startMatch(state);
  state.balls = [];
  advance(state, 3.01);
  const robot = state.robots[0];
  robot.x = 900;
  robot.y = 450;
  stepSimulation(state, { 1: { ...NEUTRAL_INPUT, unstick: true, sequence: 1 } }, FIXED_DT, state.simulationTime + FIXED_DT);
  const resetX = robot.x;
  assert.equal(robot.unstickUsed, true);
  assert.ok(robot.freezeUntil - state.simulationTime > 2.9);
  stepSimulation(state, { 1: { ...NEUTRAL_INPUT, x: 1, sequence: 2 } }, FIXED_DT, state.simulationTime + FIXED_DT);
  assert.equal(robot.x, resetX);
  robot.x = 500;
  stepSimulation(state, { 1: { ...NEUTRAL_INPUT, unstick: true, sequence: 3 } }, FIXED_DT, state.simulationTime + FIXED_DT);
  assert.equal(robot.x, 500, "second unstick must not teleport");
});

test("Blitz intake toggle is edge-triggered by input frames", () => {
  const state = createGameState();
  state.balls = [];
  reconfigurePlayer(state, 1, { model: "Blitz" });
  const robot = state.robots[0];
  assert.equal(robot.intakeSide, "right");
  stepSimulation(state, { 1: { ...NEUTRAL_INPUT, toggleIntake: true, sequence: 1 } }, FIXED_DT, state.simulationTime + FIXED_DT);
  assert.equal(robot.intakeSide, "left");
  stepSimulation(state, { 1: { ...NEUTRAL_INPUT, toggleIntake: false, sequence: 2 } }, FIXED_DT, state.simulationTime + FIXED_DT);
  assert.equal(robot.intakeSide, "left");
});

test("all robot models consume inventory when firing", () => {
  for (const model of Object.keys(BOT_MODELS)) {
    const state = createGameState({ seed: 9 });
    state.balls = [];
    reconfigurePlayer(state, 1, { model });
    const robot = state.robots[0];
    robot.inventory = Math.min(8, BOT_MODELS[model].capacity);
    const before = robot.inventory;
    const entityIdBefore = state.nextEntityId;
    for (let tick = 0; tick < 90 && robot.inventory === before; tick += 1) {
      stepSimulation(state, { 1: { ...NEUTRAL_INPUT, action: true, sequence: tick } }, FIXED_DT, state.simulationTime + FIXED_DT);
    }
    assert.ok(robot.inventory < before, `${model} should fire`);
    assert.ok(state.nextEntityId > entityIdBefore, `${model} should create an entity with a stable ID`);
  }
});

test("dumper launches fuel from the side opposite its intake", () => {
  const state = createGameState({ seed: 19 });
  state.balls = [];
  reconfigurePlayer(state, 1, { model: "dumper" });
  const robot = state.robots[0];
  robot.x = 100;
  robot.y = 100;
  robot.inventory = 8;

  for (let tick = 0; tick < 240 && state.projectiles.length === 0; tick += 1) {
    stepSimulation(state, { 1: { ...NEUTRAL_INPUT, action: true, sequence: tick } }, FIXED_DT, state.simulationTime + FIXED_DT);
  }

  assert.ok(state.projectiles.length > 0, "dumper should finish aligning and launch fuel");
  const projectile = state.projectiles[0];
  const model = BOT_MODELS.dumper;
  const centerX = robot.x + model.w / 2;
  const centerY = robot.y + model.h / 2;
  const launchX = projectile.x - projectile.vx;
  const launchY = projectile.y - projectile.vy;
  const intakeDirectionX = Math.cos(robot.angle);
  const intakeDirectionY = Math.sin(robot.angle);
  const launchAlongIntakeAxis = (launchX - centerX) * intakeDirectionX
    + (launchY - centerY) * intakeDirectionY;
  const velocityAlongIntakeAxis = projectile.vx * intakeDirectionX
    + projectile.vy * intakeDirectionY;

  assert.ok(launchAlongIntakeAxis < -(model.w / 2), "launch point should be behind the intake");
  assert.ok(velocityAlongIntakeAxis < 0, "fuel should travel away from the intake side");
});

test("standard shots leave the robot front at the original offline speed", () => {
  const state = createGameState({ seed: 17 });
  state.balls = [];
  const robot = state.robots[0];
  robot.inventory = 1;
  robot.angle = Math.PI / 2;
  stepSimulation(state, { 1: { ...NEUTRAL_INPUT, action: true, sequence: 1 } }, FIXED_DT, state.simulationTime + FIXED_DT);
  assert.equal(state.projectiles.length, 1);
  const projectile = state.projectiles[0];
  const model = BOT_MODELS[robot.model];
  const launchX = projectile.x - projectile.vx;
  const launchY = projectile.y - projectile.vy;
  assert.ok(Math.abs(launchX - (robot.x + model.w / 2 + Math.cos(robot.angle) * (model.w / 2 + 5))) < 0.001);
  assert.ok(Math.abs(launchY - (robot.y + model.h / 2 + Math.sin(robot.angle) * (model.w / 2 + 5))) < 0.001);
  assert.ok(Math.abs(Math.hypot(projectile.vx, projectile.vy) - 16) < 0.001);
});

test("active hub scoring attributes points to the firing player", () => {
  const state = createGameState();
  state.balls = [];
  state.status = "running";
  state.phaseIndex = 0;
  state.redHubActive = true;
  state.blueHubActive = true;
  const redHub = state.zones.find((zone) => zone.type === "hub" && zone.side === "red");
  state.projectiles.push({
    id: state.nextEntityId++,
    x: redHub.x + redHub.w / 2,
    y: redHub.y + redHub.h / 2,
    vx: 0,
    vy: 0,
    r: 4,
    owner: "red",
    playerSeat: 1,
    pass: false
  });
  stepSimulation(state, {}, FIXED_DT, state.simulationTime + FIXED_DT);
  assert.equal(state.scoreRed, 1);
  assert.equal(state.robots[0].score, 1);
  assert.equal(state.projectiles.length, 0);
  assert.equal(state.scoringBalls.length, 1);
});

test("ball collisions separate moving fuel and obstacle collisions resolve penetration", () => {
  const state = createGameState();
  const barrier = state.obstacles.find((obstacle) => obstacle.type === "barrier");
  state.balls = [
    {
      id: 9001, x: 100, y: 100, r: 5, vx: 1, vy: 0, static: false,
      friction: 1, rollUntil: 10, wasOnBump: false, owner: null
    },
    {
      id: 9002, x: 108, y: 100, r: 5, vx: -1, vy: 0, static: false,
      friction: 1, rollUntil: 10, wasOnBump: false, owner: null
    },
    {
      id: 9003, x: barrier.x + barrier.w / 2, y: barrier.y + barrier.h / 2,
      r: 5, vx: 0.5, vy: 0, static: false, friction: 1, rollUntil: 10,
      wasOnBump: false, owner: null
    }
  ];
  stepSimulation(state, {}, FIXED_DT, state.simulationTime + FIXED_DT);
  assert.ok(state.balls[0].vx < 1, "first ball should receive collision impulse");
  assert.ok(state.balls[1].vx > -1, "second ball should receive collision impulse");
  const obstacleBall = state.balls.find((ball) => ball.id === 9003);
  assert.ok(Number.isFinite(obstacleBall.x) && Number.isFinite(obstacleBall.y));
  assert.notEqual(obstacleBall.x, barrier.x + barrier.w / 2);
});

test("robot intake consumes fuel up to capacity and no farther", () => {
  const state = createGameState();
  const robot = state.robots[0];
  const model = BOT_MODELS[robot.model];
  const intakeX = robot.x + model.w / 2 + Math.cos(robot.angle) * (model.w / 2 + 5);
  const intakeY = robot.y + model.h / 2 + Math.sin(robot.angle) * (model.w / 2 + 5);
  state.balls = [{
    id: 9100, x: intakeX, y: intakeY, r: 5, vx: 0, vy: 0, static: true,
    friction: 1, rollUntil: 0, wasOnBump: false, owner: null
  }];
  robot.inventory = model.capacity - 1;
  stepSimulation(state, {}, FIXED_DT, state.simulationTime + FIXED_DT);
  assert.equal(robot.inventory, model.capacity);
  assert.equal(state.balls.length, 0);

  state.balls = [{
    id: 9101, x: intakeX, y: intakeY, r: 5, vx: 0, vy: 0, static: true,
    friction: 1, rollUntil: 0, wasOnBump: false, owner: null
  }];
  stepSimulation(state, {}, FIXED_DT, state.simulationTime + FIXED_DT);
  assert.equal(robot.inventory, model.capacity);
  assert.equal(state.balls.length, 1);
});

test("reset restores an identical initial state for a known seed", () => {
  const state = createGameState({ seed: 42 });
  state.balls = state.balls.slice(0, 20);
  advance(state, 1, { 1: { ...NEUTRAL_INPUT, x: 1, sequence: 1 } });
  resetMatch(state);
  const fresh = createGameState({ seed: 42 });
  assert.deepEqual(stripSnapshotSequence(serializeSnapshot(state)), stripSnapshotSequence(serializeSnapshot(fresh)));
});

test("incremental snapshots are compact and reconstruct the authoritative state", () => {
  const state = createGameState();
  const first = serializeSnapshot(state);
  stepSimulation(state, {}, FIXED_DT, state.simulationTime + FIXED_DT);
  const second = serializeSnapshot(state);
  const delta = createSnapshotDelta(first, second);
  const restored = applySnapshotDelta(first, delta);
  assert.deepEqual(restored, { ...second, full: true });
  assert.equal(delta.balls.length, 0, "unchanged static balls should not be resent");
  assert.ok(Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(second)) / 4);
  assert.ok(Buffer.byteLength(JSON.stringify(second)) < 16 * 1024, "full initial snapshot fits the message limit");
});

test("multiple rooms simulate independently without entity or score leakage", () => {
  const rooms = Array.from({ length: 12 }, (_, index) => createGameState({ seed: index + 1 }));
  for (let tick = 0; tick < 120; tick += 1) {
    for (const [index, state] of rooms.entries()) {
      stepSimulation(state, {
        1: { ...NEUTRAL_INPUT, x: index % 2 ? 1 : -1, sequence: tick }
      }, FIXED_DT, state.simulationTime + FIXED_DT);
    }
  }
  assert.equal(new Set(rooms.map((state) => state.rngState)).size, rooms.length);
  assert.ok(rooms.every((state) => state.tick === 120));
  assert.notEqual(rooms[0].robots[0].x, rooms[1].robots[0].x);
});
