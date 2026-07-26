# BreadMuncher online play protocol

Protocol version: **1**

The server owns rooms, seats, match time, physics, scoring, and randomness. A
browser may own at most one of the six seats in a room and may only send
normalized controller input and edits for that seat. Seats 1-3 are red and
seats 4-6 are blue. The first connection in a room is the host; only the host
may start, stop, or reset a match.

Rooms use anonymous six-character invite codes. A claimed seat receives a
private reconnect token. On disconnect its input is neutralized immediately
and the seat remains reserved for 30 seconds. If the host leaves, host control
passes to the oldest remaining connection. Empty rooms and inactive lobbies
are removed automatically.

Lobby configuration locks during countdown, play, and results. Mode changes
are blocked while a countdown or match is active. Leaving Online Play sends a
seat release, leaves the room, closes the socket, and returns to the same
shared simulation running locally.

Every JSON message has `type` and `version`. Client messages are:
`createRoom`, `joinRoom`, `claimSeat`, `updateLobbyPlayer`, `releaseSeat`,
`startMatch`, `stopMatch`, `resetMatch`, `playerInput`,
`requestFullSnapshot`, and `ping`. Server messages are: `roomCreated`,
`roomState`, `seatAssigned`, `matchStarted`, `snapshot`, `matchEvent`,
`matchEnded`, `pong`, and `error`.

`playerInput` includes the room code, owned seat, increasing sequence number,
axes clamped to -1 through 1, held action state, and one-shot intake-toggle and
unstick flags. Clients never send positions, scores, inventory, phase, or
match time. Messages over 16 KiB, malformed JSON, unknown fields that alter
authority, stale input sequences, commands from non-owners, and excessive
command rates are rejected or ignored.

The server runs a 60 Hz fixed-step seeded simulation and publishes snapshots
at 20 Hz. A full recovery snapshot is sent on join/reconnect, on request, and
periodically; intermediate snapshots contain changed entity tuples and
removed IDs. Clients render from a short snapshot buffer, predict only their
own robot, and reconcile using the acknowledged input sequence.
