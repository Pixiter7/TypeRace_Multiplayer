# ⚡ TypeRace

A real-time multiplayer typing-race game. Racers are matched into lobbies,
type the same paragraph, and watch each other's progress live — with
server-authoritative scoring and anti-cheat validation.

## Stack
- **Backend:** Node.js, Express, Socket.IO
- **Frontend:** vanilla HTML/CSS/JS (no build step)

## Features
- **Matchmaking** — join a queue; a room starts when 2+ racers are waiting (or after 12s with whoever is there)
- **Real-time sync** — every keystroke is broadcast; live progress bars, WPM and standings for the whole room
- **Server-side scoring** — WPM and accuracy are computed on the server from validated input
- **Anti-cheat validation** — the server rejects any input that isn't an exact prefix of the race text, caps burst size, and rejects impossible WPM (>260)
- **Live + all-time leaderboards** — room standings at race end; top-10 all-time board persisted to `leaderboard.json`
- **Disconnect handling** — leavers are marked and rooms close out cleanly

## Run it
```bash
npm install
node server.js
```
Open http://localhost:3000 in two (or more) browser windows, enter names, hit **Find Race**.

## Test it
```bash
npm test
```
Spins up the real server and simulates two racers plus a cheater end-to-end
(matchmaking, prefix validation, impossible-speed rejection, standings, leaderboard).
