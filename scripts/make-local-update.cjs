const fs = require("node:fs/promises");
const path = require("node:path");
const { createWindowsInstaller } = require("electron-winstaller");

async function main() {
  const [appDirectory, outputDirectory, version] = process.argv.slice(2);
  if (!appDirectory || !outputDirectory || !/^\d+\.\d+\.\d+$/.test(version || "")) {
    throw new Error("Usage: node make-local-update.cjs <app-directory> <output-directory> <version>");
  }

  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(outputDirectory, { recursive: true });
  await createWindowsInstaller({
    appDirectory: path.resolve(appDirectory),
    outputDirectory: path.resolve(outputDirectory),
    authors: "BreadMuncher Sim",
    description: "Server-authoritative online and local multiplayer simulator",
    exe: "BreadMuncherSim.exe",
    name: "breadmuncher_sim",
    title: "BreadMuncher Sim",
    version,
    noMsi: true,
    noDelta: true,
    setupExe: "BreadMuncher-Sim-Local-Update.exe"
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

