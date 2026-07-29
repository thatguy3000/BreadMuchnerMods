import {
  BALL_R,
  BAR_L,
  BOT_MODELS,
  BUMP_L,
  BUMP_W,
  DEFAULT_PLAYERS,
  DEPOT_H,
  DEPOT_W,
  FIELD_H,
  FIELD_W,
  HUB_S,
  MATCH_DURATION_SECONDS,
  SCALE,
  START_LABELS,
  TOWER_DIM,
  TOWER_OFFSET,
  TOWER_WALL_DEPTH,
  TRENCH_L
} from "./constants.js";
import { normalizeInputSource } from "./assignments.js";

const copyPlayerConfig = (player) => ({
  seat: player.seat,
  name: String(player.name || `Player ${player.seat}`).slice(0, 24),
  team: player.seat <= 3 ? "red" : "blue",
  model: BOT_MODELS[player.model] ? player.model : "turret",
  start: Number.isInteger(player.start) && player.start >= 0 && player.start < START_LABELS.length ? player.start : 0,
  enabled: player.enabled !== false,
  inputSource: normalizeInputSource(player.inputSource)
});

export function seededRandom(state) {
  let value = state.rngState >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.rngState = value >>> 0;
  return state.rngState / 0x1_0000_0000;
}

export function createField() {
  const zones = [];
  const obstacles = [];
  const add = (x, y, w, h, type, side) => {
    const element = { x, y, w, h, type, side };
    zones.push(element);
    if (["hub", "barrier", "trench", "towerWall"].includes(type)) obstacles.push(element);
  };
  const buildLane = (x, hubY, side, top) => {
    const bumpY = top ? hubY - BUMP_L : hubY + HUB_S;
    add(x, bumpY, BUMP_W, BUMP_L, "bump", side);
    const barY = top ? bumpY - BAR_L : bumpY + BUMP_L;
    add(x, barY, BUMP_W, BAR_L, "barrier", side);
    add(x + BUMP_W / 2 - 15 * SCALE, top ? barY - TRENCH_L : barY + BAR_L, 30 * SCALE, TRENCH_L, "trench", side);
  };

  const redHubX = 156.61 * SCALE;
  const hubY = FIELD_H / 2 - HUB_S / 2;
  add(redHubX, hubY, HUB_S, HUB_S, "hub", "red");
  buildLane(redHubX, hubY, "red", true);
  buildLane(redHubX, hubY, "red", false);
  add(0, TOWER_OFFSET, TOWER_DIM, TOWER_DIM, "tower", "red");
  add(TOWER_DIM - TOWER_WALL_DEPTH, TOWER_OFFSET, TOWER_WALL_DEPTH, TOWER_DIM, "towerWall", "red");

  const blueHubX = FIELD_W - redHubX - HUB_S;
  add(blueHubX, hubY, HUB_S, HUB_S, "hub", "blue");
  buildLane(FIELD_W - redHubX - BUMP_W, hubY, "blue", true);
  buildLane(FIELD_W - redHubX - BUMP_W, hubY, "blue", false);
  add(FIELD_W - TOWER_DIM, FIELD_H - TOWER_OFFSET - TOWER_DIM, TOWER_DIM, TOWER_DIM, "tower", "blue");
  add(FIELD_W - TOWER_DIM, FIELD_H - TOWER_OFFSET - TOWER_DIM, TOWER_WALL_DEPTH, TOWER_DIM, "towerWall", "blue");

  add(0, 82.32 * SCALE - DEPOT_H / 2, DEPOT_W, DEPOT_H, "depot", "red");
  add(FIELD_W - DEPOT_W, FIELD_H - 82.32 * SCALE - DEPOT_H / 2, DEPOT_W, DEPOT_H, "depot", "blue");
  return { zones, obstacles };
}

export function getStartPosition(players, player) {
  const group = players.filter((other) => other.enabled && other.team === player.team && other.start === player.start);
  const slot = Math.max(0, group.findIndex((other) => other.seat === player.seat));
  const size = group.length || 1;
  const hubOffsets = size === 1 ? [0] : size === 2 ? [-42, 42] : [-42, 0, 42];
  let yOffset = hubOffsets[slot] ?? 0;
  let x;
  let y;

  if (player.team === "red") {
    x = 156.61 * SCALE - 45;
    y = FIELD_H / 2 + yOffset;
  } else {
    x = FIELD_W - 156.61 * SCALE + 10;
    y = FIELD_H / 2 + yOffset;
  }

  if (player.start === 1 || player.start === 2) {
    const frontOffsets = size === 1 ? [0] : [-21, 21, 0];
    const trenchCenter = player.start === 1
      ? FIELD_H / 2 - HUB_S / 2 - BUMP_L - BAR_L - TRENCH_L / 2
      : FIELD_H / 2 + HUB_S / 2 + BUMP_L + BAR_L + TRENCH_L / 2;
    x = player.team === "red"
      ? 156.61 * SCALE - 25 - (slot >= 2 ? 42 : 0)
      : FIELD_W - 156.61 * SCALE - 10 + (slot >= 2 ? 42 : 0);
    y = trenchCenter - BOT_MODELS.turret.h / 2 + (frontOffsets[slot] ?? 0);
  }

  return { x, y, angle: player.team === "red" ? 0 : Math.PI };
}

function createRobot(player, players) {
  const start = getStartPosition(players, player);
  return {
    id: player.seat,
    seat: player.seat,
    team: player.team,
    model: player.model,
    x: player.enabled ? start.x : -1000,
    y: player.enabled ? start.y : -1000,
    vx: 0,
    vy: 0,
    angle: start.angle,
    angularVelocity: 0,
    inventory: 0,
    score: 0,
    lastShotAt: -10,
    streamCooldowns: [0, 0, 0, 0],
    intakeSide: "right",
    unstickUsed: false,
    freezeUntil: 0,
    lastInputSequence: 0
  };
}

function spawnBalls(state) {
  const balls = [];
  const makeBall = (x, y) => ({
    id: state.nextEntityId++,
    x,
    y,
    r: BALL_R,
    vx: 0,
    vy: 0,
    static: true,
    friction: 1,
    rollUntil: 0,
    wasOnBump: false,
    owner: null
  });

  const startX = FIELD_W / 2 - (12 * BALL_R * 2) / 2 + BALL_R;
  const startY = FIELD_H / 2 - (30 * BALL_R * 2) / 2 + BALL_R;
  for (let row = 0; row < 30; row += 1) {
    if (row >= 14 && row <= 15) continue;
    for (let column = 0; column < 12; column += 1) {
      balls.push(makeBall(startX + column * BALL_R * 2, startY + row * BALL_R * 2));
    }
  }

  const redDepotY = 82.32 * SCALE - DEPOT_H / 2;
  const blueDepotY = FIELD_H - 82.32 * SCALE - DEPOT_H / 2;
  const xStep = DEPOT_W / 4;
  const yStep = DEPOT_H / 6;
  for (let row = 0; row < 6; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      balls.push(makeBall(column * xStep + xStep / 2, redDepotY + row * yStep + yStep / 2));
      balls.push(makeBall(FIELD_W - DEPOT_W + column * xStep + xStep / 2, blueDepotY + row * yStep + yStep / 2));
    }
  }
  return balls;
}

export function createGameState({ seed = 0x5eed1234, players = DEFAULT_PLAYERS } = {}) {
  const configuration = players.map(copyPlayerConfig);
  const field = createField();
  const state = {
    schemaVersion: 1,
    seed: seed >>> 0 || 1,
    rngState: seed >>> 0 || 1,
    tick: 0,
    snapshotSequence: 0,
    nextEntityId: 1,
    simulationTime: 0,
    status: "lobby",
    countdownRemaining: 0,
    matchElapsed: 0,
    matchDuration: MATCH_DURATION_SECONDS,
    phaseIndex: -1,
    phaseName: "MATCH NOT STARTED",
    redHubActive: false,
    blueHubActive: false,
    autoWinner: "red",
    autoResolved: false,
    autoScoreRed: 0,
    autoScoreBlue: 0,
    scoreRed: 0,
    scoreBlue: 0,
    players: configuration,
    robots: [],
    balls: [],
    projectiles: [],
    scoringBalls: [],
    zones: field.zones,
    obstacles: field.obstacles
  };
  state.robots = configuration.map((player) => createRobot(player, configuration));
  state.balls = spawnBalls(state);
  return state;
}

export function resetGameState(state, { preserveStatus = false } = {}) {
  const fresh = createGameState({ seed: state.seed, players: state.players });
  if (preserveStatus) fresh.status = state.status;
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, fresh);
  return state;
}

export function reconfigurePlayer(state, seat, updates) {
  const player = state.players.find((item) => item.seat === seat);
  if (!player) return false;
  if (typeof updates.name === "string") player.name = updates.name.trim().slice(0, 24) || `Player ${seat}`;
  if (typeof updates.model === "string" && BOT_MODELS[updates.model]) player.model = updates.model;
  if (Number.isInteger(updates.start) && updates.start >= 0 && updates.start < START_LABELS.length) player.start = updates.start;
  if (typeof updates.enabled === "boolean") player.enabled = updates.enabled;
  if ("inputSource" in updates) player.inputSource = normalizeInputSource(updates.inputSource);
  const robot = state.robots.find((item) => item.seat === seat);
  if (robot) {
    robot.model = player.model;
    const start = getStartPosition(state.players, player);
    robot.x = player.enabled ? start.x : -1000;
    robot.y = player.enabled ? start.y : -1000;
    robot.angle = start.angle;
    robot.vx = 0;
    robot.vy = 0;
    robot.angularVelocity = 0;
  }
  return true;
}

export function restoreSnapshot(snapshot) {
  return structuredClone(snapshot);
}
