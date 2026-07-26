const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const path = require("node:path");

const executable = path.resolve("out", "BreadMuncher Sim-win32-x64", "BreadMuncherSim.exe");
if (!existsSync(executable)) {
  throw new Error(`Packaged executable not found at ${executable}. Run npm run package:win first.`);
}

const child = spawn(executable, ["--smoke-test"], {
  env: {
    ...process.env,
    BREADMUNCHER_PORT: "0",
    ELECTRON_ENABLE_LOGGING: "1"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let output = "";
child.stdout.on("data", (data) => { output += data; });
child.stderr.on("data", (data) => { output += data; });

const timeout = setTimeout(() => {
  child.kill();
  console.error(output);
  console.error("Packaged desktop smoke test timed out.");
  process.exitCode = 1;
}, 20_000);

child.on("error", (error) => {
  clearTimeout(timeout);
  throw error;
});

child.on("exit", (code) => {
  clearTimeout(timeout);
  if (code !== 0) {
    console.error(output);
    console.error(`Packaged desktop smoke test exited with code ${code}.`);
    process.exitCode = 1;
    return;
  }
  console.log("Packaged desktop app loaded the server, canvas, and play-mode interface.");
});
