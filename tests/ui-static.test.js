import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  INPUT_RESEND_MS,
  INTERPOLATION_DELAY_MS,
  SNAPSHOT_RATE
} from "../shared/constants.js";

const root = new URL("../", import.meta.url);

test("mode menu exposes accessible controls and no inline event handlers", async () => {
  const html = await readFile(new URL("public/index.html", root), "utf8");
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/js\/app\.js"/);
  assert.match(html, /id="menu-trigger"[^>]+aria-label="Open play mode menu"/);
  assert.match(html, /id="mode-menu"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /id="menu-close"[^>]+aria-label="Close play mode menu"/);
  assert.doesNotMatch(html, /\son(?:click|keydown|submit)=/i);
});

test("responsive CSS keeps menu bounded and honors reduced motion", async () => {
  const css = await readFile(new URL("public/styles.css", root), "utf8");
  assert.match(css, /\.mode-menu\s*\{[\s\S]*width:\s*min\(390px,\s*calc\(100vw - 24px\)\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /transition-duration:\s*0\.001ms/);
  assert.match(css, /@media\s*\(max-width:\s*430px\)/);
});

test("client rendering never injects player names as HTML", async () => {
  const files = await Promise.all([
    readFile(new URL("public/js/ui.js", root), "utf8"),
    readFile(new URL("public/js/app.js", root), "utf8")
  ]);
  assert.doesNotMatch(files.join("\n"), /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(files[0], /textContent = name/);
});

test("both modes use the fixed alliance panels from the legacy layout", async () => {
  const [html, css, ui] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/styles.css", root), "utf8"),
    readFile(new URL("public/js/ui.js", root), "utf8")
  ]);
  assert.match(html, /<body class="offline-layout">/);
  assert.match(html, /id="offline-red-controls"/);
  assert.match(html, /id="offline-blue-controls"/);
  assert.match(html, /id="offline-controller-status"/);
  assert.match(css, /\.offline-layout \.offline-team-controls\s*\{[\s\S]*position:\s*fixed/);
  assert.match(css, /\.offline-layout #field\s*\{[\s\S]*max-width:\s*calc\(100vw - 450px\)/);
  assert.match(ui, /document\.body\.classList\.add\("offline-layout"\)/);
  assert.match(ui, /offlinePlayerCard\(player, robotStats\.get\(player\.seat\), roomState\)/);
});

test("full match and excluded pause clocks are rendered separately", async () => {
  const [html, ui] = await Promise.all([
    readFile(new URL("public/index.html", root), "utf8"),
    readFile(new URL("public/js/ui.js", root), "utf8")
  ]);
  assert.match(html, /class="match-clock-title">FULL MATCH/);
  assert.match(html, /id="match-clock">2:40</);
  assert.doesNotMatch(ui, /163\s*-\s*elapsed/);
  assert.match(ui, /PLAYABLE_MATCH_SECONDS/);
  assert.match(ui, /phaseTimer\.textContent = phaseClock\.phaseClock/);
  assert.match(ui, /getPhaseClock/);
});

test("online prediction respects authoritative control-lock phases", async () => {
  const renderer = await readFile(new URL("public/js/renderer.js", root), "utf8");
  assert.match(renderer, /state\.status !== "running" \|\| state\.phaseIndex === 1/);
});

test("online rendering uses a low-latency buffered snapshot timeline", async () => {
  const [renderer, network, server] = await Promise.all([
    readFile(new URL("public/js/renderer.js", root), "utf8"),
    readFile(new URL("public/js/network.js", root), "utf8"),
    readFile(new URL("server/index.js", root), "utf8")
  ]);
  assert.equal(SNAPSHOT_RATE, 30);
  assert.equal(INTERPOLATION_DELAY_MS, 50);
  assert.ok(INPUT_RESEND_MS <= 75);
  assert.match(renderer, /renderAt = performance\.now\(\) - INTERPOLATION_DELAY_MS/);
  assert.match(renderer, /this\.snapshots\[index\]\.receivedAt >= renderAt/);
  assert.match(network, /INPUT_RESEND_MS/);
  assert.match(server, /socket\.setNoDelay\(true\)/);
});

test("Windows desktop entry point embeds the complete web server safely", async () => {
  const [desktop, packageFile, forge] = await Promise.all([
    readFile(new URL("desktop/main.cjs", root), "utf8"),
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("forge.config.cjs", root), "utf8")
  ]);
  const packageJson = JSON.parse(packageFile);
  assert.equal(packageJson.main, "desktop/main.cjs");
  assert.match(packageJson.scripts["make:win"], /electron-forge make/);
  assert.match(desktop, /contextIsolation:\s*true/);
  assert.match(desktop, /nodeIntegration:\s*false/);
  assert.match(desktop, /serverModule\.ready/);
  assert.match(desktop, /document\.querySelector\("#field"\)/);
  assert.match(forge, /BreadMuncher-Sim-Setup\.exe/);
});
