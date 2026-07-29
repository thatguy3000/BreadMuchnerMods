export const PROTOCOL_VERSION = 1;
export const TICK_RATE = 60;
export const FIXED_DT = 1 / TICK_RATE;
// Thirty authoritative updates per second cuts remote motion latency while
// keeping enough headroom for six clients and the compact delta protocol.
export const SNAPSHOT_RATE = 30;
export const INTERPOLATION_DELAY_MS = 50;
export const INPUT_RESEND_MS = 75;
export const FULL_SNAPSHOT_INTERVAL_MS = 2000;
export const INPUT_TIMEOUT_MS = 350;
export const RECONNECT_GRACE_MS = 30_000;
export const LOBBY_IDLE_MS = 30 * 60_000;
export const EMPTY_ROOM_GRACE_MS = 5_000;
export const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_ROOMS = 100;
export const MATCH_COUNTDOWN_SECONDS = 3;
export const MATCH_DURATION_SECONDS = 163;

export const SCALE = 1.6;
export const FIELD_W = 651.22 * SCALE;
export const FIELD_H = 317.69 * SCALE;
export const WALL_VISUAL = 20;
export const BALL_R = (5.91 * SCALE) / 2;
export const HUB_S = 47 * SCALE;
export const BUMP_W = 44.4 * SCALE;
export const BUMP_L = 73 * SCALE;
export const BAR_L = 12 * SCALE;
export const TRENCH_L = 49.86 * SCALE;
export const RED_SHOOT_LIMIT = (156.61 * SCALE) + (BUMP_W / 2);
export const BLUE_SHOOT_LIMIT = FIELD_W - (156.61 * SCALE) - (BUMP_W / 2);
export const TOWER_OFFSET = 144 * SCALE;
export const TOWER_DIM = 45 * SCALE;
export const TOWER_WALL_DEPTH = 6 * SCALE;
export const DEPOT_W = 24 * SCALE;
export const DEPOT_H = 42 * SCALE;

export const START_LABELS = Object.freeze(["HUB", "TOP TRENCH", "BOT TRENCH"]);

export const BOT_MODELS = Object.freeze({
  turret: Object.freeze({ accel: 0.38, rotSpeed: 0.05, capacity: 105, fireRate: 0.07, w: 35, h: 35 }),
  "Miss Daisy": Object.freeze({ accel: 0.38, rotSpeed: 0.05, capacity: 8, fireRate: 0.085, w: 35, h: 35 }),
  "double turret": Object.freeze({ accel: 0.38, rotSpeed: 0.05, capacity: 85, fireRate: 0.06, w: 35, h: 35 }),
  dumper: Object.freeze({ accel: 0.38, rotSpeed: 0.045, capacity: 110, fireRate: 0, w: 35, h: 35 }),
  Blitz: Object.freeze({ accel: 0.38, rotSpeed: 0.05, capacity: 15, fireRate: 0, w: 35, h: 35 })
});

export const MODEL_KEYS = Object.freeze(Object.keys(BOT_MODELS));

export const MATCH_PHASES = Object.freeze([
  Object.freeze({ name: "AUTO", start: 0, end: 20, redActive: true, blueActive: true }),
  Object.freeze({ name: "AUTO RESULTS PAUSE", start: 20, end: 23, redActive: false, blueActive: false }),
  Object.freeze({ name: "TRANSITION SHIFT", start: 23, end: 33, redActive: true, blueActive: true }),
  Object.freeze({ name: "SHIFT 1", start: 33, end: 58, redActive: null, blueActive: null }),
  Object.freeze({ name: "SHIFT 2", start: 58, end: 83, redActive: null, blueActive: null }),
  Object.freeze({ name: "SHIFT 3", start: 83, end: 108, redActive: null, blueActive: null }),
  Object.freeze({ name: "SHIFT 4", start: 108, end: 133, redActive: null, blueActive: null }),
  Object.freeze({ name: "END GAME", start: 133, end: 163, redActive: true, blueActive: true })
]);

export const SHIFT_STATES = Object.freeze({
  red: Object.freeze([
    Object.freeze({ redActive: false, blueActive: true }),
    Object.freeze({ redActive: true, blueActive: false }),
    Object.freeze({ redActive: false, blueActive: true }),
    Object.freeze({ redActive: true, blueActive: false })
  ]),
  blue: Object.freeze([
    Object.freeze({ redActive: true, blueActive: false }),
    Object.freeze({ redActive: false, blueActive: true }),
    Object.freeze({ redActive: true, blueActive: false }),
    Object.freeze({ redActive: false, blueActive: true })
  ])
});

export const DEFAULT_PLAYERS = Object.freeze([
  Object.freeze({ seat: 1, name: "Player 1", team: "red", model: "turret", start: 0, enabled: true, inputDevice: "keyboard" }),
  Object.freeze({ seat: 2, name: "Player 2", team: "red", model: "double turret", start: 0, enabled: true, inputDevice: "controller" }),
  Object.freeze({ seat: 3, name: "Player 3", team: "red", model: "turret", start: 0, enabled: true, inputDevice: "controller" }),
  Object.freeze({ seat: 4, name: "Player 4", team: "blue", model: "double turret", start: 0, enabled: true, inputDevice: "controller" }),
  Object.freeze({ seat: 5, name: "Player 5", team: "blue", model: "turret", start: 0, enabled: true, inputDevice: "controller" }),
  Object.freeze({ seat: 6, name: "Player 6", team: "blue", model: "double turret", start: 0, enabled: true, inputDevice: "controller" })
]);

export const NEUTRAL_INPUT = Object.freeze({
  x: 0,
  y: 0,
  rotation: 0,
  action: false,
  toggleIntake: false,
  unstick: false,
  sequence: 0
});
