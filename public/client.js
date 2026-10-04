// TypeRace client — renders the race, captures keystrokes, and streams
// progress to the server. The server is authoritative: it validates every
// update and broadcasts the synchronized standings for all racers.

const socket = io();
const $ = (id) => document.getElementById(id);

let myName = "";
let raceText = "";
let typed = "";
let keystrokes = 0;
let errors = 0;
let racing = false;
let finished = false;
let players = [];

function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(id).classList.add("active");
}

function board(el, rows, highlight) {
  el.innerHTML = "";
  if (!rows.length) el.innerHTML = "<li>No races yet — be the first!</li>";
  rows.forEach((r, i) => {
    const li = document.createElement("li");
    if (r.name === highlight) li.classList.add("me");
    li.innerHTML = `<span>#${i + 1} ${escapeHtml(r.name)}</span><span>${r.wpm} WPM · ${r.accuracy}%</span>`;
    el.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Lobby ----------
$("findRaceBtn").onclick = () => {
  myName = $("nameInput").value.trim() || "Racer";
  socket.emit("queue:join", { name: myName });
  show("screen-waiting");
};
$("nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("findRaceBtn").click(); });
$("cancelBtn").onclick = () => { socket.emit("queue:leave"); show("screen-lobby"); };
$("againBtn").onclick = () => { resetRace(); socket.emit("queue:join", { name: myName }); show("screen-waiting"); };
socket.on("queue:count", ({ count }) => { $("queueCount").textContent = count; });
socket.emit("leaderboard:get", (rows) => board($("lobbyBoard"), rows));

// ---------- Race lifecycle ----------
socket.on("race:countdown", ({ players: ps, countdownMs }) => {
  players = ps;
  show("screen-race");
  $("raceBody").classList.add("hidden");
  const cd = $("countdown");
  cd.classList.remove("hidden");
  let n = Math.ceil(countdownMs / 1000);
  cd.textContent = n;
  const t = setInterval(() => {
    n -= 1;
    if (n <= 0) { clearInterval(t); cd.textContent = "GO!"; }
    else cd.textContent = n;
  }, 1000);
});

socket.on("race:start", ({ text, players: ps }) => {
  raceText = text; players = ps;
  resetRace();
  $("countdown").classList.add("hidden");
  $("raceBody").classList.remove("hidden");
  renderParagraph();
  renderTracks();
  racing = true;
  $("paragraph").focus();
});

socket.on("race:update", ({ players: ps }) => {
  players = ps;
  renderTracks();
});

socket.on("race:rejected", ({ reason }) => {
  console.warn("Server rejected update:", reason);
  // Resync: drop back to the last accepted prefix is handled by keeping
  // local `typed` authoritative only after server acceptance is implicit.
  // Simplest robust recovery: re-send current state.
  sendProgress();
});

socket.on("race:end", ({ standings, allTime }) => {
  racing = false;
  const ol = $("standings");
  ol.innerHTML = "";
  standings.forEach((s, i) => {
    const li = document.createElement("li");
    if (s.name === myName) li.classList.add("me");
    const detail = s.finished ? `${s.wpm} WPM · ${s.accuracy}% · ${(s.finishMs / 1000).toFixed(1)}s`
      : s.left ? "left the race" : `${Math.round((s.progress || 0) * 100)}% — did not finish`;
    li.innerHTML = `<span>#${i + 1} ${escapeHtml(s.name)}</span><span>${detail}</span>`;
    ol.appendChild(li);
  });
  board($("finalBoard"), allTime, myName);
  show("screen-results");
});

// ---------- Typing ----------
function resetRace() {
  typed = ""; keystrokes = 0; errors = 0;
  racing = false; finished = false;
  $("myWpm").textContent = "0";
  $("myAcc").textContent = "100";
}

function renderParagraph() {
  const p = $("paragraph");
  p.innerHTML = "";
  [...raceText].forEach((ch, i) => {
    const sp = document.createElement("span");
    sp.textContent = ch;
    if (i < typed.length) sp.className = typed[i] === raceText[i] ? "ok" : "err";
    else if (i === typed.length) sp.className = "cur";
    p.appendChild(sp);
  });
}

function renderTracks() {
  const t = $("tracks");
  t.innerHTML = "";
  players.forEach((pl) => {
    const div = document.createElement("div");
    div.className = "track" + (pl.name === myName ? " me" : "") + (pl.finished ? " done" : "");
    const pct = Math.round((pl.progress || 0) * 100);
    div.innerHTML = `<div class="label"><span>${escapeHtml(pl.name)}${pl.finished ? " 🏁" : ""}${pl.left ? " (left)" : ""}</span><span>${pl.wpm} WPM</span></div>
      <div class="bar"><div class="fill" style="width:${pct}%"></div></div>`;
    t.appendChild(div);
  });
}

function sendProgress() {
  socket.emit("race:progress", { typed, keystrokes, errors });
  const mins = (Date.now() - raceStartAt) / 60000;
  if (mins > 0.01) $("myWpm").textContent = Math.round((typed.length / 5) / mins);
  $("myAcc").textContent = keystrokes ? Math.round(((keystrokes - errors) / keystrokes) * 100) : 100;
}

let raceStartAt = 0;
document.addEventListener("keydown", (e) => {
  if (!racing || finished) return;
  if (document.activeElement !== $("paragraph")) return;
  if (e.key === "Backspace") {
    e.preventDefault();
    if (typed.length > 0) { typed = typed.slice(0, -1); keystrokes++; renderParagraph(); sendProgress(); }
    return;
  }
  if (e.key.length !== 1) return; // ignore Shift, Ctrl, etc.
  if (e.key === " " ) e.preventDefault();
  if (typed.length === 0) raceStartAt = Date.now();
  keystrokes++;
  const expected = raceText[typed.length];
  if (e.key !== expected) errors++;
  typed += e.key;
  renderParagraph();
  sendProgress();
  if (typed === raceText) finished = true;
});
