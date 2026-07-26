import assert from "node:assert/strict";
import test from "node:test";
import { getPhaseClock, PLAYABLE_MATCH_SECONDS } from "../public/js/ui.js";

test("full match clock contains only playable phases", () => {
  assert.equal(PLAYABLE_MATCH_SECONDS, 160);
  assert.deepEqual(getPhaseClock({
    status: "countdown",
    countdownRemaining: 2.4,
    matchElapsed: 0
  }), {
    matchClock: "2:40",
    phaseClock: "3",
    label: "MATCH STARTING",
    timed: true,
    phaseClass: "countdown-phase"
  });
});

test("AUTO decrements both the full and phase clocks", () => {
  assert.deepEqual(getPhaseClock({
    status: "running",
    phaseIndex: 0,
    matchElapsed: 4.2,
    phaseName: "AUTO"
  }), {
    matchClock: "2:36",
    phaseClock: "0:16",
    label: "AUTO",
    timed: true,
    phaseClass: "auto-phase"
  });
});

test("AUTO results pause has a separate timer and pauses the full clock", () => {
  const earlyPause = getPhaseClock({ status: "running", phaseIndex: 1, matchElapsed: 20.1 });
  const latePause = getPhaseClock({ status: "running", phaseIndex: 1, matchElapsed: 22.9 });
  assert.equal(earlyPause.matchClock, "2:20");
  assert.equal(latePause.matchClock, "2:20");
  assert.equal(earlyPause.phaseClock, "0:03");
  assert.equal(latePause.phaseClock, "0:01");
  assert.equal(earlyPause.label, "AUTO RESULTS");
});

test("transition resumes the full clock without another phase countdown", () => {
  assert.deepEqual(getPhaseClock({
    status: "running",
    phaseIndex: 2,
    matchElapsed: 25,
    phaseName: "TRANSITION SHIFT"
  }), {
    matchClock: "2:18",
    phaseClock: "",
    label: "TRANSITION SHIFT",
    timed: false,
    phaseClass: "untimed-phase"
  });
});

test("active alliance shifts show their separate phase clocks", () => {
  assert.deepEqual(getPhaseClock({
    status: "running",
    phaseIndex: 3,
    matchElapsed: 40,
    redHubActive: true,
    blueHubActive: false
  }), {
    matchClock: "2:03",
    phaseClock: "0:18",
    label: "RED SHIFT",
    timed: true,
    phaseClass: "red-phase"
  });
  assert.deepEqual(getPhaseClock({
    status: "running",
    phaseIndex: 4,
    matchElapsed: 70.1,
    redHubActive: false,
    blueHubActive: true
  }), {
    matchClock: "1:33",
    phaseClock: "0:13",
    label: "BLUE SHIFT",
    timed: true,
    phaseClass: "blue-phase"
  });
});

test("ENDGAME decrements both clocks to zero", () => {
  assert.deepEqual(getPhaseClock({
    status: "running",
    phaseIndex: 7,
    matchElapsed: 140.4
  }), {
    matchClock: "0:23",
    phaseClock: "0:23",
    label: "ENDGAME",
    timed: true,
    phaseClass: "endgame-phase"
  });
  assert.equal(getPhaseClock({ status: "results", phaseIndex: 7, matchElapsed: 163, phaseName: "MATCH OVER" }).matchClock, "0:00");
});

test("an idle match shows the full duration and no phase timer", () => {
  const clock = getPhaseClock({ status: "lobby", phaseIndex: -1, matchElapsed: 0, phaseName: "MATCH NOT STARTED" });
  assert.equal(clock.matchClock, "2:40");
  assert.equal(clock.phaseClock, "");
});
