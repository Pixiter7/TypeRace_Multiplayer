// TypeRace server — authoritative multiplayer typing races over WebSockets.
// The server owns all race state: it picks the text, validates every keystroke,
// computes WPM/accuracy, and broadcasts synchronized standings to the room.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const { TEXTS } = require("./texts");

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 2;          // start as soon as 2 racers are queued
const QUEUE_WAIT_MS = Number(process.env.QUEUE_WAIT_MS) || 12000; // start with whoever is waiting
const COUNTDOWN_MS = 3000;
const RACE_TIMEOUT_MS = 120000; // hard cap per race
const MAX_WPM = 260;            // anti-cheat: nobody sustains more than this
const SPEED_WARMUP_MS = 2000;   // speed check starts after this (a fast first keystroke is not cheating)
const MAX_CHARS_PER_UPDATE = 40;// anti-cheat: cap burst size per message

const app = express();
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const io = new Server(server);

// ---------- All-time leaderboard (persisted to disk) ----------
const LB_PATH = process.env.LB_PATH || path.join(__dirname, "leaderboard.json");
let allTime = [];
try {
  allTime = JSON.parse(fs.readFileSync(LB_PATH, "utf8"));
  if (!Array.isArray(allTime)) allTime = [];
} catch { allTime = []; }

function saveAllTime() {
  try { fs.writeFileSync(LB_PATH, JSON.stringify(allTime.slice(0, 10), null, 2)); }
  catch (e) { console.error("leaderboard save failed:", e.message); }
}

// ---------- Matchmaking ----------
const rooms = new Map(); // roomId -> room
let queue = [];          // [{ socket, name }]
let queueTimer = null;

function publicPlayers(room) {
  return room.players.map((p) => ({
    name: p.name,
    progress: p.progress,
    wpm: Math.round(p.wpm),
    accuracy: Math.round(p.accuracy * 10) / 10,
    finished: p.finished,
    finishMs: p.finishMs,
    left: p.left,
    cheated: !!p.cheated,
  }));
}

function cleanName(raw) {
  const n = String(raw || "").trim().slice(0, 20);
  return n || "Racer";
}

io.on("connection", (socket) => {
  socket.on("queue:join", ({ name } = {}) => {
    if (queue.some((q) => q.socket.id === socket.id)) return;
    queue.push({ socket, name: cleanName(name) });
    io.emit("queue:count", { count: queue.length });
    if (queue.length >= MIN_PLAYERS) {
      clearTimeout(queueTimer); queueTimer = null;
      startRoom(queue.splice(0, queue.length));
    } else if (!queueTimer) {
      queueTimer = setTimeout(() => {
        queueTimer = null;
        if (queue.length > 0) startRoom(queue.splice(0, queue.length));
      }, QUEUE_WAIT_MS);
    }
  });

  socket.on("queue:leave", () => removeFromQueue(socket.id));

  socket.on("race:progress", ({ typed, keystrokes, errors } = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.state !== "racing") return;
    const p = room.players.find((x) => x.socket.id === socket.id);
    if (!p || p.finished || p.left) return;

    // ---- Server-side input validation (anti-cheat) ----
    if (typeof typed !== "string" || !room.text.startsWith(typed)) {
      socket.emit("race:rejected", { reason: "mismatch" }); return;
    }
    const delta = typed.length - p.typed.length;
    if (delta < 0 || delta > MAX_CHARS_PER_UPDATE) {
      socket.emit("race:rejected", { reason: "burst" }); return;
    }
    const ks = Number(keystrokes) || 0, er = Number(errors) || 0;
    if (er < 0 || er > ks || ks < typed.length) {
      socket.emit("race:rejected", { reason: "bad-stats" }); return;
    }
    const elapsedMin = (Date.now() - room.startTime) / 60000;
    const wpm = elapsedMin > 0 ? (typed.length / 5) / elapsedMin : 0;
    // Speed sanity check kicks in after a short warmup: a fast first
    // keystroke is human, a sustained inhuman average is not.
    if (elapsedMin >= SPEED_WARMUP_MS / 60000 && wpm > MAX_WPM) {
      socket.emit("race:rejected", { reason: "impossible-speed" }); return;
    }

    p.typed = typed;
    p.keystrokes = ks; p.errors = er;
    p.progress = typed.length / room.text.length;
    p.wpm = wpm;
    p.accuracy = ks > 0 ? ((ks - er) / ks) * 100 : 100;

    if (typed.length === room.text.length) {
      p.finished = true;
      p.finishMs = Date.now() - room.startTime;
      // Final sanity check: an inhuman average over the whole race means
      // automation, even if every individual chunk looked plausible.
      if (p.wpm > MAX_WPM) {
        p.cheated = true;
        socket.emit("race:rejected", { reason: "impossible-speed" });
      }
    }
    io.to(room.id).emit("race:update", { players: publicPlayers(room) });
    if (room.players.every((x) => x.finished || x.left)) endRace(room, "complete");
  });

  socket.on("leaderboard:get", (cb) => {
    if (typeof cb === "function") cb(allTime.slice(0, 10));
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);
    const room = rooms.get(socket.data.roomId);
    if (room) {
      const p = room.players.find((x) => x.socket.id === socket.id);
      if (p) {
        p.left = true;
        io.to(room.id).emit("race:update", { players: publicPlayers(room) });
        if (room.players.every((x) => x.finished || x.left)) endRace(room, "complete");
      }
    }
  });
});

function removeFromQueue(socketId) {
  queue = queue.filter((q) => q.socket.id !== socketId);
  io.emit("queue:count", { count: queue.length });
  if (queue.length === 0 && queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
}

function startRoom(queued) {
  const room = {
    id: "room-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    text: TEXTS[Math.floor(Math.random() * TEXTS.length)],
    players: queued.map(({ socket, name }) => ({
      socket, name, typed: "", keystrokes: 0, errors: 0,
      progress: 0, wpm: 0, accuracy: 100,
      finished: false, finishMs: null, left: false, cheated: false,
    })),
    state: "countdown",
    startTime: null,
    timer: null,
  };
  queued.forEach(({ socket }) => {
    socket.join(room.id);
    socket.data.roomId = room.id;
  });
  rooms.set(room.id, room);
  io.to(room.id).emit("race:countdown", {
    players: publicPlayers(room), countdownMs: COUNTDOWN_MS,
  });
  setTimeout(() => {
    if (!rooms.has(room.id)) return;
    room.state = "racing";
    room.startTime = Date.now();
    io.to(room.id).emit("race:start", { text: room.text, players: publicPlayers(room) });
    room.timer = setTimeout(() => endRace(room, "timeout"), RACE_TIMEOUT_MS);
  }, COUNTDOWN_MS);
}

function endRace(room, why) {
  if (!rooms.has(room.id)) return;
  clearTimeout(room.timer);
  rooms.delete(room.id);
  const standings = [...room.players]
    .sort((a, b) => {
      if (!!a.cheated !== !!b.cheated) return a.cheated ? 1 : -1; // cheaters rank below honest racers
      if (a.finished && b.finished) return a.finishMs - b.finishMs;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    })
    .map((p) => ({
      name: p.name,
      wpm: Math.round(p.wpm),
      accuracy: Math.round(p.accuracy * 10) / 10,
      finished: p.finished,
      finishMs: p.finishMs,
      left: p.left,
      cheated: !!p.cheated,
    }));
  // Fold honest finishers into the all-time board (top 10 by WPM).
  for (const s of standings) {
    if (s.finished && !s.left && !s.cheated) {
      allTime.push({ name: s.name, wpm: s.wpm, accuracy: s.accuracy, at: new Date().toISOString() });
    }
  }
  allTime.sort((a, b) => b.wpm - a.wpm);
  allTime = allTime.slice(0, 10);
  saveAllTime();
  io.to(room.id).emit("race:end", { standings, allTime, why });
  room.players.forEach((p) => {
    p.socket.leave(room.id);
    if (p.socket.data.roomId === room.id) delete p.socket.data.roomId;
  });
}

server.listen(PORT, () => console.log(`TypeRace running on http://localhost:${PORT}`));
