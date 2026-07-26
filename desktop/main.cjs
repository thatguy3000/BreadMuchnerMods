const { app, BrowserWindow, dialog } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

if (require("electron-squirrel-startup")) {
  app.quit();
}

let mainWindow = null;
let serverModule = null;
let quitAfterServerClose = false;
const smokeTest = process.argv.includes("--smoke-test");

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

async function startEmbeddedServer() {
  process.env.NODE_ENV = "production";
  process.env.HOST = "0.0.0.0";
  process.env.PORT = process.env.BREADMUNCHER_PORT || "8080";
  const serverUrl = pathToFileURL(path.join(__dirname, "..", "server", "index.js")).href;
  serverModule = await import(serverUrl);
  const address = await serverModule.ready;
  return `http://127.0.0.1:${address.port}`;
}

async function createMainWindow() {
  const url = await startEmbeddedServer();
  mainWindow = new BrowserWindow({
    title: "BreadMuncher Sim",
    width: 1600,
    height: 940,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0d1117",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!targetUrl.startsWith(url)) event.preventDefault();
  });
  if (!smokeTest) mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(url);
  if (smokeTest) {
    const result = await mainWindow.webContents.executeJavaScript(`({
      title: document.title,
      canvas: Boolean(document.querySelector("#field")),
      menu: Boolean(document.querySelector("#mode-menu"))
    })`);
    if (result.title !== "BreadMuncher Sim" || !result.canvas || !result.menu) {
      throw new Error("The packaged game did not load its complete interface.");
    }
    app.quit();
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);
  app.whenReady()
    .then(createMainWindow)
    .catch((error) => {
      if (!smokeTest) {
        dialog.showErrorBox(
          "BreadMuncher Sim could not start",
          `The local game server could not open port ${process.env.BREADMUNCHER_PORT || "8080"}.\n\n${error.message}`
        );
      }
      app.exit(1);
    });
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverModule) createMainWindow().catch(console.error);
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", (event) => {
  if (quitAfterServerClose || !serverModule) return;
  event.preventDefault();
  serverModule.closeServer()
    .catch(console.error)
    .finally(() => {
      quitAfterServerClose = true;
      app.quit();
    });
});
