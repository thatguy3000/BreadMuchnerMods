import { randomBytes } from "node:crypto";
import { MAX_ROOMS } from "../shared/constants.js";
import { GameRoom } from "./game-room.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class RoomManager {
  constructor({ maxRooms = MAX_ROOMS, log = console.log } = {}) {
    this.maxRooms = maxRooms;
    this.log = log;
    this.rooms = new Map();
  }

  createRoom() {
    if (this.rooms.size >= this.maxRooms) return null;
    let code;
    do {
      const bytes = randomBytes(6);
      code = [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join("");
    } while (this.rooms.has(code));
    const seed = randomBytes(4).readUInt32LE(0);
    const room = new GameRoom(code, {
      seed,
      log: this.log,
      onEmpty: (roomCode, reason) => this.deleteRoom(roomCode, reason)
    });
    this.rooms.set(code, room);
    this.log({ level: "info", event: "room_created", roomCode: code });
    return room;
  }

  getRoom(code) {
    return this.rooms.get(code);
  }

  deleteRoom(code, reason = "deleted") {
    const room = this.rooms.get(code);
    if (!room) return false;
    this.rooms.delete(code);
    room.close();
    this.log({ level: "info", event: "room_deleted", roomCode: code, reason });
    return true;
  }

  close() {
    for (const room of this.rooms.values()) room.close();
    this.rooms.clear();
  }
}
