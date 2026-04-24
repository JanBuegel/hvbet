require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// --- Auth middleware for admin routes ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error('FEHLER: ADMIN_PASSWORD ist nicht in .env gesetzt!');
  process.exit(1);
}

function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (auth === `Bearer ${ADMIN_PASSWORD}`) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Serve admin.html only with valid password via query param (redirects to page)
app.get('/admin.html', (req, res, next) => {
  if (req.query.pw === ADMIN_PASSWORD) return next();
  res.status(401).send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>body{background:#0d1117;color:#c9d1d9;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px;}
    input{background:#21262d;border:1px solid #30363d;color:#c9d1d9;padding:10px;border-radius:6px;font-family:monospace;font-size:1rem;}
    button{background:rgba(57,211,83,.15);border:1px solid #39d353;color:#39d353;padding:10px 20px;border-radius:6px;font-family:monospace;cursor:pointer;}
    </style></head><body>
    <div style="color:#39d353;font-size:1.2rem;">🏛 HV-WETTE ADMIN</div>
    <input type="password" id="pw" placeholder="Passwort" onkeydown="if(event.key==='Enter')login()">
    <button onclick="login()">Einloggen</button>
    <script>function login(){window.location='/admin.html?pw='+document.getElementById('pw').value}</script>
    </body></html>`);
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Persistence ---
const DATA_FILE = path.join(__dirname, 'data.json');

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const saved = JSON.parse(raw);
    return {
      participants: saved.participants || [],
      betAmount: saved.betAmount || 10,
      actualEndTime: saved.actualEndTime || null,
      winners: saved.winners || [],
    };
  } catch {
    return { participants: [], betAmount: 10, actualEndTime: null, winners: [] };
  }
}

function saveState() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

// --- State ---
let state = loadState();
saveState(); // ensure data.json exists on first start
let nextId = state.participants.length > 0
  ? Math.max(...state.participants.map(p => p.id)) + 1
  : 1;
const sseClients = [];

let leaderChangeTimer = null;

const ts = () => new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function broadcast(reason = 'data') {
  const payload = buildPayload();
  const data = JSON.stringify(payload);
  let sent = 0;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write(`data: ${data}\n\n`);
      sent++;
    } catch {
      sseClients.splice(i, 1);
    }
  }
  const leaderNames = payload.leaders.length
    ? payload.leaders.map(l => l.name).join(' & ') + ` (${payload.leaders[0].guessTime})`
    : '—';
  console.log(`[${ts()}] broadcast(${reason}) → ${sent} client(s) | Leader: ${leaderNames}${payload.actualEndTime ? ` | HV-Ende: ${payload.actualEndTime}` : ''}`);
  scheduleLeaderChange(payload);
}

// Keep SSE connections alive — many proxies drop idle connections after ~60s
setInterval(() => {
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write(': ping\n\n');
    } catch {
      sseClients.splice(i, 1);
    }
  }
}, 25000);

function scheduleLeaderChange(payload) {
  if (leaderChangeTimer) { clearTimeout(leaderChangeTimer); leaderChangeTimer = null; }
  if (!payload.leaderWinsUntilMs || payload.actualEndTime) return;

  const now = new Date();
  const todayStartMs = new Date(now).setHours(0, 0, 0, 0);
  const fireAt = todayStartMs + payload.leaderWinsUntilMs;
  const msUntil = fireAt - now;
  if (msUntil <= 0) return;

  console.log(`[${ts()}] schedule → Führungswechsel in ${Math.round(msUntil / 1000)}s (${payload.leaderWinsUntil} Uhr)`);
  leaderChangeTimer = setTimeout(() => {
    broadcast('timer');
  }, msUntil);
}

function buildPayload() {
  const now = new Date();
  const sorted = [...state.participants].sort((a, b) => a.guessTime.localeCompare(b.guessTime));

  let leader = null;
  let leaders = [];
  let nextLeader = null;
  let winners = state.winners;

  if (state.actualEndTime) {
    // Meeting ended — compute winners
    const endMs = timeToMs(state.actualEndTime);
    const withDiff = state.participants.map(p => ({
      ...p,
      diffMs: Math.abs(timeToMs(p.guessTime) - endMs),
    }));
    const minDiff = Math.min(...withDiff.map(p => p.diffMs));
    winners = withDiff.filter(p => p.diffMs === minDiff);
  } else {
    // Meeting running — leader is person closest to current time (would win if meeting ended now)
    const nowMs = now.getHours() * 3600000 + now.getMinutes() * 60000 + now.getSeconds() * 1000;
    const withDiff = sorted.map(p => ({ ...p, diffMs: Math.abs(timeToMs(p.guessTime) - nowMs) }));
    // On equal diff, prefer later guess time so the new leader takes over exactly at the midpoint
    withDiff.sort((a, b) => a.diffMs - b.diffMs || b.guessTime.localeCompare(a.guessTime));

    if (withDiff.length > 0) {
      const leaderGuessTime = withDiff[0].guessTime;
      const minDiff = withDiff[0].diffMs;
      // Only group actual same-time duplicates, not people who are merely equidistant from now
      const topGroup = withDiff.filter(p => p.diffMs === minDiff && p.guessTime === leaderGuessTime);
      leader = topGroup[0];
      leaders = topGroup;
      nextLeader = sorted.find(p => p.guessTime > leader.guessTime) || null;
    }
  }

  // Midpoint between leader group and runner-up — leaders win if meeting ends before this time
  let leaderWinsUntil = null;
  let leaderWinsUntilMs = null;
  if (leader && nextLeader) {
    leaderWinsUntilMs = Math.round((timeToMs(leader.guessTime) + timeToMs(nextLeader.guessTime)) / 2);
    const h = Math.floor(leaderWinsUntilMs / 3600000);
    const m = Math.floor((leaderWinsUntilMs % 3600000) / 60000);
    const s = Math.floor((leaderWinsUntilMs % 60000) / 1000);
    leaderWinsUntil = s > 0
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  const pot = state.participants.length * state.betAmount;

  return {
    participants: sorted,
    betAmount: state.betAmount,
    pot,
    leader,
    leaders,
    nextLeader,
    leaderWinsUntil,
    leaderWinsUntilMs,
    actualEndTime: state.actualEndTime,
    winners,
    serverTime: now.toISOString(),
  };
}

function timeToMs(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 3600000 + m * 60000;
}

// --- SSE ---
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (req.socket) req.socket.setNoDelay(true);
  res.flushHeaders();

  sseClients.push(res);
  console.log(`[${ts()}] SSE connect    → ${sseClients.length} client(s)`);
  res.write(`data: ${JSON.stringify(buildPayload())}\n\n`);

  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
    console.log(`[${ts()}] SSE disconnect → ${sseClients.length} client(s)`);
  });
});

// --- API ---
app.get('/api/state', (req, res) => res.json(buildPayload()));

app.post('/api/participants', requireAuth, (req, res) => {
  const { name, guessTime } = req.body;
  if (!name || !guessTime) return res.status(400).json({ error: 'name and guessTime required' });
  if (!/^\d{2}:\d{2}$/.test(guessTime)) return res.status(400).json({ error: 'guessTime must be HH:MM' });

  const participant = { id: nextId++, name: name.trim(), guessTime };
  state.participants.push(participant);
  saveState();
  broadcast(`add:${participant.name}`);
  res.json(participant);
});

app.delete('/api/participants/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id);
  const idx = state.participants.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const removed = state.participants.splice(idx, 1)[0];
  saveState();
  broadcast(`remove:${removed.name}`);
  res.json({ ok: true });
});

app.post('/api/settings', requireAuth, (req, res) => {
  const { betAmount } = req.body;
  if (betAmount !== undefined) state.betAmount = Number(betAmount);
  saveState();
  broadcast('settings');
  res.json({ ok: true });
});

app.post('/api/end', requireAuth, (req, res) => {
  const { endTime } = req.body;
  if (!endTime || !/^\d{2}:\d{2}$/.test(endTime)) {
    return res.status(400).json({ error: 'endTime must be HH:MM' });
  }
  state.actualEndTime = endTime;
  saveState();
  broadcast(`hv-ende:${endTime}`);
  res.json({ ok: true });
});

app.post('/api/reset', requireAuth, (req, res) => {
  state.actualEndTime = null;
  state.winners = [];
  saveState();
  broadcast('reset');
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HV Wette läuft auf http://localhost:${PORT}`));
