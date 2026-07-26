import {
  BALL_R,
  BOT_MODELS,
  FIELD_H,
  FIELD_W,
  HUB_S,
  INTERPOLATION_DELAY_MS,
  WALL_VISUAL
} from "../../shared/constants.js";
import { createField } from "../../shared/state.js";

const alliance = (value) => value === 0 || value === "red" ? "red" : "blue";
const interpolate = (from, to, amount) => from + (to - from) * amount;

function decodeRobot(tuple) {
  return {
    id: tuple[0],
    seat: tuple[1],
    team: alliance(tuple[2]),
    model: tuple[3],
    x: tuple[4],
    y: tuple[5],
    vx: tuple[6],
    vy: tuple[7],
    angle: tuple[8],
    angularVelocity: tuple[9],
    inventory: tuple[10],
    score: tuple[11],
    intakeSide: tuple[12] ? "right" : "left",
    unstickUsed: Boolean(tuple[13]),
    freezeUntil: tuple[14],
    lastInputSequence: tuple[15]
  };
}

function decodeBall(tuple) {
  return { id: tuple[0], x: tuple[1], y: tuple[2], vx: tuple[3], vy: tuple[4], static: Boolean(tuple[5]), owner: tuple[6] < 0 ? null : alliance(tuple[6]), r: BALL_R };
}

function decodeProjectile(tuple) {
  return { id: tuple[0], x: tuple[1], y: tuple[2], vx: tuple[3], vy: tuple[4], owner: alliance(tuple[5]), playerSeat: tuple[6], pass: Boolean(tuple[7]), r: 4 };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.canvas.width = FIELD_W + WALL_VISUAL * 2;
    this.canvas.height = FIELD_H + WALL_VISUAL * 2;
    this.field = createField();
    this.localState = null;
    this.snapshots = [];
    this.controlledSeat = null;
    this.localInput = null;
    this.predicted = null;
  }

  setLocalState(state) {
    this.localState = state;
    this.snapshots = [];
  }

  addSnapshot(snapshot) {
    this.localState = null;
    this.snapshots.push({ receivedAt: performance.now(), snapshot });
    if (this.snapshots.length > 8) this.snapshots.shift();
    if (this.controlledSeat) this.reconcile(snapshot);
  }

  setControlledSeat(seat) {
    if (this.controlledSeat !== seat) this.predicted = null;
    this.controlledSeat = seat;
  }

  setLocalInput(input) {
    this.localInput = input;
  }

  reconcile(snapshot) {
    const authoritative = snapshot.robots.map(decodeRobot).find((robot) => robot.seat === this.controlledSeat);
    if (!authoritative) return;
    if (!this.predicted) {
      this.predicted = { ...authoritative, visualX: authoritative.x, visualY: authoritative.y, visualAngle: authoritative.angle };
      return;
    }
    const distance = Math.hypot(authoritative.x - this.predicted.x, authoritative.y - this.predicted.y);
    if (distance > 80) {
      Object.assign(this.predicted, authoritative, { visualX: authoritative.x, visualY: authoritative.y, visualAngle: authoritative.angle });
    } else {
      this.predicted.x = authoritative.x;
      this.predicted.y = authoritative.y;
      this.predicted.angle = authoritative.angle;
      this.predicted.vx = authoritative.vx;
      this.predicted.vy = authoritative.vy;
      this.predicted.inventory = authoritative.inventory;
      this.predicted.score = authoritative.score;
    }
  }

  render(deltaSeconds = 1 / 60) {
    const state = this.localState ? this.localRenderState() : this.onlineRenderState();
    if (!state) return;
    if (!this.localState) this.applyPrediction(state, deltaSeconds);
    const context = this.context;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.fillStyle = "#0d1117";
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.fillStyle = "#202832";
    context.fillRect(0, 0, this.canvas.width, WALL_VISUAL);
    context.fillRect(0, this.canvas.height - WALL_VISUAL, this.canvas.width, WALL_VISUAL);
    context.fillRect(0, 0, WALL_VISUAL, this.canvas.height);
    context.fillRect(this.canvas.width - WALL_VISUAL, 0, WALL_VISUAL, this.canvas.height);
    context.save();
    context.translate(WALL_VISUAL, WALL_VISUAL);
    this.drawField(context, state);
    for (const robot of state.robots) this.drawRobot(context, robot, state);
    context.fillStyle = "#f4bd45";
    for (const ball of state.balls) {
      context.beginPath();
      context.arc(ball.x, ball.y, ball.r || BALL_R, 0, Math.PI * 2);
      context.fill();
    }
    for (const projectile of state.projectiles) {
      context.beginPath();
      context.arc(projectile.x, projectile.y, projectile.r || 4, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
  }

  localRenderState() {
    const state = this.localState;
    return {
      ...state,
      balls: state.balls,
      projectiles: state.projectiles,
      robots: state.robots
    };
  }

  onlineRenderState() {
    if (!this.snapshots.length) return null;
    const renderAt = performance.now() - INTERPOLATION_DELAY_MS;
    let latest = this.snapshots[this.snapshots.length - 1];
    let previous = this.snapshots[this.snapshots.length - 2];
    for (let index = 1; index < this.snapshots.length; index += 1) {
      if (this.snapshots[index].receivedAt >= renderAt) {
        previous = this.snapshots[index - 1];
        latest = this.snapshots[index];
        break;
      }
    }
    let amount = 1;
    if (previous) {
      const duration = Math.max(1, latest.receivedAt - previous.receivedAt);
      amount = Math.max(0, Math.min(1.25, (renderAt - previous.receivedAt) / duration));
    }
    const current = latest.snapshot;
    const previousRobots = new Map((previous?.snapshot.robots || []).map((tuple) => [tuple[0], decodeRobot(tuple)]));
    const previousBalls = new Map((previous?.snapshot.balls || []).map((tuple) => [tuple[0], decodeBall(tuple)]));
    const previousProjectiles = new Map((previous?.snapshot.projectiles || []).map((tuple) => [tuple[0], decodeProjectile(tuple)]));
    const lerpEntity = (entity, old) => old ? {
      ...entity,
      x: interpolate(old.x, entity.x, Math.min(amount, 1)),
      y: interpolate(old.y, entity.y, Math.min(amount, 1)),
      angle: "angle" in entity ? interpolate(old.angle, entity.angle, Math.min(amount, 1)) : undefined
    } : entity;
    return {
      ...current,
      zones: this.field.zones,
      robots: current.robots.map(decodeRobot).map((robot) => lerpEntity(robot, previousRobots.get(robot.id))),
      balls: current.balls.map(decodeBall).map((ball) => lerpEntity(ball, previousBalls.get(ball.id))),
      projectiles: current.projectiles.map(decodeProjectile).map((projectile) => lerpEntity(projectile, previousProjectiles.get(projectile.id)))
    };
  }

  applyPrediction(state, deltaSeconds) {
    // Never visually predict movement while the server has controls locked.
    // This keeps online countdown and AUTO-results behavior identical to the
    // authoritative/offline simulation.
    if (state.status !== "running" || state.phaseIndex === 1 || !this.controlledSeat || !this.localInput) return;
    const index = state.robots.findIndex((robot) => robot.seat === this.controlledSeat);
    if (index < 0) return;
    const authoritative = state.robots[index];
    if (!this.predicted) this.predicted = { ...authoritative, visualX: authoritative.x, visualY: authoritative.y, visualAngle: authoritative.angle };
    const model = BOT_MODELS[authoritative.model];
    const scale = Math.min(deltaSeconds, 0.05) * 60;
    this.predicted.vx = (this.predicted.vx + this.localInput.x * model.accel * scale) * Math.pow(0.91, scale);
    this.predicted.vy = (this.predicted.vy + this.localInput.y * model.accel * scale) * Math.pow(0.91, scale);
    this.predicted.angularVelocity = ((this.predicted.angularVelocity || 0) + this.localInput.rotation * model.rotSpeed * scale) * Math.pow(0.78, scale);
    this.predicted.visualX = Math.max(0, Math.min(FIELD_W - model.w, (this.predicted.visualX ?? authoritative.x) + this.predicted.vx * scale));
    this.predicted.visualY = Math.max(0, Math.min(FIELD_H - model.h, (this.predicted.visualY ?? authoritative.y) + this.predicted.vy * scale));
    this.predicted.visualAngle = (this.predicted.visualAngle ?? authoritative.angle) + this.predicted.angularVelocity * scale;
    this.predicted.visualX += (authoritative.x - this.predicted.visualX) * 0.08;
    this.predicted.visualY += (authoritative.y - this.predicted.visualY) * 0.08;
    this.predicted.visualAngle += (authoritative.angle - this.predicted.visualAngle) * 0.08;
    state.robots[index] = {
      ...authoritative,
      x: this.predicted.visualX,
      y: this.predicted.visualY,
      angle: this.predicted.visualAngle
    };
  }

  drawField(context, state) {
    for (const zone of this.field.zones) {
      const rgb = zone.side === "red" ? "239,83,80" : "78,141,246";
      if (zone.type === "hub") {
        const active = state.status === "running" ? (zone.side === "red" ? state.redHubActive : state.blueHubActive) : true;
        context.globalAlpha = active ? 1 : 0.3;
        context.strokeStyle = `rgb(${rgb})`;
        context.lineWidth = 4;
        context.strokeRect(zone.x, zone.y, zone.w, zone.h);
        context.beginPath();
        context.fillStyle = "#f5f7fa";
        for (let index = 0; index < 6; index += 1) {
          const angle = Math.PI / 3 * index;
          const x = zone.x + zone.w / 2 + zone.w / 2 * Math.cos(angle);
          const y = zone.y + zone.h / 2 + zone.w / 2 * Math.sin(angle);
          if (!index) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.closePath();
        context.fill();
        context.globalAlpha = 1;
      } else if (zone.type === "barrier" || zone.type === "towerWall") {
        context.fillStyle = `rgb(${rgb})`;
        context.fillRect(zone.x, zone.y, zone.w, zone.h);
      } else if (zone.type === "trench") {
        context.fillStyle = `rgba(${rgb},0.16)`;
        context.fillRect(zone.x, zone.y, zone.w, zone.h);
        context.strokeStyle = `rgba(${rgb},0.5)`;
        context.strokeRect(zone.x, zone.y, zone.w, zone.h);
      } else if (zone.type === "tower") {
        context.fillStyle = "#202832";
        context.fillRect(zone.x, zone.y, zone.w, zone.h);
        context.strokeStyle = "#465162";
        context.strokeRect(zone.x, zone.y, zone.w, zone.h);
      } else if (zone.type === "depot") {
        context.fillStyle = `rgba(${rgb},0.12)`;
        context.fillRect(zone.x, zone.y, zone.w, zone.h);
        context.setLineDash([5, 5]);
        context.strokeStyle = `rgba(${rgb},0.8)`;
        context.strokeRect(zone.x, zone.y, zone.w, zone.h);
        context.setLineDash([]);
      } else {
        context.fillStyle = `rgba(${rgb},0.14)`;
        context.fillRect(zone.x, zone.y, zone.w, zone.h);
      }
    }
  }

  drawRobot(context, robot, state) {
    if (robot.x < -100) return;
    const model = BOT_MODELS[robot.model];
    context.save();
    const now = state.simulationTime ?? state.serverTime ?? 0;
    if (robot.freezeUntil > now && state.status === "running") context.globalAlpha = 0.55;
    context.translate(robot.x + model.w / 2, robot.y + model.h / 2);
    context.rotate(robot.angle);
    context.fillStyle = robot.team === "red" ? "#ef5350" : "#4e8df6";
    context.fillRect(-model.w / 2, -model.h / 2, model.w, model.h);
    context.strokeStyle = robot.seat === this.controlledSeat ? "#f4bd45" : "white";
    context.lineWidth = robot.seat === this.controlledSeat ? 3 : 2;
    context.strokeRect(-model.w / 2, -model.h / 2, model.w, model.h);
    context.fillStyle = "#f4bd45";
    if (robot.model === "Blitz") {
      const intakeY = robot.intakeSide === "right" ? model.h / 2 - 6 : -model.h / 2 - 6;
      context.fillRect(-model.w / 2 + 2, intakeY, model.w - 4, 12);
    } else {
      context.fillRect(model.w / 2 - 2, robot.model === "dumper" ? -14 : -12.5, robot.model === "dumper" ? 5 : 6, robot.model === "dumper" ? 28 : 25);
    }
    context.rotate(-robot.angle);
    context.fillStyle = "white";
    context.textAlign = "center";
    context.font = "800 10px system-ui";
    context.fillText(`P${robot.seat}`, 0, -4);
    context.font = "800 12px system-ui";
    context.fillText(String(robot.inventory), 0, 10);
    context.restore();
  }
}
