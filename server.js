'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'rps-arena.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  rating INTEGER NOT NULL DEFAULT 1000,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  matches INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code TEXT NOT NULL,
  player1_id TEXT NOT NULL,
  player2_id TEXT NOT NULL,
  player1_choice TEXT NOT NULL,
  player2_choice TEXT NOT NULL,
  winner_id TEXT,
  result TEXT NOT NULL,
  rating_change1 INTEGER NOT NULL,
  rating_change2 INTEGER NOT NULL,
  played_at TEXT NOT NULL,
  FOREIGN KEY(player1_id) REFERENCES players(id),
  FOREIGN KEY(player2_id) REFERENCES players(id)
);
CREATE INDEX IF NOT EXISTS idx_players_rating ON players(rating DESC, wins DESC);
CREATE INDEX IF NOT EXISTS idx_matches_played_at ON matches(played_at DESC);
`);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false }, pingInterval: 25000, pingTimeout: 20000 });

const getPlayerByToken = db.prepare('SELECT id, name, rating, wins, losses, draws, matches FROM players WHERE token_hash = ?');
const getPlayerById = db.prepare('SELECT id, name, rating, wins, losses, draws, matches FROM players WHERE id = ?');
const updateSeen = db.prepare('UPDATE players SET last_seen = ? WHERE id = ?');
const liveRooms = new Map();
const socketsByPlayer = new Map();
const now = () => new Date().toISOString();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const publicPlayer = p => ({ id: p.id, name: p.name, rating: p.rating, wins: p.wins, losses: p.losses, draws: p.draws, matches: p.matches });

function tokenFrom(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}
function authHttp(req, res, next) {
  const token = tokenFrom(req);
  if (!token || token.length < 32) return res.status(401).json({ error: 'برای ادامه وارد حساب بازیکن شو.' });
  const player = getPlayerByToken.get(sha(token));
  if (!player) return res.status(401).json({ error: 'نشست معتبر نیست؛ دوباره نامت را ثبت کن.' });
  req.player = player;
  updateSeen.run(now(), player.id);
  next();
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'RPS Arena Online', time: now(), rooms: liveRooms.size }));
app.post('/api/register', (req, res) => {
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 18 || !/^[\p{L}\p{N}_ -]+$/u.test(name)) {
    return res.status(400).json({ error: 'نام باید ۲ تا ۱۸ نویسه و فقط شامل حروف، عدد، فاصله، خط تیره یا زیرخط باشد.' });
  }
  const normalized = name.toLocaleLowerCase('en-US');
  const exists = db.prepare('SELECT id FROM players WHERE normalized_name = ?').get(normalized);
  if (exists) return res.status(409).json({ error: 'این نام قبلاً ثبت شده است؛ یک نام دیگر انتخاب کن.' });
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const stamp = now();
  try {
    db.prepare('INSERT INTO players (id,name,normalized_name,token_hash,created_at,last_seen) VALUES (?,?,?,?,?,?)')
      .run(id, name, normalized, sha(token), stamp, stamp);
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'این نام قبلاً ثبت شده است.' });
    throw err;
  }
  const player = getPlayerById.get(id);
  res.status(201).json({ token, player: publicPlayer(player) });
});
app.get('/api/me', authHttp, (req, res) => res.json({ player: publicPlayer(req.player) }));
app.get('/api/leaderboard', (_req, res) => {
  const rows = db.prepare(`SELECT id,name,rating,wins,losses,draws,matches,
    CASE WHEN matches=0 THEN 0 ELSE ROUND(wins*100.0/matches,1) END AS winRate
    FROM players ORDER BY rating DESC, wins DESC, matches ASC, created_at ASC LIMIT 100`).all();
  res.json({ players: rows.map((p, i) => ({ rank: i + 1, ...p })) });
});
app.get('/api/recent-matches', authHttp, (req, res) => {
  const rows = db.prepare(`SELECT m.id,m.room_code,m.result,m.played_at,m.rating_change1,m.rating_change2,
    p1.name AS player1,p2.name AS player2,m.player1_id,m.winner_id
    FROM matches m JOIN players p1 ON p1.id=m.player1_id JOIN players p2 ON p2.id=m.player2_id
    WHERE m.player1_id=? OR m.player2_id=? ORDER BY m.id DESC LIMIT 12`).all(req.player.id, req.player.id);
  res.json({ matches: rows.map(m => ({ ...m, myRatingChange: m.player1_id === req.player.id ? m.rating_change1 : m.rating_change2, outcome: !m.winner_id ? 'draw' : m.winner_id === req.player.id ? 'win' : 'loss' })) });
});

function randomCode() {
  let code;
  do { code = String(100000 + crypto.randomInt(900000)); } while (liveRooms.has(code));
  return code;
}
function playerSockets(playerId) { return socketsByPlayer.get(playerId); }
function roomSnapshot(room) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(id => {
      const p = getPlayerById.get(id);
      return p ? { ...publicPlayer(p), connected: Boolean(playerSockets(id)?.size) } : null;
    }),
    movesSubmitted: room.moves.size,
    round: room.round
  };
}
function emitRoom(room, event = 'room:update') {
  const payload = roomSnapshot(room);
  room.players.forEach(id => io.to(`player:${id}`).emit(event, payload));
}
function roomError(socket, message) { socket.emit('room:error', { message }); }
function broadcastPresence() { io.emit('presence:update', { onlinePlayers: socketsByPlayer.size, rooms: liveRooms.size }); }
function attachPlayerToRoom(socket, room) {
  socket.join(`room:${room.code}`);
  socket.join(`player:${socket.player.id}`);
  socket.data.roomCode = room.code;
  if (!room.players.includes(socket.player.id)) room.players.push(socket.player.id);
  emitRoom(room);
}
function startRound(room) {
  room.status = 'playing';
  room.moves.clear();
  room.rematchReady.clear();
  room.round += 1;
  emitRoom(room, 'match:started');
}
function outcome(a, b) {
  if (a === b) return 'draw';
  if ((a === 'rock' && b === 'scissors') || (a === 'paper' && b === 'rock') || (a === 'scissors' && b === 'paper')) return 'p1';
  return 'p2';
}
function calculateElo(r1, r2, result) {
  const expected1 = 1 / (1 + Math.pow(10, (r2 - r1) / 400));
  const score1 = result === 'p1' ? 1 : result === 'p2' ? 0 : 0.5;
  const change1 = Math.round(32 * (score1 - expected1));
  return [change1, -change1];
}
const saveMatch = db.transaction((room, result, changes) => {
  const [p1, p2] = room.players;
  const winnerId = result === 'p1' ? p1 : result === 'p2' ? p2 : null;
  const stamp = now();
  for (let i = 0; i < 2; i++) {
    const id = room.players[i];
    const win = (i === 0 && result === 'p1') || (i === 1 && result === 'p2');
    const loss = (i === 0 && result === 'p2') || (i === 1 && result === 'p1');
    db.prepare(`UPDATE players SET rating=MAX(100,rating+?), wins=wins+?, losses=losses+?, draws=draws+?, matches=matches+1, last_seen=? WHERE id=?`)
      .run(changes[i], win ? 1 : 0, loss ? 1 : 0, result === 'draw' ? 1 : 0, stamp, id);
  }
  db.prepare(`INSERT INTO matches (room_code,player1_id,player2_id,player1_choice,player2_choice,winner_id,result,rating_change1,rating_change2,played_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(room.code, p1, p2, room.moves.get(p1), room.moves.get(p2), winnerId, result, changes[0], changes[1], stamp);
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token !== 'string' || token.length < 32) return next(new Error('برای اتصال ابتدا نام بازیکن را ثبت کن.'));
  const player = getPlayerByToken.get(sha(token));
  if (!player) return next(new Error('نشست معتبر نیست. صفحه را تازه‌سازی کن.'));
  socket.player = player;
  next();
});

io.on('connection', socket => {
  const id = socket.player.id;
  if (!socketsByPlayer.has(id)) socketsByPlayer.set(id, new Set());
  socketsByPlayer.get(id).add(socket.id);
  updateSeen.run(now(), id);
  // Rejoin any active room after a temporary network reconnect.
  for (const room of liveRooms.values()) {
    if (room.players.includes(id)) {
      socket.join(`room:${room.code}`);
      socket.join(`player:${id}`);
      socket.data.roomCode = room.code;
      emitRoom(room);
    }
  }
  socket.emit('online:welcome', { player: publicPlayer(getPlayerById.get(id)), onlinePlayers: socketsByPlayer.size, rooms: liveRooms.size });
  broadcastPresence();

  socket.on('room:create', (_data, ack = () => {}) => {
    const existing = [...liveRooms.values()].find(r => r.players.includes(id));
    if (existing) return ack({ ok: false, error: 'ابتدا از اتاق فعلی خارج شو.' });
    const code = randomCode();
    const room = { code, players: [id], status: 'waiting', moves: new Map(), rematchReady: new Set(), round: 0, createdAt: Date.now() };
    liveRooms.set(code, room);
    attachPlayerToRoom(socket, room);
    ack({ ok: true, code, room: roomSnapshot(room) });
  });
  socket.on('room:join', (data, ack = () => {}) => {
    const code = String(data?.code || '').trim();
    const room = liveRooms.get(code);
    if (!/^\d{6}$/.test(code)) return ack({ ok: false, error: 'کد اتاق باید ۶ رقم باشد.' });
    if (!room) return ack({ ok: false, error: 'اتاق پیدا نشد؛ کد را بررسی کن.' });
    if (room.players.includes(id)) { attachPlayerToRoom(socket, room); return ack({ ok: true, code, room: roomSnapshot(room) }); }
    if (room.players.length >= 2 || room.status !== 'waiting') return ack({ ok: false, error: 'این اتاق ظرفیت ندارد یا مسابقه شروع شده است.' });
    const existing = [...liveRooms.values()].find(r => r.players.includes(id));
    if (existing) return ack({ ok: false, error: 'ابتدا از اتاق فعلی خارج شو.' });
    attachPlayerToRoom(socket, room);
    ack({ ok: true, code, room: roomSnapshot(room) });
    if (room.players.length === 2) startRound(room);
  });
  socket.on('match:move', (data, ack = () => {}) => {
    const room = liveRooms.get(socket.data.roomCode);
    const choice = data?.choice;
    if (!room || room.status !== 'playing' || !room.players.includes(id)) return ack({ ok: false, error: 'مسابقه فعال نیست.' });
    if (!['rock', 'paper', 'scissors'].includes(choice)) return ack({ ok: false, error: 'حرکت نامعتبر است.' });
    if (room.moves.has(id)) return ack({ ok: false, error: 'حرکتت ثبت شده؛ منتظر حریف بمان.' });
    room.moves.set(id, choice);
    ack({ ok: true });
    emitRoom(room);
    if (room.moves.size === 2) {
      const [p1, p2] = room.players;
      const result = outcome(room.moves.get(p1), room.moves.get(p2));
      const changes = calculateElo(getPlayerById.get(p1).rating, getPlayerById.get(p2).rating, result);
      saveMatch(room, result, changes);
      room.status = 'finished';
      room.lastResult = { result, winnerId: result === 'draw' ? null : result === 'p1' ? p1 : p2,
        choices: { [p1]: room.moves.get(p1), [p2]: room.moves.get(p2) },
        ratingChanges: { [p1]: changes[0], [p2]: changes[1] },
        players: room.players.map(pid => publicPlayer(getPlayerById.get(pid))) };
      emitRoom(room);
      room.players.forEach(pid => io.to(`player:${pid}`).emit('match:result', room.lastResult));
    }
  });
  socket.on('match:rematch', (_data, ack = () => {}) => {
    const room = liveRooms.get(socket.data.roomCode);
    if (!room || room.status !== 'finished' || !room.players.includes(id)) return ack({ ok: false, error: 'مسابقه برای بازی مجدد آماده نیست.' });
    room.rematchReady.add(id);
    ack({ ok: true });
    emitRoom(room);
    if (room.rematchReady.size === 2) startRound(room);
    else room.players.forEach(pid => io.to(`player:${pid}`).emit('match:rematch-waiting', { name: getPlayerById.get(id)?.name }));
  });
  socket.on('room:leave', (_data, ack = () => {}) => {
    const room = liveRooms.get(socket.data.roomCode);
    if (room) {
      room.players.forEach(pid => io.to(`player:${pid}`).emit('room:closed', { message: 'اتاق بسته شد.' }));
      liveRooms.delete(room.code);
    }
    socket.data.roomCode = null;
    ack({ ok: true });
  });
  socket.on('disconnect', () => {
    const set = socketsByPlayer.get(id);
    if (set) { set.delete(socket.id); if (!set.size) socketsByPlayer.delete(id); }
    broadcastPresence();
    for (const room of liveRooms.values()) if (room.players.includes(id)) {
      emitRoom(room, 'room:player-disconnected');
    }
  });
});

// Clean up abandoned rooms after 30 minutes. Database records are never removed here.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [code, room] of liveRooms) if (room.createdAt < cutoff && room.players.every(id => !playerSockets(id)?.size)) liveRooms.delete(code);
}, 60 * 1000).unref();

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => console.log(`RPS Arena Online listening on ${PORT}`));
