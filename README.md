# BreadMuncher Sim

BreadMuncher now supports both local six-player play and server-authoritative
online rooms. The same deterministic simulation is used in both modes.

## Run the web version

Install Node.js 20 or newer, then:

```powershell
npm install
npm start
```

Open `http://localhost:8080`. The server listens on all local interfaces by
default, so devices on the same network can use
`http://<this-computer-ip>:8080` and enter the host's six-character room code.
Allow the port through the local firewall if prompted.

Use the hamburger button in the upper-left to choose Offline Play or Online
Play. In an online room, claim one seat and share the room code. The host must
claim a seat before starting.

## Test it

```powershell
npm test
npm run check
```

The suite covers the deterministic simulation, match phases, scoring,
collisions, compact snapshots, room security, six-seat capacity, reconnects,
host transfer, real WebSocket traffic, and accessible/responsive UI contracts.
Physical gamepads still deserve a manual compatibility pass because browser
gamepad emulation cannot represent every controller.

## Run the Windows app

The desktop app includes the same HTML, canvas renderer, deterministic physics,
offline mode, online rooms, controller support, and authoritative server as the
web version.

For development, install dependencies once and launch the app:

```powershell
Set-Location "C:\Users\yasha\OneDrive\Documents\BreadMuncher Sim"
npm.cmd install
npm.cmd run desktop
```

To build the Windows installer:

```powershell
npm.cmd run make:win
```

Then run:

```text
out\make\squirrel.windows\x64\BreadMuncher-Sim-Setup.exe
```

The installed app starts its own game server on port `8080` and opens the game
automatically. Other players on the same network retain browser access: run
`ipconfig`, find this PC's IPv4 address, and have them open
`http://<this-computer-ip>:8080` before entering the room code. Allow the app
through Windows Firewall if prompted. All participants in an online room must
connect to this same server; internet play still requires exposing the server
through a secure public host or reverse proxy.

For a build verification without showing the app window:

```powershell
npm.cmd run package:win
npm.cmd run smoke:win
```

## Production

Put the Node server behind an HTTPS reverse proxy so the browser uses WSS.
Set `NODE_ENV=production` and `ALLOWED_ORIGINS` to a comma-separated list of
any additional permitted web origins. Optional environment variables are
`HOST`, `PORT`, and `ALLOWED_ORIGINS`.

The health check is available at `/health`. Rooms are intentionally ephemeral:
a server restart ends active rooms, and clients display a clear lost-room
message. Server logs are newline-delimited JSON.

The original standalone simulator remains in `Breadsim6Player.html` as a
reference; the maintained application starts from `public/index.html`.
