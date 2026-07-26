import { BOT_MODELS, DEFAULT_PLAYERS, MATCH_PHASES, START_LABELS } from "../../shared/constants.js";

const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";
const AUTO_RESULTS_PAUSE = MATCH_PHASES[1];
const RAW_MATCH_SECONDS = MATCH_PHASES[MATCH_PHASES.length - 1].end;
const PAUSED_MATCH_SECONDS = AUTO_RESULTS_PAUSE.end - AUTO_RESULTS_PAUSE.start;
export const PLAYABLE_MATCH_SECONDS = RAW_MATCH_SECONDS - PAUSED_MATCH_SECONDS;

function formatClock(value) {
  const seconds = Math.max(0, Math.ceil(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function getPhaseClock(display) {
  const status = display.status;
  const elapsed = Math.max(0, display.matchElapsed || 0);
  const pausedElapsed = Math.max(0, Math.min(PAUSED_MATCH_SECONDS, elapsed - AUTO_RESULTS_PAUSE.start));
  const playableElapsed = Math.max(0, elapsed - pausedElapsed);
  const matchClock = status === "results"
    ? "0:00"
    : formatClock(PLAYABLE_MATCH_SECONDS - playableElapsed);

  if (status === "countdown") {
    return {
      matchClock,
      phaseClock: String(Math.max(1, Math.ceil(display.countdownRemaining || 0))),
      label: "MATCH STARTING",
      timed: true,
      phaseClass: "countdown-phase"
    };
  }
  if (status !== "running") {
    return {
      matchClock,
      phaseClock: "",
      label: display.phaseName || (status === "results" ? "MATCH OVER" : "MATCH NOT STARTED"),
      timed: false,
      phaseClass: "stopped"
    };
  }

  const phaseIndex = display.phaseIndex;
  if (phaseIndex === 0) {
    return { matchClock, phaseClock: formatClock(MATCH_PHASES[0].end - elapsed), label: "AUTO", timed: true, phaseClass: "auto-phase" };
  }
  if (phaseIndex === 1) {
    return {
      matchClock,
      phaseClock: formatClock(AUTO_RESULTS_PAUSE.end - elapsed),
      label: "AUTO RESULTS",
      timed: true,
      phaseClass: "pause-phase"
    };
  }
  if (phaseIndex >= 3 && phaseIndex <= 6) {
    const red = Boolean(display.redHubActive);
    const blue = Boolean(display.blueHubActive);
    const label = red && !blue ? "RED SHIFT" : blue && !red ? "BLUE SHIFT" : "SHIFT";
    const phaseClass = red && !blue ? "red-phase" : blue && !red ? "blue-phase" : "shift-phase";
    return { matchClock, phaseClock: formatClock(MATCH_PHASES[phaseIndex].end - elapsed), label, timed: true, phaseClass };
  }
  if (phaseIndex === 7) {
    return { matchClock, phaseClock: formatClock(MATCH_PHASES[7].end - elapsed), label: "ENDGAME", timed: true, phaseClass: "endgame-phase" };
  }
  return {
    matchClock,
    phaseClock: "",
    label: display.phaseName || "MATCH IN PROGRESS",
    timed: false,
    phaseClass: "untimed-phase"
  };
}

export class UI {
  constructor(actions) {
    this.actions = actions;
    this.mode = "offline";
    this.menu = document.querySelector("#mode-menu");
    this.trigger = document.querySelector("#menu-trigger");
    this.backdrop = document.querySelector("#menu-backdrop");
    this.toastTimer = null;
    this.roomState = null;
    const roomShare = document.querySelector("#room-share");
    document.querySelector("#offline-red-title").after(roomShare);
    roomShare.classList.add("sidebar-room-share");
    this.bind();
  }

  bind() {
    this.trigger.addEventListener("click", () => this.openMenu());
    document.querySelector("#menu-close").addEventListener("click", () => this.closeMenu());
    this.backdrop.addEventListener("click", () => this.closeMenu());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.menu.classList.contains("open")) this.closeMenu();
      if (event.key === "Tab" && this.menu.classList.contains("open")) this.trapFocus(event, this.menu);
    });
    document.querySelector("#offline-mode").addEventListener("click", () => this.actions.selectMode("offline"));
    document.querySelector("#online-mode").addEventListener("click", () => this.actions.selectMode("online"));
    document.querySelector("#create-room").addEventListener("click", () => this.actions.createRoom());
    document.querySelector("#join-room-form").addEventListener("submit", (event) => {
      event.preventDefault();
      this.actions.joinRoom(document.querySelector("#room-code-input").value);
    });
    document.querySelector("#room-code-input").addEventListener("input", (event) => {
      event.target.value = event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 6);
    });
    document.querySelector("#leave-room").addEventListener("click", () => this.actions.leaveRoom());
    document.querySelector("#copy-room").addEventListener("click", () => this.actions.copyRoom());
    document.querySelector("#start-button").addEventListener("click", () => this.actions.toggleMatch());
    document.querySelector("#reset-button").addEventListener("click", () => this.actions.resetMatch());
    document.querySelector("#controls-button").addEventListener("click", () => this.showModal("#controls-dialog"));
    document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => this.hideModal("#controls-dialog")));
    document.querySelectorAll("[data-close-results]").forEach((button) => button.addEventListener("click", () => this.hideModal("#results-dialog")));
    document.querySelectorAll(".modal").forEach((modal) => modal.addEventListener("click", (event) => {
      if (event.target === modal) modal.hidden = true;
    }));
  }

  openMenu() {
    this.menu.classList.add("open");
    this.menu.setAttribute("aria-hidden", "false");
    this.trigger.setAttribute("aria-expanded", "true");
    this.trigger.setAttribute("aria-label", "Close play mode menu");
    this.backdrop.hidden = false;
    requestAnimationFrame(() => document.querySelector("#menu-close").focus());
  }

  closeMenu() {
    if (!this.menu.classList.contains("open")) return;
    this.menu.classList.remove("open");
    this.menu.setAttribute("aria-hidden", "true");
    this.trigger.setAttribute("aria-expanded", "false");
    this.trigger.setAttribute("aria-label", "Open play mode menu");
    this.backdrop.hidden = true;
    this.trigger.focus();
  }

  trapFocus(event, container) {
    const focusable = [...container.querySelectorAll(focusableSelector)].filter((element) => !element.hidden);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  setMode(mode) {
    this.mode = mode;
    // Both play modes use the same fixed competition layout. The online-layout
    // class only identifies networking behavior; it no longer selects a
    // different visual shell.
    document.body.classList.add("offline-layout");
    document.body.classList.toggle("online-layout", mode === "online");
    const offline = document.querySelector("#offline-mode");
    const online = document.querySelector("#online-mode");
    offline.classList.toggle("active", mode === "offline");
    online.classList.toggle("active", mode === "online");
    offline.setAttribute("aria-checked", String(mode === "offline"));
    online.setAttribute("aria-checked", String(mode === "online"));
    document.querySelector("#online-room-controls").hidden = mode !== "online";
    document.querySelector("#mode-kicker").textContent = mode === "online" ? "Online Play" : "Offline Play";
    document.querySelector("#lobby-title").textContent = mode === "online" ? "Room Lobby" : "Local Players";
    document.querySelector("#lobby-description").textContent = mode === "online"
      ? "Claim one seat. Only your player settings are editable, and the host controls the match."
      : "Keyboard controls Player 1. Connected gamepads map to Players 1–6.";
    document.querySelector("#quality").hidden = mode !== "online";
    if (mode === "online") {
      document.querySelector("#start-button").disabled = !this.roomState?.isHost || !this.roomState?.ownedSeat;
      document.querySelector("#reset-button").disabled = !this.roomState?.isHost;
    }
    if (mode === "offline") {
      document.querySelector("#room-share").hidden = true;
      document.querySelector("#leave-room").hidden = true;
    }
    if (this.menu.classList.contains("open")) this.closeMenu();
  }

  connection(state, text) {
    const status = document.querySelector("#connection-status");
    status.dataset.state = state === "connected" ? "connected" : state === "error" || state === "lost" ? "error" : "idle";
    status.textContent = text;
    const banner = document.querySelector("#connection-banner");
    banner.hidden = state !== "reconnecting";
    document.querySelector("#connection-banner-text").textContent = text;
  }

  updateRoom(roomState) {
    this.roomState = roomState;
    const connected = Boolean(roomState?.roomCode);
    document.querySelector("#room-share").hidden = !connected;
    document.querySelector("#leave-room").hidden = !connected;
    document.querySelector("#create-room").hidden = connected;
    document.querySelector("#join-room-form").hidden = connected;
    if (connected) {
      document.querySelector("#room-code-display").textContent = roomState.roomCode;
      this.connection("connected", `${roomState.isHost ? "Hosting" : "Connected to"} room ${roomState.roomCode}`);
    }
    this.renderSeats(roomState?.players || DEFAULT_PLAYERS, roomState);
  }

  renderSeats(players, roomState = null, robotStats = new Map()) {
    const grid = document.querySelector("#seat-grid");
    grid.replaceChildren();
    const redOfflineGrid = document.querySelector("#offline-red-seats");
    const blueOfflineGrid = document.querySelector("#offline-blue-seats");
    redOfflineGrid.replaceChildren();
    blueOfflineGrid.replaceChildren();
    for (const player of players) {
      const card = this.offlinePlayerCard(player, robotStats.get(player.seat), roomState);
      (player.team === "red" ? redOfflineGrid : blueOfflineGrid).append(card);
    }
    this.updateControllerStatus(players, roomState);
  }

  offlinePlayerCard(player, stats, roomState = null) {
    const online = this.mode === "online";
    const owned = online && roomState?.ownedSeat === player.seat;
    const claimed = online && Boolean(player.claimed);
    const locked = online && !["lobby", "results"].includes(roomState?.status);
    const editable = !online || owned;
    const card = document.createElement("article");
    card.className = `offline-player-card ${player.team}${player.enabled === false || (online && !claimed) ? " player-disabled" : ""}${owned ? " owned" : ""}`;
    card.dataset.seat = player.seat;

    const header = document.createElement("div");
    header.className = "offline-player-header";
    const name = this.input(player.name, (value) => this.actions.updatePlayer(player.seat, { name: value }), !editable || locked);
    name.className = "offline-player-name";
    name.setAttribute("aria-label", `Player ${player.seat} name`);
    const alliance = document.createElement("span");
    const statusBadge = online
      ? roomState?.hostSeat === player.seat ? "HOST" : player.connected ? "LIVE" : player.reserved ? "RESERVED" : "OPEN"
      : player.team.toUpperCase();
    alliance.textContent = statusBadge;
    header.append(name, alliance);

    const liveStats = document.createElement("div");
    liveStats.className = "offline-player-stats";
    const intake = player.model === "Blitz" && stats?.intakeSide ? `  •  INTAKE ${stats.intakeSide.toUpperCase()}` : "";
    liveStats.textContent = `SCORE ${stats?.score || 0}  •  FUEL ${stats?.inventory || 0} / ${BOT_MODELS[player.model].capacity}${intake}`;
    card.append(header, liveStats);

    const enabled = document.createElement("button");
    enabled.type = "button";
    enabled.className = `offline-control-button enable-button${player.enabled === false || (online && !claimed) ? " disabled" : ""}`;
    if (online && !claimed) {
      enabled.textContent = `CLAIM PLAYER ${player.seat}`;
      enabled.disabled = locked || Boolean(roomState?.ownedSeat);
      enabled.addEventListener("click", () => this.actions.claimSeat(player.seat));
    } else if (online && owned) {
      enabled.textContent = `RELEASE PLAYER ${player.seat}`;
      enabled.disabled = locked;
      enabled.addEventListener("click", () => this.actions.releaseSeat());
    } else if (online) {
      enabled.textContent = `PLAYER ${player.seat}: ${player.connected ? "REMOTE" : "RESERVED"}`;
      enabled.disabled = true;
    } else {
      enabled.textContent = `PLAYER ${player.seat}: ${player.enabled === false ? "OFF" : "ON"}`;
      enabled.disabled = player.seat === 1;
      enabled.addEventListener("click", () => this.actions.updatePlayer(player.seat, { enabled: player.enabled === false }));
    }

    const model = document.createElement("button");
    model.type = "button";
    model.className = `offline-control-button ${player.team}-team`;
    model.textContent = `P${player.seat} BOT: ${player.model}`;
    model.disabled = !editable || locked;
    model.addEventListener("click", () => {
      const models = Object.keys(BOT_MODELS);
      const next = models[(models.indexOf(player.model) + 1) % models.length];
      this.actions.updatePlayer(player.seat, { model: next });
    });

    const input = document.createElement("button");
    input.type = "button";
    input.className = `offline-control-button ${player.team}-team`;
    input.textContent = online
      ? `P${player.seat}: ${owned ? "KEYBOARD / CONTROLLER" : claimed ? "ONLINE" : "OPEN SEAT"}`
      : `P${player.seat}: ${player.seat === 1 ? "KEYBOARD" : "CONTROLLER"}`;
    input.disabled = true;

    const start = document.createElement("button");
    start.type = "button";
    start.className = `offline-control-button ${player.team}-team`;
    start.textContent = `P${player.seat} START: ${START_LABELS[player.start]}`;
    start.disabled = !editable || locked;
    start.addEventListener("click", () => this.actions.updatePlayer(player.seat, { start: (player.start + 1) % START_LABELS.length }));
    card.append(enabled, model, input, start);
    return card;
  }

  updateControllerStatus(players, roomState = null) {
    const gamepads = navigator.getGamepads?.() || [];
    const online = this.mode === "online";
    const onlineGamepad = [...gamepads].find((item) => item?.connected);
    document.querySelectorAll("[data-controller-seat]").forEach((bubble) => {
      const seat = Number(bubble.dataset.controllerSeat);
      const player = players.find((item) => item.seat === seat);
      const owned = online && roomState?.ownedSeat === seat;
      const gamepad = online ? (owned ? onlineGamepad : null) : gamepads[seat - 1];
      const connected = online ? Boolean(player?.connected) : Boolean(gamepad?.connected);
      const active = Boolean(gamepad?.connected) && (
        gamepad.axes?.some((axis) => Math.abs(axis) > 0.16)
        || gamepad.buttons?.some((button) => button.pressed)
      );
      bubble.classList.toggle("connected", connected);
      bubble.classList.toggle("active", active);
      bubble.querySelector(".controller-map").textContent = online
        ? `P${seat} ${player?.model || "robot"}`
        : `C${seat} → P${seat} ${player?.model || "robot"}`;
      bubble.querySelector(".controller-state").textContent = online
        ? owned ? (active ? "LOCAL GAMEPAD ACTIVE" : "LOCAL CONTROL") : connected ? "REMOTE ONLINE" : player?.reserved ? "RESERVED" : "OPEN SEAT"
        : active ? "ACTIVE" : connected ? "CONNECTED" : "NOT CONNECTED";
    });
  }

  input(value, onChange, disabled) {
    const input = document.createElement("input");
    input.value = value;
    input.maxLength = 24;
    input.disabled = disabled;
    let committed = value;
    const commit = () => {
      if (input.value === committed) return;
      committed = input.value;
      onChange(input.value);
    };
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        commit();
        input.blur();
      }
    });
    return input;
  }

  select(options, value, onChange, disabled, indexValues = false) {
    const select = document.createElement("select");
    for (const [index, label] of options.entries()) {
      const option = document.createElement("option");
      option.value = indexValues ? index : label;
      option.textContent = label;
      select.append(option);
    }
    select.value = String(value);
    select.disabled = disabled;
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  updateMatch(display, players = [], roomState = this.roomState) {
    document.querySelector("#score-red").textContent = display.scoreRed ?? 0;
    document.querySelector("#score-blue").textContent = display.scoreBlue ?? 0;
    const robots = display.robots || [];
    const decoded = robots.map((robot) => Array.isArray(robot) ? {
      seat: robot[1],
      inventory: robot[10],
      score: robot[11],
      intakeSide: robot[12] ? "right" : "left"
    } : robot);
    document.querySelector("#fuel-red").textContent = decoded.filter((robot) => robot.seat <= 3).reduce((sum, robot) => sum + robot.inventory, 0);
    document.querySelector("#fuel-blue").textContent = decoded.filter((robot) => robot.seat >= 4).reduce((sum, robot) => sum + robot.inventory, 0);
    const status = display.status;
    const phaseClock = getPhaseClock(display);
    const clock = document.querySelector("#match-clock");
    const matchStatus = document.querySelector(".match-status");
    clock.textContent = phaseClock.matchClock;
    clock.className = "full-match-clock";
    matchStatus.classList.toggle("untimed", !phaseClock.timed);
    matchStatus.dataset.phase = phaseClock.phaseClass;
    document.querySelector("#phase-label").textContent = phaseClock.label;
    const phaseTimer = document.querySelector("#phase-timer");
    phaseTimer.textContent = phaseClock.phaseClock;
    phaseTimer.className = phaseClock.phaseClass;
    const start = document.querySelector("#start-button");
    const active = status === "running" || status === "countdown";
    start.textContent = active ? (status === "countdown" ? "Cancel Start" : "Stop Match") : "Start Match";
    start.classList.toggle("stop", active);
    if (this.mode === "online") {
      start.disabled = !roomState?.isHost || !roomState?.ownedSeat;
      document.querySelector("#reset-button").disabled = !roomState?.isHost || active;
    } else {
      start.disabled = false;
      document.querySelector("#reset-button").disabled = active;
    }
    const stats = new Map(decoded.map((robot) => [robot.seat, robot]));
    const focusedElement = document.activeElement;
    const editingSeat = focusedElement?.closest?.("#seat-grid, .offline-seat-list");
    if (players.length && !editingSeat) this.renderSeats(players, roomState, stats);
  }

  showResults(scoreRed, scoreBlue, players, names) {
    document.querySelector("#final-red").textContent = scoreRed;
    document.querySelector("#final-blue").textContent = scoreBlue;
    const grid = document.querySelector("#results-players");
    grid.replaceChildren();
    for (const result of players) {
      const row = document.createElement("div");
      row.className = "result-player";
      const name = names?.find((player) => player.seat === result.seat)?.name || `Player ${result.seat}`;
      const label = document.createElement("span");
      label.textContent = name;
      const score = document.createElement("strong");
      score.textContent = result.score;
      row.append(label, score);
      grid.append(row);
    }
    this.showModal("#results-dialog");
  }

  quality(latency) {
    const quality = document.querySelector("#quality");
    quality.dataset.quality = latency > 180 ? "poor" : "good";
    document.querySelector("#quality-text").textContent = latency == null ? "Online" : `${Math.round(latency)} ms`;
  }

  showModal(selector) {
    const modal = document.querySelector(selector);
    modal.hidden = false;
    requestAnimationFrame(() => modal.querySelector("button")?.focus());
  }

  hideModal(selector) {
    document.querySelector(selector).hidden = true;
  }

  toast(message, error = false) {
    const element = document.querySelector("#toast");
    element.textContent = message;
    element.classList.toggle("error", error);
    element.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { element.hidden = true; }, 4200);
  }
}
