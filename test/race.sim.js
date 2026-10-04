// End-to-end simulation: boots the real server and drives it like real
// players — matchmaking, honest racing, a mid-race disconnect, and a
// cheater probing every server-side validation.
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { io } = require("socket.io-client");

const PORT = 3456;
const URL = `http://localhost:${PORT}`;
const TEST_LB = path.join(__dirname, "leaderboard.test.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (sock, ev, ms = 25000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout waiting for " + ev)), ms);
    sock.once(ev, (d) => { clearTimeout(t); res(d); });
  });
const assert = (c, msg) => { if (!c) throw new Error("ASSERT FAILED: " + msg); console.log("  ok -", msg); };

(async () => {
  try { fs.unlinkSync(TEST_LB); } catch {}
  const server = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(PORT), QUEUE_WAIT_MS: "600", LB_PATH: TEST_LB },
    stdio: "pipe",
  });
  server.on("error", (e) => { throw e; });
  await sleep(1500);

  try {
    // --- 1. Matchmaking: two racers queueing together start instantly ---
    const a = io(URL), b = io(URL);
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    console.log("racers connected");
    a.emit("queue:join", { name: "Alice" });
    b.emit("queue:join", { name: "Bob" });
    const { text, players } = await once(a, "race:start");
    assert(text.length > 40, "server dealt a race paragraph");
    assert(players.length === 2, "two queued racers matched into one room");

    // --- 2. Solo queue: a lone racer gets a room after the queue timeout ---
    const cheat = io(URL);
    await once(cheat, "connect");
    cheat.emit("queue:join", { name: "Cheater" });
    const startC = await once(cheat, "race:start");
    assert(startC.players.length === 1, "solo racer gets a room after the queue timeout");

    // --- 3. Anti-cheat: input must be an exact prefix of the race text ---
    cheat.emit("race:progress", { typed: "zzz not the text", keystrokes: 5, errors: 0 });
    const rej1 = await once(cheat, "race:rejected");
    assert(rej1.reason === "mismatch", "rejects input that is not a prefix of the race text");

    // --- 4. Anti-cheat: inhuman burst speed after the warmup ---
    // Type honestly for ~2.3s (well under the cap), then fire one 40-char
    // burst: ~330 WPM average -> must be rejected.
    const ctext = startC.text;
    for (let i = 8; i <= 24; i += 8) {
      cheat.emit("race:progress", { typed: ctext.slice(0, i), keystrokes: i, errors: 0 });
      await sleep(500);
    }
    await sleep(800);
    cheat.emit("race:progress", { typed: ctext.slice(0, 64), keystrokes: 64, errors: 0 });
    const rej2 = await once(cheat, "race:rejected");
    assert(rej2.reason === "impossible-speed", "rejects inhuman burst speed");
    cheat.disconnect();

    // --- 5. Honest race at human pace (~200 WPM); Bob quits halfway ---
    let bi = 0;
    const bobTimer = setInterval(() => {
      bi += 5;
      if (bi >= text.length / 2) { clearInterval(bobTimer); b.disconnect(); return; }
      b.emit("race:progress", { typed: text.slice(0, bi), keystrokes: bi, errors: 0 });
    }, 300);

    for (let i = 5; i < text.length; i += 5) {
      a.emit("race:progress", { typed: text.slice(0, i), keystrokes: i + 1, errors: 1 });
      await sleep(300);
    }
    a.emit("race:progress", { typed: text, keystrokes: text.length + 1, errors: 1 });

    const end = await once(a, "race:end");
    assert(end.standings.length === 2, "standings cover the room");
    const [first, second] = end.standings;
    assert(first.name === "Alice" && first.finished && !first.cheated, "honest finisher wins");
    assert(first.wpm > 50 && first.wpm <= 260, `winner WPM is sane (${first.wpm})`);
    assert(first.accuracy < 100, "accuracy reflects the errors made");
    assert(second.left === true, "disconnected racer is marked as left");
    assert(end.allTime.some((r) => r.name === "Alice"), "winner persisted to the all-time leaderboard");

    // --- 6. Leaderboard fetch over a fresh socket ---
    const c = io(URL);
    await once(c, "connect");
    const board = await new Promise((res) => c.emit("leaderboard:get", res));
    assert(board.length >= 1 && board[0].name === "Alice", "leaderboard:get returns the winner on top");
    c.disconnect(); a.disconnect();

    console.log("\nALL TESTS PASSED");
  } finally {
    server.kill();
    try { fs.unlinkSync(TEST_LB); } catch {}
  }
})().catch((e) => { console.error("\nTEST FAILED:", e.message); process.exit(1); });
