import {
  BOT_MODELS,
  MAX_MESSAGE_BYTES,
  MODEL_KEYS,
  NEUTRAL_INPUT,
  PROTOCOL_VERSION
} from "./constants.js";

export const CLIENT_MESSAGE_TYPES = new Set([
  "createRoom",
  "joinRoom",
  "claimSeat",
  "updateLobbyPlayer",
  "releaseSeat",
  "startMatch",
  "stopMatch",
  "resetMatch",
  "playerInput",
  "requestFullSnapshot",
  "ping"
]);

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function makeMessage(type, payload = {}) {
  return { type, version: PROTOCOL_VERSION, ...payload };
}

export function parseClientMessage(data) {
  const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) return { error: "MESSAGE_TOO_LARGE" };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "INVALID_JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "INVALID_MESSAGE" };
  if (value.version !== PROTOCOL_VERSION) return { error: "VERSION_MISMATCH" };
  if (!CLIENT_MESSAGE_TYPES.has(value.type)) return { error: "UNKNOWN_MESSAGE" };
  return { value };
}

export function validateRoomCode(value) {
  return typeof value === "string" && /^[A-Z2-9]{6}$/.test(value.toUpperCase())
    ? value.toUpperCase()
    : null;
}

export function validateSeat(value) {
  return Number.isInteger(value) && value >= 1 && value <= 6 ? value : null;
}

export function sanitizeLobbyUpdate(value) {
  if (!value || typeof value !== "object") return null;
  const update = {};
  if ("name" in value) {
    if (typeof value.name !== "string") return null;
    update.name = value.name.trim().slice(0, 24) || "Player";
  }
  if ("model" in value) {
    if (typeof value.model !== "string" || !BOT_MODELS[value.model]) return null;
    update.model = value.model;
  }
  if ("start" in value) {
    if (!Number.isInteger(value.start) || value.start < 0 || value.start > 2) return null;
    update.start = value.start;
  }
  return update;
}

export function normalizeInput(value, sequence = 0) {
  if (!value || typeof value !== "object") return { ...NEUTRAL_INPUT, sequence };
  return {
    x: clamp(finite(value.x) ? value.x : 0, -1, 1),
    y: clamp(finite(value.y) ? value.y : 0, -1, 1),
    rotation: clamp(finite(value.rotation) ? value.rotation : 0, -1, 1),
    action: value.action === true,
    toggleIntake: value.toggleIntake === true,
    unstick: value.unstick === true,
    sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0
  };
}

export function publicLobbyPlayer(player, ownership) {
  const owner = ownership.get(player.seat);
  return {
    seat: player.seat,
    name: player.name,
    team: player.team,
    model: MODEL_KEYS.includes(player.model) ? player.model : MODEL_KEYS[0],
    start: player.start,
    claimed: Boolean(owner),
    connected: Boolean(owner?.connected),
    reserved: Boolean(owner && !owner.connected)
  };
}
