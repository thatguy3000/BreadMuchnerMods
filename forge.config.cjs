module.exports = {
  packagerConfig: {
    name: "BreadMuncher Sim",
    executableName: "BreadMuncherSim",
    asar: true,
    prune: true,
    ignore: [
      /^\/(?:out|tests|scripts|coverage|test-results|playwright-report)(?:\/|$)/,
      /^\/\.(?:git|github|agents|codex)(?:\/|$)/,
      /^\/(?:ONLINE_PLAY_PLAN|ONLINE_PROTOCOL)\.md$/,
      /^\/Breadsim6Player\.html$/
    ]
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "breadmuncher_sim",
        setupExe: "BreadMuncher-Sim-Setup.exe",
        noMsi: true
      }
    }
  ]
};
