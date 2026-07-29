export const KEYBOARD_SOURCE = "keyboard";
export const GAMEPAD_SOURCE_PREFIX = "gamepad:";

export function gamepadSource(index) {
  return Number.isInteger(index) && index >= 0 && index < 16
    ? `${GAMEPAD_SOURCE_PREFIX}${index}`
    : null;
}

export function gamepadIndex(source) {
  if (typeof source !== "string" || !source.startsWith(GAMEPAD_SOURCE_PREFIX)) return null;
  const index = Number(source.slice(GAMEPAD_SOURCE_PREFIX.length));
  return Number.isInteger(index) && index >= 0 && index < 16 ? index : null;
}

export function normalizeInputSource(source) {
  if (source === KEYBOARD_SOURCE) return source;
  const index = gamepadIndex(source);
  return index === null ? null : gamepadSource(index);
}

export function inputSourceLabel(source) {
  if (source === KEYBOARD_SOURCE) return "Keyboard";
  const index = gamepadIndex(source);
  return index === null ? "Unassigned" : `Controller ${index + 1}`;
}

export function assignInputSource(players, source, targetSeat) {
  const normalized = normalizeInputSource(source);
  const target = players.find((player) => player.seat === targetSeat);
  if (!normalized || !target || target.enabled === false) return false;

  const current = players.find((player) => player.inputSource === normalized);
  if (current?.seat === targetSeat) return true;
  const displaced = target.inputSource || null;
  target.inputSource = normalized;
  if (current) current.inputSource = displaced;
  return true;
}

export function unassignInputSource(players, source) {
  const normalized = normalizeInputSource(source);
  const current = players.find((player) => player.inputSource === normalized);
  if (!current) return false;
  current.inputSource = null;
  return true;
}

export function swapPlayerProfiles(players, sourceSeat, targetSeat) {
  if (sourceSeat === targetSeat) return false;
  const source = players.find((player) => player.seat === sourceSeat);
  const target = players.find((player) => player.seat === targetSeat);
  if (!source || !target || source.enabled === false || target.enabled === false || !source.inputSource) return false;

  if (target.inputSource) {
    [source.name, target.name] = [target.name, source.name];
    [source.inputSource, target.inputSource] = [target.inputSource, source.inputSource];
  } else {
    target.name = source.name;
    target.inputSource = source.inputSource;
    source.name = `Player ${source.seat}`;
    source.inputSource = null;
  }
  return true;
}

export function normalizeUniqueAssignments(players) {
  const claimed = new Set();
  for (const player of players) {
    const source = normalizeInputSource(player.inputSource);
    player.inputSource = source && !claimed.has(source) ? source : null;
    if (player.inputSource) claimed.add(player.inputSource);
  }
  return players;
}
