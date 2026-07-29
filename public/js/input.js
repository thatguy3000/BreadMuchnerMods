import { NEUTRAL_INPUT } from "../../shared/constants.js";
import { gamepadIndex, gamepadSource, KEYBOARD_SOURCE } from "../../shared/assignments.js";

const movementKeys = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "KeyJ", "KeyL", "Space", "KeyE", "KeyU"
]);

export class InputManager {
  constructor(onNeutral) {
    this.keys = new Set();
    this.previousToggle = new Map();
    this.previousUnstick = new Map();
    this.onNeutral = onNeutral;
    window.addEventListener("keydown", (event) => {
      if (movementKeys.has(event.code) && !this.isTyping(event.target)) event.preventDefault();
      if (!this.isTyping(event.target)) this.keys.add(event.code);
    }, { passive: false });
    window.addEventListener("keyup", (event) => {
      if (movementKeys.has(event.code) && !this.isTyping(event.target)) event.preventDefault();
      this.keys.delete(event.code);
    }, { passive: false });
    window.addEventListener("blur", () => this.neutralize());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.neutralize();
    });
    window.addEventListener("gamepaddisconnected", () => this.onNeutral?.());
  }

  isTyping(target) {
    return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
  }

  neutralize() {
    this.keys.clear();
    this.previousToggle.clear();
    this.previousUnstick.clear();
    this.onNeutral?.();
  }

  frameForSeat(seat, { online = false, inputSource = null } = {}) {
    const gamepads = navigator.getGamepads?.() || [];
    const keyboard = online || inputSource === KEYBOARD_SOURCE;
    const assignedIndex = gamepadIndex(inputSource);
    const gamepad = online
      ? [...gamepads].find((item) => item?.connected)
      : assignedIndex === null ? null : gamepads[assignedIndex];
    let x = 0;
    let y = 0;
    let rotation = 0;
    let action = false;
    let toggleHeld = false;
    let unstickHeld = false;

    if (keyboard) {
      x += (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
      y += (this.keys.has("KeyS") ? 1 : 0) - (this.keys.has("KeyW") ? 1 : 0);
      rotation += (this.keys.has("ArrowRight") || this.keys.has("KeyL") ? 1 : 0)
        - (this.keys.has("ArrowLeft") || this.keys.has("KeyJ") ? 1 : 0);
      action ||= this.keys.has("Space");
      toggleHeld ||= this.keys.has("KeyE");
      unstickHeld ||= this.keys.has("KeyU") || this.keys.has("ArrowUp");
    }

    if (gamepad) {
      const deadzone = (value) => Math.abs(value || 0) > 0.16 ? value : 0;
      x += deadzone(gamepad.axes?.[0]);
      y += deadzone(gamepad.axes?.[1]);
      rotation += deadzone(gamepad.axes?.[2] ?? gamepad.axes?.[3]);
      action ||= Boolean(gamepad.buttons?.[7]?.pressed || gamepad.buttons?.[0]?.pressed);
      toggleHeld ||= Boolean(gamepad.buttons?.[6]?.pressed);
      unstickHeld ||= Boolean(gamepad.buttons?.[12]?.pressed);
    }

    x = Math.max(-1, Math.min(1, x));
    y = Math.max(-1, Math.min(1, y));
    rotation = Math.max(-1, Math.min(1, rotation));
    const toggleIntake = toggleHeld && !this.previousToggle.get(seat);
    const unstick = unstickHeld && !this.previousUnstick.get(seat);
    this.previousToggle.set(seat, toggleHeld);
    this.previousUnstick.set(seat, unstickHeld);
    return { x, y, rotation, action, toggleIntake, unstick };
  }

  activitySnapshot() {
    const keyboardX = (this.keys.has("KeyD") ? 1 : 0) - (this.keys.has("KeyA") ? 1 : 0);
    const keyboardY = (this.keys.has("KeyS") ? 1 : 0) - (this.keys.has("KeyW") ? 1 : 0);
    const keyboardRotation = (this.keys.has("ArrowRight") || this.keys.has("KeyL") ? 1 : 0)
      - (this.keys.has("ArrowLeft") || this.keys.has("KeyJ") ? 1 : 0);
    const sources = [{
      source: KEYBOARD_SOURCE,
      label: "Keyboard",
      detail: "WASD / arrows",
      connected: true,
      x: keyboardX,
      y: keyboardY,
      rotation: keyboardRotation,
      action: this.keys.has("Space"),
      anyButton: this.keys.has("Space") || this.keys.has("KeyE") || this.keys.has("KeyU") || this.keys.has("ArrowUp"),
      toggle: this.keys.has("KeyE"),
      unstick: this.keys.has("KeyU") || this.keys.has("ArrowUp")
    }];

    for (const gamepad of navigator.getGamepads?.() || []) {
      if (!gamepad?.connected) continue;
      const deadzone = (value) => Math.abs(value || 0) > 0.16 ? value : 0;
      sources.push({
        source: gamepadSource(gamepad.index),
        label: `Controller ${gamepad.index + 1}`,
        detail: gamepad.id || "Gamepad",
        connected: true,
        x: deadzone(gamepad.axes?.[0]),
        y: deadzone(gamepad.axes?.[1]),
        rotation: deadzone(gamepad.axes?.[2] ?? gamepad.axes?.[3]),
        anyAxis: Boolean(gamepad.axes?.some((axis) => Math.abs(axis) > 0.16)),
        action: Boolean(gamepad.buttons?.[7]?.pressed || gamepad.buttons?.[0]?.pressed),
        anyButton: Boolean(gamepad.buttons?.some((button) => button.pressed)),
        toggle: Boolean(gamepad.buttons?.[6]?.pressed),
        unstick: Boolean(gamepad.buttons?.[12]?.pressed)
      });
    }
    return sources;
  }

  static neutral() {
    return { ...NEUTRAL_INPUT };
  }
}
