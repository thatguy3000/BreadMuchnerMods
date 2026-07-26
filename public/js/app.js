import { DEFAULT_PLAYERS, FIXED_DT } from "../../shared/constants.js";
import { reconfigurePlayer, createGameState } from "../../shared/state.js";
import { resetMatch, startMatch, stepSimulation, stopMatch } from "../../shared/simulation.js";
import { InputManager } from "./input.js";
import { OnlineClient } from "./network.js";
import { Renderer } from "./renderer.js";
import { UI } from "./ui.js";

class BreadMuncherApp {
  constructor() {
    this.mode = "offline";
    this.online = new OnlineClient();
    this.localState = this.createLocalState();
    this.roomState = null;
    this.accumulator = 0;
    this.lastFrameAt = performance.now();
    this.lastUiAt = 0;
    this.previousLocalStatus = this.localState.status;
    this.renderer = new Renderer(document.querySelector("#field"));
    this.renderer.setLocalState(this.localState);
    this.input = new InputManager(() => {
      if (this.mode === "online") this.online.sendNeutral();
    });
    this.ui = new UI({
      selectMode: (mode) => this.selectMode(mode),
      createRoom: () => this.createRoom(),
      joinRoom: (code) => this.joinRoom(code),
      leaveRoom: () => this.leaveRoom(),
      copyRoom: () => this.copyRoom(),
      toggleMatch: () => this.toggleMatch(),
      resetMatch: () => this.reset(),
      claimSeat: (seat) => this.online.claimSeat(seat),
      releaseSeat: () => this.online.releaseSeat(),
      updatePlayer: (seat, update) => this.updatePlayer(seat, update)
    });
    this.bindOnlineEvents();
  }

  createLocalState() {
    const players = DEFAULT_PLAYERS.map((player) => ({
      ...player,
      name: localStorage.getItem(`breadsim-player-name-${player.seat}`) || player.name
    }));
    return createGameState({ seed: 0x5eed1234, players });
  }

  async initialize() {
    this.ui.setMode("offline");
    this.renderLocalLobby();
    const savedMode = localStorage.getItem("breadsim-play-mode");
    if (savedMode === "online") {
      try {
        await this.selectMode("online", { restoring: true });
        const lastRoom = sessionStorage.getItem("breadsim-last-room");
        if (lastRoom && sessionStorage.getItem(`breadsim-reconnect:${lastRoom}`)) {
          await this.online.joinRoom(lastRoom, { reconnect: true });
        }
      } catch {
        this.fallbackOffline("The online server is unavailable. Offline Play is still ready.");
      }
    }
    requestAnimationFrame((time) => this.frame(time));
  }

  bindOnlineEvents() {
    this.online.addEventListener("connection", ({ detail }) => {
      if (detail.state === "connected") this.ui.connection("connected", this.online.roomCode ? `Connected to room ${this.online.roomCode}` : "Online server connected");
      else if (detail.state === "reconnecting") this.ui.connection("reconnecting", "Connection interrupted. Reconnecting to room…");
      else if (detail.state === "lost") this.ui.connection("lost", "The room connection was lost. Return to Offline Play or try again.");
      else this.ui.connection("idle", "Not connected");
    });
    this.online.addEventListener("roomCreated", ({ detail }) => {
      this.ui.toast(`Room ${detail.roomCode} created. Claim a seat, then share the code.`);
    });
    this.online.addEventListener("roomState", ({ detail }) => {
      this.roomState = detail;
      this.ui.updateRoom(detail);
      this.updateOnlineUi(true);
    });
    this.online.addEventListener("seatAssigned", ({ detail }) => {
      this.renderer.setControlledSeat(detail.seat);
      this.ui.toast(detail.reconnected ? `Reconnected to Player ${detail.seat}.` : `You now control Player ${detail.seat}.`);
    });
    this.online.addEventListener("snapshot", ({ detail }) => {
      this.renderer.addSnapshot(detail);
      this.updateOnlineUi();
    });
    this.online.addEventListener("quality", ({ detail }) => this.ui.quality(detail.latency));
    this.online.addEventListener("serverError", ({ detail }) => {
      if (detail.code === "ROOM_NOT_FOUND" && this.online.roomCode) {
        const lostCode = this.online.roomCode;
        this.online.leave();
        this.roomState = null;
        sessionStorage.removeItem("breadsim-last-room");
        this.renderer.setControlledSeat(null);
        this.ui.updateRoom(null);
        this.ui.connection("lost", `Room ${lostCode} no longer exists. The server may have restarted.`);
        this.ui.toast("The online match was lost. Create or join a new room, or return to Offline Play.", true);
        return;
      }
      this.ui.toast(detail.message || "The server rejected that request.", true);
    });
    this.online.addEventListener("matchEnded", ({ detail }) => {
      this.ui.showResults(detail.scoreRed, detail.scoreBlue, detail.players, this.roomState?.players);
    });
  }

  activeStatus() {
    return this.mode === "online" ? this.online.latestSnapshot?.status || this.roomState?.status : this.localState.status;
  }

  modeChangeBlocked() {
    return ["countdown", "running"].includes(this.activeStatus());
  }

  async selectMode(mode, { restoring = false } = {}) {
    if (mode === this.mode && !(mode === "online" && !this.online.connected)) return;
    if (this.modeChangeBlocked()) {
      this.ui.toast("Stop or cancel the current match before changing play modes.", true);
      return;
    }
    if (mode === "online") {
      this.ui.connection("idle", "Connecting to online server…");
      try {
        await this.online.connect();
      } catch (error) {
        this.fallbackOffline(error.message);
        if (!restoring) this.ui.toast(`${error.message} Offline Play remains available.`, true);
        throw error;
      }
      this.mode = "online";
      localStorage.setItem("breadsim-play-mode", "online");
      this.ui.setMode("online");
      this.renderer.setControlledSeat(this.online.ownedSeat);
      this.ui.renderSeats(this.roomState?.players || DEFAULT_PLAYERS, this.roomState);
    } else {
      this.online.leave();
      this.roomState = null;
      this.mode = "offline";
      localStorage.setItem("breadsim-play-mode", "offline");
      this.ui.setMode("offline");
      this.renderer.setControlledSeat(null);
      this.renderer.setLocalState(this.localState);
      this.renderLocalLobby();
    }
  }

  fallbackOffline(message) {
    this.online.leave();
    this.roomState = null;
    this.mode = "offline";
    localStorage.setItem("breadsim-play-mode", "offline");
    this.ui.setMode("offline");
    this.renderer.setControlledSeat(null);
    this.renderer.setLocalState(this.localState);
    this.renderLocalLobby();
    this.ui.connection("error", message);
  }

  async createRoom() {
    try {
      await this.online.createRoom();
    } catch (error) {
      this.ui.toast(error.message, true);
    }
  }

  async joinRoom(code) {
    const normalized = String(code || "").trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(normalized)) {
      this.ui.toast("Enter a valid six-character room code.", true);
      return;
    }
    try {
      await this.online.joinRoom(normalized);
    } catch (error) {
      this.ui.toast(error.message, true);
    }
  }

  leaveRoom() {
    if (this.modeChangeBlocked()) {
      this.ui.toast("The host must stop the match before you leave the room.", true);
      return;
    }
    this.online.leave();
    this.roomState = null;
    this.renderer.setControlledSeat(null);
    this.ui.updateRoom(null);
    this.ui.connection("idle", "Online server disconnected");
  }

  async copyRoom() {
    if (!this.online.roomCode) return;
    try {
      await navigator.clipboard.writeText(this.online.roomCode);
      this.ui.toast(`Room code ${this.online.roomCode} copied.`);
    } catch {
      this.ui.toast(`Room code: ${this.online.roomCode}`);
    }
  }

  toggleMatch() {
    const status = this.activeStatus();
    if (this.mode === "online") {
      this.online.command(status === "running" || status === "countdown" ? "stopMatch" : "startMatch");
    } else if (status === "running" || status === "countdown") {
      stopMatch(this.localState);
    } else {
      startMatch(this.localState);
    }
  }

  reset() {
    if (this.mode === "online") this.online.command("resetMatch");
    else resetMatch(this.localState);
  }

  updatePlayer(seat, update) {
    if (this.mode === "online") {
      if (seat !== this.online.ownedSeat) return;
      this.online.updatePlayer(update);
      return;
    }
    if (["countdown", "running"].includes(this.localState.status)) {
      this.ui.toast("Player settings are locked during a match.", true);
      return;
    }
    reconfigurePlayer(this.localState, seat, update);
    if (typeof update.name === "string") {
      const player = this.localState.players.find((item) => item.seat === seat);
      localStorage.setItem(`breadsim-player-name-${seat}`, player.name);
    }
    this.renderLocalLobby();
  }

  frame(time) {
    const elapsed = Math.min(0.25, (time - this.lastFrameAt) / 1000);
    this.lastFrameAt = time;
    if (this.mode === "offline") this.advanceOffline(elapsed);
    else this.sendOnlineInput();
    this.renderer.render(elapsed);
    if (time - this.lastUiAt > 150) {
      this.lastUiAt = time;
      if (this.mode === "offline") this.updateLocalUi();
      else this.updateOnlineUi();
    }
    requestAnimationFrame((next) => this.frame(next));
  }

  advanceOffline(elapsed) {
    this.accumulator += elapsed;
    while (this.accumulator >= FIXED_DT) {
      const inputs = {};
      for (const player of this.localState.players) {
        if (player.enabled) inputs[player.seat] = this.input.frameForSeat(player.seat);
      }
      const events = stepSimulation(this.localState, inputs, FIXED_DT, this.localState.simulationTime + FIXED_DT);
      if (events.some((event) => event.type === "matchEnded")) {
        this.ui.showResults(
          this.localState.scoreRed,
          this.localState.scoreBlue,
          this.localState.robots.map((robot) => ({ seat: robot.seat, score: robot.score })),
          this.localState.players
        );
      }
      this.accumulator -= FIXED_DT;
    }
    this.renderer.setLocalState(this.localState);
  }

  sendOnlineInput() {
    if (!this.online.ownedSeat) return;
    const frame = this.input.frameForSeat(this.online.ownedSeat, { online: true });
    const sequence = this.online.sendInput(frame);
    this.renderer.setControlledSeat(this.online.ownedSeat);
    this.renderer.setLocalInput({ ...frame, sequence: sequence || this.online.sequence });
  }

  updateLocalUi() {
    this.ui.updateMatch(this.localState, this.localState.players, null);
    this.previousLocalStatus = this.localState.status;
  }

  updateOnlineUi(force = false) {
    const snapshot = this.online.latestSnapshot;
    if (!snapshot) {
      if (force && this.roomState) this.ui.updateRoom(this.roomState);
      return;
    }
    this.ui.updateMatch(snapshot, this.roomState?.players || [], this.roomState);
    const age = performance.now() - this.online.lastSnapshotAt;
    if (age > 1000 && this.online.connected) {
      this.ui.connection("reconnecting", "Waiting for authoritative match updates…");
      if (age > 2500) this.online.requestFullSnapshot();
    }
  }

  renderLocalLobby() {
    this.ui.renderSeats(this.localState.players, null, new Map(this.localState.robots.map((robot) => [robot.seat, robot])));
    this.ui.updateMatch(this.localState, this.localState.players, null);
  }
}

const app = new BreadMuncherApp();
app.initialize();
