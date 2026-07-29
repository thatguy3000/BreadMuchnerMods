import assert from "node:assert/strict";
import test from "node:test";
import {
  assignInputSource,
  gamepadIndex,
  gamepadSource,
  normalizeUniqueAssignments,
  swapPlayerProfiles,
  unassignInputSource
} from "../shared/assignments.js";

const players = () => [
  { seat: 1, name: "Alex", team: "red", enabled: true, inputSource: "keyboard" },
  { seat: 2, name: "Blair", team: "red", enabled: true, inputSource: "gamepad:0" },
  { seat: 3, name: "Player 3", team: "red", enabled: true, inputSource: null }
];

test("gamepad source keys round-trip numbered browser slots", () => {
  assert.equal(gamepadSource(0), "gamepad:0");
  assert.equal(gamepadIndex("gamepad:5"), 5);
  assert.equal(gamepadIndex("controller"), null);
});

test("assigning an in-use input swaps assignments without moving names", () => {
  const state = players();
  assert.equal(assignInputSource(state, "keyboard", 2), true);
  assert.equal(state[0].inputSource, "gamepad:0");
  assert.equal(state[1].inputSource, "keyboard");
  assert.equal(state[0].name, "Alex");
  assert.equal(state[1].name, "Blair");
  assert.equal(unassignInputSource(state, "keyboard"), true);
  assert.equal(state[1].inputSource, null);
});

test("occupied spot swaps move names and inputs but leave robot fields alone", () => {
  const state = players().map((player, index) => ({ ...player, model: index ? "dumper" : "turret", score: index * 4 }));
  assert.equal(swapPlayerProfiles(state, 1, 2), true);
  assert.deepEqual([state[0].name, state[0].inputSource], ["Blair", "gamepad:0"]);
  assert.deepEqual([state[1].name, state[1].inputSource], ["Alex", "keyboard"]);
  assert.equal(state[0].model, "turret");
  assert.equal(state[1].model, "dumper");
  assert.equal(state[1].score, 4);
});

test("moving to an open spot transfers the profile and opens the source", () => {
  const state = players();
  assert.equal(swapPlayerProfiles(state, 1, 3), true);
  assert.deepEqual([state[2].name, state[2].inputSource], ["Alex", "keyboard"]);
  assert.deepEqual([state[0].name, state[0].inputSource], ["Player 1", null]);
});

test("normalization removes duplicate and malformed assignments", () => {
  const state = players();
  state[1].inputSource = "keyboard";
  state[2].inputSource = "bad";
  normalizeUniqueAssignments(state);
  assert.equal(state[0].inputSource, "keyboard");
  assert.equal(state[1].inputSource, null);
  assert.equal(state[2].inputSource, null);
});
