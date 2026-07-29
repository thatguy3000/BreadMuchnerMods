import {
  BALL_R,
  BLUE_SHOOT_LIMIT,
  BOT_MODELS,
  FIELD_H,
  FIELD_W,
  FIXED_DT,
  HUB_S,
  MATCH_COUNTDOWN_SECONDS,
  MATCH_DURATION_SECONDS,
  MATCH_PHASES,
  NEUTRAL_INPUT,
  RED_SHOOT_LIMIT,
  SHIFT_STATES
} from "./constants.js";
import { getStartPosition, resetGameState, seededRandom } from "./state.js";

const q = (value, precision = 100) => Math.round(value * precision) / precision;
const rectsOverlap = (x, y, w, h, other) => (
  x < other.x + other.w && x + w > other.x && y < other.y + other.h && y + h > other.y
);

export function circleRectCollision(circle, rect) {
  const closestX = Math.max(rect.x, Math.min(circle.x, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(circle.y, rect.y + rect.h));
  let dx = circle.x - closestX;
  let dy = circle.y - closestY;
  const distanceSquared = dx * dx + dy * dy;
  if (distanceSquared >= circle.r * circle.r) return { hit: false };
  let distance = Math.sqrt(distanceSquared);
  if (distance === 0) {
    dx = 1;
    dy = 0;
    distance = 1;
  }
  return { hit: true, nx: dx / distance, ny: dy / distance, overlap: circle.r - distance };
}

function randomFrom(state, random) {
  return random ? random() : seededRandom(state);
}

export function startMatch(state) {
  if (state.status !== "lobby" && state.status !== "results") return false;
  resetGameState(state);
  state.status = "countdown";
  state.countdownRemaining = MATCH_COUNTDOWN_SECONDS;
  state.phaseName = "MATCH STARTING";
  return true;
}

export function stopMatch(state) {
  if (state.status !== "countdown" && state.status !== "running") return false;
  state.status = "lobby";
  state.countdownRemaining = 0;
  state.matchElapsed = 0;
  state.phaseIndex = -1;
  state.phaseName = "MATCH STOPPED";
  state.redHubActive = false;
  state.blueHubActive = false;
  return true;
}

export function resetMatch(state) {
  resetGameState(state);
  return true;
}

function updatePhase(state, events) {
  if (state.matchElapsed >= MATCH_DURATION_SECONDS) {
    state.matchElapsed = MATCH_DURATION_SECONDS;
    state.status = "results";
    state.phaseIndex = MATCH_PHASES.length - 1;
    state.phaseName = "MATCH OVER";
    state.redHubActive = false;
    state.blueHubActive = false;
    events.push({ type: "matchEnded", scoreRed: state.scoreRed, scoreBlue: state.scoreBlue });
    return;
  }

  let phaseIndex = MATCH_PHASES.findIndex((phase) => state.matchElapsed >= phase.start && state.matchElapsed < phase.end);
  if (phaseIndex < 0) phaseIndex = MATCH_PHASES.length - 1;
  const phase = MATCH_PHASES[phaseIndex];

  if (!state.autoResolved && state.matchElapsed >= 20) {
    state.autoResolved = true;
    state.autoWinner = state.autoScoreBlue > state.autoScoreRed ? "blue" : "red";
    events.push({ type: "autoWinner", winner: state.autoWinner });
  }

  if (phaseIndex !== state.phaseIndex) {
    state.phaseIndex = phaseIndex;
    state.phaseName = phase.name;
    let red = phase.redActive;
    let blue = phase.blueActive;
    if (red === null) {
      const shift = SHIFT_STATES[state.autoWinner][phaseIndex - 3];
      red = shift.redActive;
      blue = shift.blueActive;
    }
    state.redHubActive = red;
    state.blueHubActive = blue;
    events.push({ type: "phaseChanged", phaseIndex, name: phase.name, redHubActive: red, blueHubActive: blue });
  }
}

function normalizeMove(input) {
  let x = input.x || 0;
  let y = input.y || 0;
  const magnitude = Math.hypot(x, y);
  if (magnitude > 0.8) {
    x /= magnitude;
    y /= magnitude;
  }
  return { x, y };
}

function addProjectile(state, robot, alliance, seat, isShooting, stream, streams, spacing, random, standard = false) {
  const model = BOT_MODELS[robot.model];
  const centerX = robot.x + model.w / 2;
  const centerY = robot.y + model.h / 2;
  let launchAngle = robot.angle;
  let speed = standard ? 16 : 20;
  const hub = state.zones.find((zone) => zone.type === "hub" && zone.side === alliance);

  if (isShooting) {
    launchAngle = Math.atan2(hub.y + hub.h / 2 - centerY, hub.x + hub.w / 2 - centerX);
  } else if (robot.model === "Blitz") {
    speed = 13 + randomFrom(state, random) * 2;
  } else {
    const targetX = alliance === "red" ? 40 : FIELD_W - 40;
    const targetY = centerY < FIELD_H / 2 ? 40 : FIELD_H - 40;
    launchAngle = Math.atan2(targetY - centerY, targetX - centerX);
    if (standard) {
      launchAngle += (randomFrom(state, random) - 0.5) * 0.12;
      speed = (13 + Math.hypot(targetX - centerX, targetY - centerY) * 0.012) * (0.85 + randomFrom(state, random) * 0.25);
    } else {
      speed = (9.5 + Math.hypot(targetX - centerX, targetY - centerY) * 0.01) * (0.88 + randomFrom(state, random) * 0.22);
    }
  }

  const perpendicularX = -Math.sin(launchAngle);
  const perpendicularY = Math.cos(launchAngle);
  const randomAngle = launchAngle + (randomFrom(state, random) - 0.5) * (isShooting ? 0.01 : 0.08);
  const streamSpacing = (stream - (streams - 1) / 2) * spacing;
  // Standard turret shots physically leave the robot's front edge even when
  // their velocity is aimed toward a hub or pass target. Multi-stream robots
  // keep their stream spacing perpendicular to their assisted launch angle.
  const originAngle = standard
    ? robot.angle
    : robot.model === "dumper" ? robot.angle + Math.PI : launchAngle;
  const originDistance = model.w / 2 + (standard ? 5 : 4);
  state.projectiles.push({
    id: state.nextEntityId++,
    x: centerX + Math.cos(originAngle) * originDistance + perpendicularX * streamSpacing,
    y: centerY + Math.sin(originAngle) * originDistance + perpendicularY * streamSpacing,
    vx: Math.cos(randomAngle) * speed,
    vy: Math.sin(randomAngle) * speed,
    r: 4,
    owner: alliance,
    playerSeat: seat,
    pass: !isShooting
  });
  robot.inventory -= 1;
}

function fireRobot(state, robot, input, inTower, isShooting, aligned, random) {
  if (!input.action || robot.inventory <= 0 || inTower || !aligned) return;
  const now = state.simulationTime;
  if (robot.model === "dumper" || robot.model === "Blitz") {
    if (now - robot.lastShotAt > 0.5) {
      for (let index = 0; index < 4; index += 1) robot.streamCooldowns[index] = now + index * 0.045;
    }
    for (let index = 0; index < 4; index += 1) {
      if (now >= robot.streamCooldowns[index] && robot.inventory > 0) {
        addProjectile(state, robot, robot.team, robot.seat, isShooting, index, 4, 5.5, random);
        robot.streamCooldowns[index] = now + 0.105 + randomFrom(state, random) * 0.055;
        robot.lastShotAt = now;
      }
    }
  } else if (robot.model === "double turret") {
    if (now - robot.lastShotAt > 0.5) {
      robot.streamCooldowns[0] = now;
      robot.streamCooldowns[1] = now + 0.06;
    }
    for (let index = 0; index < 2; index += 1) {
      if (now >= robot.streamCooldowns[index] && robot.inventory > 0) {
        addProjectile(state, robot, robot.team, robot.seat, isShooting, index, 2, 15, random);
        robot.streamCooldowns[index] = now + 0.12;
        robot.lastShotAt = now;
      }
    }
  } else if (now - robot.lastShotAt > BOT_MODELS[robot.model].fireRate) {
    addProjectile(state, robot, robot.team, robot.seat, isShooting, 0, 1, 0, random, true);
    robot.lastShotAt = now;
  }
}

function updateRobot(state, robot, input, dt, random) {
  const player = state.players.find((item) => item.seat === robot.seat);
  if (!player?.enabled) return;
  // The pre-match countdown is a hard field lock. startMatch() has already
  // reset every robot to its configured start, and no input-driven state may
  // change until the countdown reaches zero and AUTO begins.
  if (state.status === "countdown") return;
  const model = BOT_MODELS[robot.model];
  const tickScale = dt / FIXED_DT;
  robot.lastInputSequence = Math.max(robot.lastInputSequence, input.sequence || 0);

  if (input.toggleIntake && robot.model === "Blitz") {
    robot.intakeSide = robot.intakeSide === "right" ? "left" : "right";
  }

  if (input.unstick && state.status === "running" && !robot.unstickUsed) {
    const start = getStartPosition(state.players, player);
    Object.assign(robot, {
      x: start.x,
      y: start.y,
      angle: start.angle,
      vx: 0,
      vy: 0,
      angularVelocity: 0,
      unstickUsed: true,
      freezeUntil: state.simulationTime + 3
    });
  }

  if (state.simulationTime < robot.freezeUntil) return;
  if (state.status === "running" && state.phaseIndex === 1) {
    robot.vx *= Math.pow(0.5, tickScale);
    robot.vy *= Math.pow(0.5, tickScale);
    robot.angularVelocity *= Math.pow(0.5, tickScale);
    robot.x += robot.vx * tickScale;
    robot.y += robot.vy * tickScale;
    robot.angle += robot.angularVelocity * tickScale;
    return;
  }

  let onBump = false;
  let inTower = false;
  let inDepot = false;
  for (const zone of state.zones) {
    if (!rectsOverlap(robot.x, robot.y, model.w, model.h, zone)) continue;
    if (zone.type === "bump") onBump = true;
    if (zone.type === "tower") inTower = true;
    if (zone.type === "depot") inDepot = true;
  }
  const centerX = robot.x + model.w / 2;
  const centerY = robot.y + model.h / 2;
  const isShooting = robot.team === "red" ? centerX < RED_SHOOT_LIMIT : centerX > BLUE_SHOOT_LIMIT;
  const move = normalizeMove(input);
  const speedModifier = inDepot ? 0.65 : 1;
  const activeDamping = robot.model === "Blitz" ? 0.75 : robot.model === "dumper" ? 0.25 : 0.95;
  const acceleration = onBump ? 0.15 : model.accel * speedModifier * (input.action ? activeDamping : 1);
  robot.vx += move.x * acceleration * tickScale;
  robot.vy += move.y * acceleration * tickScale;

  let aligned = true;
  if ((robot.model === "dumper" || robot.model === "Blitz") && input.action && !inTower) {
    let targetX;
    let targetY;
    if (isShooting) {
      const hub = state.zones.find((zone) => zone.type === "hub" && zone.side === robot.team);
      targetX = hub.x + hub.w / 2;
      targetY = hub.y + hub.h / 2;
    } else {
      targetX = robot.team === "red" ? 0 : FIELD_W;
      targetY = centerY;
      const clearance = HUB_S / 2 + 40;
      if (Math.abs(centerY - FIELD_H / 2) < clearance) {
        targetY = centerY < FIELD_H / 2 ? FIELD_H / 2 - clearance : FIELD_H / 2 + clearance;
      }
    }
    const targetAngle = Math.atan2(targetY - centerY, targetX - centerX);
    // The dumper intakes from its front and launches from its rear, so its
    // chassis must face away from the assisted target before releasing fuel.
    const desiredRobotAngle = robot.model === "dumper" ? targetAngle - Math.PI : targetAngle;
    let difference = desiredRobotAngle - robot.angle;
    while (difference < -Math.PI) difference += Math.PI * 2;
    while (difference > Math.PI) difference -= Math.PI * 2;
    const cap = 0.2 * speedModifier * (isShooting ? 0.45 : 0.6);
    robot.angularVelocity = Math.max(-cap, Math.min(cap, difference * 0.45));
    aligned = Math.abs(difference) <= (robot.model === "Blitz" ? 0.06 : 0.04);
  } else {
    robot.angularVelocity += input.rotation * model.rotSpeed * speedModifier * (input.action ? (isShooting ? 0.45 : 0.6) : 1) * tickScale;
  }

  robot.vx *= Math.pow(0.91, tickScale);
  robot.vy *= Math.pow(0.91, tickScale);
  robot.angularVelocity *= Math.pow(0.78, tickScale);
  const nextX = robot.x + robot.vx * tickScale;
  const nextY = robot.y + robot.vy * tickScale;
  let blockX = false;
  let blockY = false;
  for (const obstacle of state.obstacles) {
    if (obstacle.type === "trench" && robot.inventory < 85) continue;
    if (rectsOverlap(nextX, robot.y, model.w, model.h, obstacle)) blockX = true;
    if (rectsOverlap(robot.x, nextY, model.w, model.h, obstacle)) blockY = true;
  }
  if (!blockX && nextX > 0 && nextX + model.w < FIELD_W) robot.x = nextX;
  if (!blockY && nextY > 0 && nextY + model.h < FIELD_H) robot.y = nextY;
  robot.angle += robot.angularVelocity * tickScale;
  fireRobot(state, robot, input, inTower, isShooting, aligned, random);
}

function resolveRobotCollisions(state) {
  const active = state.robots.filter((robot) => state.players.find((player) => player.seat === robot.seat)?.enabled);
  for (let first = 0; first < active.length; first += 1) {
    for (let second = first + 1; second < active.length; second += 1) {
      const a = active[first];
      const b = active[second];
      const modelA = BOT_MODELS[a.model];
      const modelB = BOT_MODELS[b.model];
      let dx = a.x + modelA.w / 2 - (b.x + modelB.w / 2);
      let dy = a.y + modelA.h / 2 - (b.y + modelB.h / 2);
      const radius = modelA.w / 2 + modelB.w / 2;
      if (dx * dx + dy * dy >= radius * radius) continue;
      let distance = Math.hypot(dx, dy);
      if (!distance) {
        dx = 1;
        dy = 0;
        distance = 1;
      }
      const nx = dx / distance;
      const ny = dy / distance;
      const overlap = radius - distance;
      a.x = Math.max(0, Math.min(FIELD_W - modelA.w, a.x + nx * overlap * 0.5));
      a.y = Math.max(0, Math.min(FIELD_H - modelA.h, a.y + ny * overlap * 0.5));
      b.x = Math.max(0, Math.min(FIELD_W - modelB.w, b.x - nx * overlap * 0.5));
      b.y = Math.max(0, Math.min(FIELD_H - modelB.h, b.y - ny * overlap * 0.5));
      a.vx += nx * 0.5;
      a.vy += ny * 0.5;
      b.vx -= nx * 0.5;
      b.vy -= ny * 0.5;
    }
  }
}

function resolveBallCollision(first, second) {
  let dx = second.x - first.x;
  let dy = second.y - first.y;
  const minimum = first.r + second.r;
  if (dx * dx + dy * dy >= minimum * minimum) return;
  let distance = Math.hypot(dx, dy);
  if (!distance) {
    dx = 1;
    dy = 0;
    distance = 1;
  }
  const nx = dx / distance;
  const ny = dy / distance;
  const overlap = minimum - distance;
  const force = overlap * 0.45;
  first.vx -= nx * force;
  first.vy -= ny * force;
  second.vx += nx * force;
  second.vy += ny * force;
  if (overlap > 0.1) {
    first.static = false;
    second.static = false;
  }
  first.x -= nx * overlap * 0.05;
  first.y -= ny * overlap * 0.05;
  second.x += nx * overlap * 0.05;
  second.y += ny * overlap * 0.05;
}

function updateBalls(state, dt, random) {
  const tickScale = dt / FIXED_DT;
  state.scoringBalls = state.scoringBalls.filter((scoring) => {
    if (state.simulationTime < scoring.exitAt) return true;
    const direction = scoring.side === "red" ? 1 : -1;
    const speed = 3 + randomFrom(state, random);
    const angle = (randomFrom(state, random) - 0.5) * 0.8;
    state.balls.push({
      id: state.nextEntityId++,
      x: scoring.side === "red" ? scoring.hubX + HUB_S + BALL_R + 2 : scoring.hubX - BALL_R - 2,
      y: scoring.hubY + HUB_S / 2,
      r: BALL_R,
      vx: Math.cos(angle) * direction * speed,
      vy: Math.sin(angle) * speed,
      static: false,
      friction: 0.985,
      rollUntil: state.simulationTime + 1.5,
      wasOnBump: false,
      owner: scoring.side
    });
    return false;
  });

  for (let first = 0; first < state.balls.length; first += 1) {
    for (let second = first + 1; second < state.balls.length; second += 1) {
      if (state.balls[first].static && state.balls[second].static) continue;
      resolveBallCollision(state.balls[first], state.balls[second]);
    }
  }

  const retained = [];
  for (const ball of state.balls) {
    let onBump = false;
    for (const zone of state.zones) {
      if (zone.type === "bump" && ball.x > zone.x && ball.x < zone.x + zone.w && ball.y > zone.y && ball.y < zone.y + zone.h) {
        onBump = true;
        ball.static = false;
        ball.vx += (ball.x < zone.x + zone.w / 2 ? -0.12 : 0.12) * tickScale;
      }
    }
    if (!onBump && ball.wasOnBump) {
      ball.vx *= 0.15;
      ball.vy *= 0.15;
    }
    ball.wasOnBump = onBump;
    if (!ball.static) {
      ball.x += ball.vx * tickScale;
      ball.y += ball.vy * tickScale;
      const friction = ball.rollUntil > state.simulationTime ? ball.friction : onBump ? 0.96 : 0.91;
      ball.vx *= Math.pow(friction, tickScale);
      ball.vy *= Math.pow(friction, tickScale);
      if (Math.hypot(ball.vx, ball.vy) < 0.15) {
        ball.vx = 0;
        ball.vy = 0;
        ball.static = true;
      }
    }
    if (ball.x < ball.r) {
      ball.x = ball.r;
      ball.vx *= -0.2;
      ball.static = false;
    } else if (ball.x > FIELD_W - ball.r) {
      ball.x = FIELD_W - ball.r;
      ball.vx *= -0.2;
      ball.static = false;
    }
    if (ball.y < ball.r) {
      ball.y = ball.r;
      ball.vy *= -0.2;
      ball.static = false;
    } else if (ball.y > FIELD_H - ball.r) {
      ball.y = FIELD_H - ball.r;
      ball.vy *= -0.2;
      ball.static = false;
    }
    for (const obstacle of state.obstacles) {
      if (obstacle.type === "trench") continue;
      const collision = circleRectCollision(ball, obstacle);
      if (collision.hit) {
        ball.static = false;
        ball.vx *= 0.8;
        ball.vy *= 0.8;
        ball.x += collision.nx * collision.overlap;
        ball.y += collision.ny * collision.overlap;
      }
    }

    let consumed = false;
    for (const robot of state.robots) {
      const player = state.players.find((item) => item.seat === robot.seat);
      if (!player?.enabled) continue;
      const model = BOT_MODELS[robot.model];
      const intakeOffset = robot.model === "Blitz"
        ? (robot.intakeSide === "right" ? Math.PI / 2 : -Math.PI / 2)
        : 0;
      const intakeX = robot.x + model.w / 2 + Math.cos(robot.angle + intakeOffset) * (model.w / 2 + 5);
      const intakeY = robot.y + model.h / 2 + Math.sin(robot.angle + intakeOffset) * (model.w / 2 + 5);
      if (Math.hypot(ball.x - intakeX, ball.y - intakeY) < 9 && robot.inventory < model.capacity) {
        robot.inventory += 1;
        consumed = true;
        break;
      }
      const collision = circleRectCollision(ball, { x: robot.x, y: robot.y, w: model.w, h: model.h });
      if (collision.hit) {
        ball.static = false;
        ball.owner = robot.team;
        ball.x += collision.nx * collision.overlap;
        ball.y += collision.ny * collision.overlap;
        ball.vx += collision.nx * (Math.abs(robot.vx) * 0.5 + 1);
        ball.vy += collision.ny * (Math.abs(robot.vy) * 0.5 + 1);
      }
    }
    if (consumed) continue;
    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > 25) {
      ball.vx = ball.vx / speed * 25;
      ball.vy = ball.vy / speed * 25;
    }
    retained.push(ball);
  }
  state.balls = retained;
}

function updateProjectiles(state, dt) {
  const tickScale = dt / FIXED_DT;
  const retained = [];
  for (const projectile of state.projectiles) {
    projectile.x += projectile.vx * tickScale;
    projectile.y += projectile.vy * tickScale;
    if (projectile.pass) {
      projectile.vx *= Math.pow(0.975, tickScale);
      projectile.vy *= Math.pow(0.975, tickScale);
    }
    if (projectile.x < projectile.r || projectile.x > FIELD_W - projectile.r) projectile.vx *= -0.4;
    if (projectile.y < projectile.r || projectile.y > FIELD_H - projectile.r) projectile.vy *= -0.4;
    for (const obstacle of state.obstacles) {
      if (obstacle.type === "hub" && !projectile.pass && obstacle.side !== projectile.owner) {
        const collision = circleRectCollision(projectile, obstacle);
        if (collision.hit) {
          projectile.vx *= -0.2;
          projectile.vy *= -0.2;
        }
      }
    }

    let scored = false;
    for (const hub of state.zones) {
      if (hub.type !== "hub" || hub.side !== projectile.owner || projectile.pass) continue;
      if (Math.hypot(projectile.x - (hub.x + hub.w / 2), projectile.y - (hub.y + hub.h / 2)) >= HUB_S / 2) continue;
      state.scoringBalls.push({
        id: state.nextEntityId++,
        exitAt: state.simulationTime + 0.3,
        hubX: hub.x,
        hubY: hub.y,
        side: hub.side
      });
      scored = true;
      const active = projectile.owner === "red" ? state.redHubActive : state.blueHubActive;
      if (state.status === "running" && active) {
        const robot = state.robots.find((item) => item.seat === projectile.playerSeat);
        if (robot?.team === projectile.owner) robot.score += 1;
        if (projectile.owner === "red") {
          state.scoreRed += 1;
          if (!state.autoResolved) state.autoScoreRed += 1;
        } else {
          state.scoreBlue += 1;
          if (!state.autoResolved) state.autoScoreBlue += 1;
        }
      }
      break;
    }
    if (scored) continue;
    if (projectile.pass && Math.hypot(projectile.vx, projectile.vy) < 0.95) {
      state.balls.push({
        id: state.nextEntityId++,
        x: projectile.x,
        y: projectile.y,
        r: BALL_R,
        vx: projectile.vx * 0.35,
        vy: projectile.vy * 0.35,
        static: false,
        friction: 1,
        rollUntil: 0,
        wasOnBump: false,
        owner: projectile.owner
      });
      continue;
    }
    retained.push(projectile);
  }
  state.projectiles = retained;
}

export function stepSimulation(state, inputsByPlayer = {}, deltaSeconds = FIXED_DT, clock = null, random = null) {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0 || deltaSeconds > 0.25) {
    throw new RangeError("deltaSeconds must be between 0 and 0.25");
  }
  const events = [];
  state.tick += 1;
  state.simulationTime = clock == null ? state.simulationTime + deltaSeconds : clock;

  if (state.status === "countdown") {
    state.countdownRemaining = Math.max(0, state.countdownRemaining - deltaSeconds);
    if (state.countdownRemaining === 0) {
      state.status = "running";
      state.matchElapsed = 0;
      state.phaseIndex = -1;
      updatePhase(state, events);
      events.push({ type: "matchStarted" });
    }
  } else if (state.status === "running") {
    state.matchElapsed = Math.min(MATCH_DURATION_SECONDS, state.matchElapsed + deltaSeconds);
    updatePhase(state, events);
  }

  for (const robot of state.robots) {
    const input = inputsByPlayer[robot.seat] || NEUTRAL_INPUT;
    updateRobot(state, robot, input, deltaSeconds, random);
  }
  resolveRobotCollisions(state);
  updateBalls(state, deltaSeconds, random);
  updateProjectiles(state, deltaSeconds);
  return events;
}

function robotTuple(robot) {
  return [
    robot.id,
    robot.seat,
    robot.team === "red" ? 0 : 1,
    robot.model,
    q(robot.x),
    q(robot.y),
    q(robot.vx, 1000),
    q(robot.vy, 1000),
    q(robot.angle, 1000),
    q(robot.angularVelocity, 1000),
    robot.inventory,
    robot.score,
    robot.intakeSide === "right" ? 1 : 0,
    robot.unstickUsed ? 1 : 0,
    q(robot.freezeUntil, 1000),
    robot.lastInputSequence
  ];
}

const ballTuple = (ball) => [
  ball.id,
  q(ball.x),
  q(ball.y),
  q(ball.vx, 1000),
  q(ball.vy, 1000),
  ball.static ? 1 : 0,
  ball.owner === "red" ? 0 : ball.owner === "blue" ? 1 : -1
];
const projectileTuple = (projectile) => [
  projectile.id,
  q(projectile.x),
  q(projectile.y),
  q(projectile.vx, 1000),
  q(projectile.vy, 1000),
  projectile.owner === "red" ? 0 : 1,
  projectile.playerSeat,
  projectile.pass ? 1 : 0
];

export function serializeSnapshot(state, { full = true } = {}) {
  return {
    full,
    sequence: ++state.snapshotSequence,
    tick: state.tick,
    serverTime: q(state.simulationTime, 1000),
    status: state.status,
    countdownRemaining: q(state.countdownRemaining, 100),
    matchElapsed: q(state.matchElapsed, 1000),
    phaseIndex: state.phaseIndex,
    phaseName: state.phaseName,
    redHubActive: state.redHubActive,
    blueHubActive: state.blueHubActive,
    autoWinner: state.autoWinner,
    scoreRed: state.scoreRed,
    scoreBlue: state.scoreBlue,
    robots: state.robots.map(robotTuple),
    balls: state.balls.map(ballTuple),
    projectiles: state.projectiles.map(projectileTuple)
  };
}

function entityDelta(previous = [], current = []) {
  const previousById = new Map(previous.map((entity) => [entity[0], JSON.stringify(entity)]));
  const currentIds = new Set();
  const changed = [];
  for (const entity of current) {
    currentIds.add(entity[0]);
    if (previousById.get(entity[0]) !== JSON.stringify(entity)) changed.push(entity);
  }
  const removed = previous.filter((entity) => !currentIds.has(entity[0])).map((entity) => entity[0]);
  return { changed, removed };
}

export function createSnapshotDelta(previous, current) {
  if (!previous) return current;
  const balls = entityDelta(previous.balls, current.balls);
  const projectiles = entityDelta(previous.projectiles, current.projectiles);
  return {
    ...current,
    full: false,
    balls: balls.changed,
    removedBalls: balls.removed,
    projectiles: projectiles.changed,
    removedProjectiles: projectiles.removed
  };
}

export function applySnapshotDelta(previous, delta) {
  if (!previous || delta.full) return structuredClone(delta);
  const {
    removedBalls = [],
    removedProjectiles = [],
    ...base
  } = delta;
  const merge = (oldEntities, changed, removed = []) => {
    const entities = new Map(oldEntities.map((entity) => [entity[0], entity]));
    for (const id of removed) entities.delete(id);
    for (const entity of changed) entities.set(entity[0], entity);
    return [...entities.values()];
  };
  return {
    ...previous,
    ...base,
    full: true,
    balls: merge(previous.balls, delta.balls, removedBalls),
    projectiles: merge(previous.projectiles, delta.projectiles, removedProjectiles)
  };
}
