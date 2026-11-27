'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { MarketError } = require('./src/market');
const { Room } = require('./src/room');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const CHART_LIB = path.join(__dirname, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js');

// ---------- 정적 파일 ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveFile(res, file, ext, cache) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(buf);
  });
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.end('ok'); return; }
  if (url.pathname === '/vendor/lightweight-charts.js') return serveFile(res, CHART_LIB, '.js', 'public, max-age=86400');
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  if (url.pathname === '/') file = path.join(PUBLIC, 'index.html');
  serveFile(res, file, path.extname(file), 'no-cache');
});

// ---------- 방 ----------
const rooms = new Map();
const clients = new Set(); // { ws, room, pid }

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const io = {
  sendTo(pid, msg) { for (const c of clients) if (c.pid === pid) send(c.ws, msg); },
  broadcast(room, msg) { const s = JSON.stringify(msg); for (const c of clients) if (c.room === room && c.ws.readyState === 1) c.ws.send(s); },
};

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (rooms.has(code));
  return code;
}

const roomList = () => [...rooms.values()].map((r) => r.summary()).sort((a, b) => (a.phase === 'lobby' ? -1 : 1) - (b.phase === 'lobby' ? -1 : 1));
function pushRoomList() { const msg = { t: 'rooms', rooms: roomList() }; for (const c of clients) if (!c.room) send(c.ws, msg); }

function enter(c, room, p) {
  c.room = room; c.pid = p.id;
  room.setOnline(p.id, true);
  send(c.ws, { t: 'joined', code: room.code, token: p.token, you: p.id, name: p.name });
  for (const m of room.snapshotFor(p.id)) send(c.ws, m);
  io.broadcast(room, room.state());
  pushRoomList();
}

function leaveRoom(c) {
  const room = c.room;
  if (!room) return;
  const pid = c.pid;
  c.room = null; c.pid = null;
  if (![...clients].some((x) => x.pid === pid)) {
    room.setOnline(pid, false);
    if (room.phase === 'lobby') room.leave(pid);
  }
  if (room.players.size === 0) rooms.delete(room.code);
  else io.broadcast(room, room.state());
  pushRoomList();
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws) => {
  const c = { ws, room: null, pid: null, tokens: 20, lastRefill: Date.now() };
  clients.add(c);
  send(ws, { t: 'rooms', rooms: roomList() });

  ws.on('message', (raw) => {
    const now = Date.now();
    c.tokens = Math.min(20, c.tokens + ((now - c.lastRefill) / 1000) * 10); c.lastRefill = now;
    if (c.tokens < 1) { send(ws, { t: 'error', msg: '요청이 너무 많습니다.' }); return; }
    c.tokens--;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try { handle(c, m); } catch (e) {
      if (e instanceof MarketError) send(ws, { t: 'error', msg: e.message, req: m.req, ctx: m.t });
      else { console.error(e); send(ws, { t: 'error', msg: '서버 오류', req: m.req }); }
    }
  });
  ws.on('close', () => { clients.delete(c); leaveRoom(c); });
  ws.on('error', () => {});
});

function handle(c, m) {
  switch (m.t) {
    case 'rooms': send(c.ws, { t: 'rooms', rooms: roomList() }); return;
    case 'create': {
      if (c.room) leaveRoom(c);
      const room = new Room(newCode(), io);
      rooms.set(room.code, room);
      try { enter(c, room, room.join(m.name)); } catch (e) { rooms.delete(room.code); throw e; }
      return;
    }
    case 'join': {
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) throw new MarketError('방을 찾을 수 없습니다.');
      const p = room.join(m.name);
      if (c.room) leaveRoom(c);
      enter(c, room, p);
      return;
    }
    case 'rejoin': {
      const room = rooms.get(String(m.code || '').toUpperCase());
      const p = room && room.byToken(m.token);
      if (!p) { send(c.ws, { t: 'rejoinFailed' }); return; }
      enter(c, room, p);
      return;
    }
  }

  const room = c.room;
  if (!room) throw new MarketError('방에 먼저 들어가세요.');
  const pid = c.pid;
  const mp = room.market && room.market.players.get(pid);
  switch (m.t) {
    case 'leave': leaveRoom(c); send(c.ws, { t: 'left' }); send(c.ws, { t: 'rooms', rooms: roomList() }); break;
    case 'settings': room.configure(pid, m); io.broadcast(room, room.state()); break;
    case 'start': room.start(pid); io.broadcast(room, room.state()); pushRoomList(); break;
    case 'lobby': room.backToLobby(pid); io.broadcast(room, room.state()); pushRoomList(); break;
    case 'chat': {
      const text = String(m.text || '').trim().slice(0, 200);
      if (text) room.addChat({ name: room.players.get(pid).name, text, ts: Date.now() });
      break;
    }
    case 'history': {
      if (!room.market) return;
      const tf = m.tf === 5 ? 5 : 60;
      send(c.ws, { t: 'history', sym: m.sym, tf, candles: room.market.history(m.sym, tf) });
      break;
    }
    case 'order': {
      if (!mp) throw new MarketError('게임 참가자가 아닙니다.');
      const o = room.market.placeOrder(mp, m);
      send(c.ws, { t: 'ack', req: m.req, order: o });
      break;
    }
    case 'cancel': if (mp) room.market.cancelOrder(mp, m.id); break;
    case 'cancelAll': if (mp) room.market.cancelAll(mp, m.sym); break;
    case 'pick': room.pick(pid, m.idx); io.broadcast(room, room.state()); break;
    case 'reroll': room.reroll(pid); break;
    case 'mgscore': room.submitScore(pid, m.score); io.broadcast(room, room.state()); break;
  }
}

// ---------- 루프 ----------
setInterval(() => {
  for (const room of rooms.values()) {
    const before = room.phase;
    room.tick();
    if (room.phase !== before) { io.broadcast(room, room.state()); pushRoomList(); }
  }
}, 250);

setInterval(() => { for (const room of rooms.values()) if (room.market) room.market.step(); }, 1000);

let n = 0;
setInterval(() => {
  n++;
  for (const room of rooms.values()) {
    const m = room.market;
    if (!m) continue;
    const trades = m.pendingTrades.splice(0);
    if (!m.paused || trades.length || n % 4 === 0) io.broadcast(room, { t: 'md', md: m.marketData(), trades: trades.slice(-60) });
    for (const b of m.broadcasts.splice(0)) io.broadcast(room, b);
    for (const ev of m.events.splice(0)) io.sendTo(ev.playerId, { t: 'event', ...ev.msg });
    for (const pid of m.dirty) { const p = m.players.get(pid); if (p) io.sendTo(pid, { t: 'account', account: m.account(p) }); }
    m.dirty.clear();
    if (n % 2 === 0) io.broadcast(room, room.state());
  }
}, 500);

// 아무도 없는 방 정리
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.onlineCount() === 0) {
      room.idle = (room.idle || 0) + 1;
      if (room.idle >= 10) rooms.delete(code); // 10분
    } else room.idle = 0;
  }
}, 60_000);

server.listen(PORT, () => console.log(`주식 로그라이크 서버 실행 중: http://localhost:${PORT}`));
