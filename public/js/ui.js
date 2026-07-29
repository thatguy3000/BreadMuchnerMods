import { BOT_MODELS, DEFAULT_PLAYERS, MATCH_PHASES, START_LABELS } from "../../shared/constants.js";
import { gamepadIndex, inputSourceLabel, KEYBOARD_SOURCE } from "../../shared/assignments.js";

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
    this.swapDialogOpen = false;
    this.resultsOpen = false;
    this.lastActiveSource = null;
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
    document.querySelector("#swap-spots-button").addEventListener("click", () => this.actions.openSwap());
    document.querySelector("#swap-dialog-close").addEventListener("click", () => this.closeSwapDialog());
    document.querySelector("#controls-button").addEventListener("click", () => this.showModal("#controls-dialog"));
    document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => this.hideModal("#controls-dialog")));
    document.querySelectorAll("[data-close-results]").forEach((button) => button.addEventListener("click", () => this.closeResults()));
    document.querySelectorAll(".modal").forEach((modal) => modal.addEventListener("click", (event) => {
      if (event.target !== modal) return;
      if (modal.id === "results-dialog") this.closeResults();
      else if (modal.id === "swap-dialog") this.closeSwapDialog();
      else modal.hidden = true;
    }));
    document.addEventListener("keydown", (event) => {
      const swap = document.querySelector("#swap-dialog");
      if (event.key === "Escape" && !swap.hidden) this.closeSwapDialog();
      if (event.key === "Tab" && !swap.hidden) this.trapFocus(event, swap);
    });
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
      : "Use the live activity chart to assign keyboard and controllers to enabled players.";
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
      : `P${player.seat} INPUT: ${inputSourceLabel(player.inputSource).toUpperCase()}`;
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
    const grid = document.querySelector("#input-source-grid");
    grid.replaceChildren();
    if (this.mode === "online") {
      for (const player of players) {
        const card = document.createElement("article");
        card.className = `input-source-card${player.connected ? " connected" : ""}`;
        card.dataset.onlineSeat = player.seat;
        const heading = document.createElement("div");
        heading.className = "input-source-heading";
        const name = document.createElement("span");
        name.className = "input-source-name";
        name.textContent = `Player ${player.seat}`;
        const state = document.createElement("span");
        state.className = "input-source-state";
        state.textContent = roomState?.ownedSeat === player.seat ? "LOCAL" : player.connected ? "REMOTE" : player.reserved ? "RESERVED" : "OPEN";
        heading.append(name, state);
        const detail = document.createElement("div");
        detail.className = "input-source-detail";
        detail.textContent = player.name;
        card.append(heading, detail);
        grid.append(card);
      }
      return;
    }

    const gamepads = navigator.getGamepads?.() || [];
    const sources = new Set([KEYBOARD_SOURCE]);
    for (const player of players) if (player.inputSource) sources.add(player.inputSource);
    for (const gamepad of gamepads) if (gamepad?.connected) sources.add(`gamepad:${gamepad.index}`);
    const sorted = [...sources].sort((a, b) => {
      if (a === KEYBOARD_SOURCE) return -1;
      if (b === KEYBOARD_SOURCE) return 1;
      return gamepadIndex(a) - gamepadIndex(b);
    });
    const locked = ["countdown", "running"].includes(this.lastStatus);
    for (const source of sorted) grid.append(this.inputSourceCard(source, players, gamepads, locked));
  }

  inputSourceCard(source, players, gamepads, locked) {
    const index = gamepadIndex(source);
    const gamepad = index === null ? null : gamepads[index];
    const connected = source === KEYBOARD_SOURCE || Boolean(gamepad?.connected);
    const assigned = players.find((player) => player.inputSource === source);
    const card = document.createElement("article");
    card.className = `input-source-card${connected ? " connected" : ""}`;
    card.dataset.inputSource = source;

    const heading = document.createElement("div");
    heading.className = "input-source-heading";
    const name = document.createElement("span");
    name.className = "input-source-name";
    name.textContent = inputSourceLabel(source);
    const state = document.createElement("span");
    state.className = "input-source-state";
    state.textContent = connected ? "READY" : "DISCONNECTED";
    heading.append(name, state);
    const detail = document.createElement("div");
    detail.className = "input-source-detail";
    detail.textContent = source === KEYBOARD_SOURCE ? "WASD / arrows" : gamepad?.id || "Reconnect this controller slot";

    const visual = document.createElement("div");
    visual.className = "input-visual";
    const stickWell = document.createElement("div");
    stickWell.className = "stick-well";
    const stickDot = document.createElement("span");
    stickDot.className = "stick-dot";
    stickWell.append(stickDot);
    const bars = document.createElement("div");
    bars.className = "input-bars";
    const axisTrack = document.createElement("div");
    axisTrack.className = "axis-track";
    const axisFill = document.createElement("span");
    axisFill.className = "axis-fill";
    axisTrack.append(axisFill);
    const lights = document.createElement("div");
    lights.className = "button-lights";
    for (const [key, label] of [["action", "BTN"], ["toggle", "T"], ["unstick", "U"]]) {
      const light = document.createElement("span");
      light.className = "button-light";
      light.dataset.light = key;
      light.textContent = label;
      lights.append(light);
    }
    bars.append(axisTrack, lights);
    visual.append(stickWell, bars);

    const select = document.createElement("select");
    select.setAttribute("aria-label", `Assign ${inputSourceLabel(source)} to player`);
    const unassigned = document.createElement("option");
    unassigned.value = "";
    unassigned.textContent = "Unassigned";
    select.append(unassigned);
    for (const player of players) {
      const option = document.createElement("option");
      option.value = String(player.seat);
      option.textContent = `Player ${player.seat}: ${player.name}${player.enabled === false ? " (OFF)" : ""}`;
      option.disabled = player.enabled === false && player.seat !== assigned?.seat;
      select.append(option);
    }
    select.value = assigned ? String(assigned.seat) : "";
    select.disabled = locked;
    select.addEventListener("change", () => this.actions.assignInput(source, select.value ? Number(select.value) : null));
    card.append(heading, detail, visual, select);
    return card;
  }

  updateInputActivity(sources) {
    let newlyActive = null;
    for (const activity of sources) {
      const card = document.querySelector(`[data-input-source="${activity.source}"]`);
      if (!card) continue;
      const active = activity.anyAxis || Math.abs(activity.x) > 0.16 || Math.abs(activity.y) > 0.16 || Math.abs(activity.rotation) > 0.16
        || activity.anyButton || activity.toggle || activity.unstick;
      card.classList.toggle("active", active);
      const dot = card.querySelector(".stick-dot");
      if (dot) dot.style.transform = `translate(calc(-50% + ${activity.x * 8}px), calc(-50% + ${activity.y * 8}px))`;
      const axis = card.querySelector(".axis-fill");
      if (axis) axis.style.transform = `scaleX(${Math.abs(activity.rotation)})`;
      for (const key of ["action", "toggle", "unstick"]) {
        const on = key === "action" ? activity.anyButton : activity[key];
        card.querySelector(`[data-light="${key}"]`)?.classList.toggle("on", Boolean(on));
      }
      if (active) newlyActive = activity.label;
    }
    if (newlyActive && newlyActive !== this.lastActiveSource) {
      document.querySelector("#input-activity-announcement").textContent = `${newlyActive} is active.`;
      this.lastActiveSource = newlyActive;
    } else if (!newlyActive) {
      this.lastActiveSource = null;
    }
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
    this.lastStatus = status;
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
    const pendingSwaps = roomState?.pendingSwaps?.length || 0;
    const swapButton = document.querySelector("#swap-spots-button");
    swapButton.disabled = this.mode === "online" ? !roomState?.ownedSeat : active;
    const swapCount = document.querySelector("#swap-count");
    swapCount.hidden = pendingSwaps === 0;
    swapCount.textContent = String(pendingSwaps);
    start.textContent = active ? (status === "countdown" ? "Cancel Start" : "Stop Match") : "Start Match";
    start.classList.toggle("stop", active);
    if (this.mode === "online") {
      start.disabled = !roomState?.isHost || !roomState?.ownedSeat || (!active && pendingSwaps > 0);
      document.querySelector("#reset-button").disabled = !roomState?.isHost || active;
    } else {
      start.disabled = this.swapDialogOpen;
      document.querySelector("#reset-button").disabled = active;
    }
    const stats = new Map(decoded.map((robot) => [robot.seat, robot]));
    const focusedElement = document.activeElement;
    const editingSeat = focusedElement?.closest?.("#seat-grid, .offline-seat-list");
    if (players.length && !editingSeat) this.renderSeats(players, roomState, stats);
  }

  showSwapComposer(players, { online = false, sourceSeat = null, pendingSwaps = [], isHost = false, active = false } = {}) {
    this.swapDialogOpen = true;
    const content = document.querySelector("#swap-dialog-content");
    content.replaceChildren();
    if (pendingSwaps.length) content.append(this.pendingSwapList(pendingSwaps, sourceSeat, isHost));

    const involved = new Set(pendingSwaps.flatMap((request) => [request.sourceSeat, request.targetSeat]));
    if (online && involved.has(sourceSeat)) {
      const note = document.createElement("p");
      note.className = "swap-instructions";
      note.textContent = "Your current spot already has a pending request. Cancel it or wait for the required approvals.";
      content.append(note);
      this.showModal("#swap-dialog");
      return;
    }

    const chooseSource = (seat) => this.renderSwapTargets(content, players, seat, { online, active, pendingSwaps, isHost });
    if (online) {
      chooseSource(sourceSeat);
    } else {
      const note = document.createElement("p");
      note.className = "swap-instructions";
      note.textContent = "First choose the player profile you want to move.";
      content.append(note, this.swapSeatGrid(players.filter((player) => player.enabled !== false && player.inputSource), chooseSource, involved));
    }
    this.showModal("#swap-dialog");
  }

  pendingSwapList(requests, ownedSeat, isHost) {
    const section = document.createElement("section");
    section.className = "pending-swaps";
    const title = document.createElement("h3");
    title.textContent = "Pending requests";
    section.append(title);
    for (const request of requests) {
      const row = document.createElement("div");
      row.className = "pending-swap-row";
      const label = document.createElement("span");
      label.textContent = `P${request.sourceSeat} -> P${request.targetSeat} - ${request.status.replaceAll("_", " ")}`;
      row.append(label);
      if (isHost || request.sourceSeat === ownedSeat) {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "danger";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => {
          this.actions.cancelSwap(request.id);
          this.closeSwapDialog();
        });
        row.append(cancel);
      }
      section.append(row);
    }
    return section;
  }

  renderSwapTargets(content, players, sourceSeat, { online, active, pendingSwaps, isHost }) {
    content.replaceChildren();
    if (pendingSwaps.length) content.append(this.pendingSwapList(pendingSwaps, sourceSeat, isHost));
    const source = players.find((player) => player.seat === sourceSeat);
    const note = document.createElement("p");
    note.className = "swap-instructions";
    note.textContent = `${source?.name || `Player ${sourceSeat}`} currently controls Spot ${sourceSeat}. Choose a destination robot spot.${active ? " The request will wait until this match ends." : ""}`;
    const involved = new Set(pendingSwaps.flatMap((request) => [request.sourceSeat, request.targetSeat]));
    const targets = players.filter((player) => player.seat !== sourceSeat && (online || player.enabled !== false));
    content.append(note, this.swapSeatGrid(targets, (targetSeat) => {
      const target = players.find((player) => player.seat === targetSeat);
      const occupied = online ? Boolean(target?.claimed) : Boolean(target?.inputSource);
      if (!occupied) {
        this.actions.submitSwap(sourceSeat, targetSeat);
        this.closeSwapDialog();
        return;
      }
      this.renderSwapConfirmation(content, source, target, { online, active });
    }, involved));
  }

  swapSeatGrid(players, onSelect, disabledSeats = new Set()) {
    const grid = document.createElement("div");
    grid.className = "swap-seat-grid";
    for (const player of players) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `swap-seat ${player.team}`;
      button.disabled = disabledSeats.has(player.seat);
      const title = document.createElement("strong");
      title.textContent = `Spot ${player.seat} - ${player.model}`;
      const detail = document.createElement("small");
      const occupied = this.mode === "online" ? player.claimed : Boolean(player.inputSource);
      detail.textContent = occupied ? `${player.name} - OCCUPIED` : "OPEN SPOT";
      button.append(title, detail);
      button.addEventListener("click", () => onSelect(player.seat));
      grid.append(button);
    }
    return grid;
  }

  renderSwapConfirmation(content, source, target, { online, active }) {
    content.replaceChildren();
    const box = document.createElement("div");
    box.className = "swap-confirm";
    const message = document.createElement("p");
    message.textContent = online
      ? `Send ${target.name} a request to exchange Spot ${source.seat} and Spot ${target.seat}?${active ? " Approval will begin after results close." : ""}`
      : `Are you sure you want ${source.name} and ${target.name} to exchange robot spots?`;
    const actions = document.createElement("div");
    actions.className = "swap-actions";
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "secondary";
    deny.textContent = "No, go back";
    deny.addEventListener("click", () => this.closeSwapDialog());
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "primary";
    accept.textContent = online ? "Send request" : "Yes, swap";
    accept.addEventListener("click", () => {
      this.actions.submitSwap(source.seat, target.seat);
      this.closeSwapDialog();
    });
    actions.append(deny, accept);
    box.append(message, actions);
    content.append(box);
    accept.focus();
  }

  showSwapApproval(action, players) {
    this.swapDialogOpen = true;
    const source = players.find((player) => player.seat === action.sourceSeat);
    const target = players.find((player) => player.seat === action.targetSeat);
    const content = document.querySelector("#swap-dialog-content");
    content.replaceChildren();
    const box = document.createElement("div");
    box.className = "swap-confirm";
    const message = document.createElement("p");
    message.textContent = action.role === "target"
      ? `${source?.name || `Player ${action.sourceSeat}`} wants to exchange controls and names with your Spot ${action.targetSeat}. Accept this request?`
      : `Host approval required: move ${source?.name || `Player ${action.sourceSeat}`} from Spot ${action.sourceSeat} to Spot ${action.targetSeat}${target?.claimed ? ` and exchange with ${target.name}` : " (currently open)"}?`;
    const actions = document.createElement("div");
    actions.className = "swap-actions";
    for (const [accepted, label, className] of [[false, "Deny", "danger"], [true, "Accept", "primary"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.textContent = label;
      button.addEventListener("click", () => {
        this.actions.answerSwap(action.id, action.role, accepted);
        this.closeSwapDialog();
      });
      actions.append(button);
    }
    box.append(message, actions);
    content.append(box);
    this.showModal("#swap-dialog");
  }

  closeSwapDialog() {
    this.swapDialogOpen = false;
    this.hideModal("#swap-dialog");
    this.actions.swapDialogClosed?.();
  }

  closeResults() {
    this.resultsOpen = false;
    this.hideModal("#results-dialog");
    this.actions.resultsClosed?.();
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
    this.resultsOpen = true;
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
