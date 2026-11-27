'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Market, MarketError } = require('./src/market');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC = path.join(__dirname, 'public');
const CHART_LIB = path.join(__dirname, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js');

const market = new Market();
try {
  market.restore(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  console.log(`상태 복원: 플레이어 ${market.players.size}명`);
} catch (e) {
  if (e.code !== 'ENOENT') console.error('상태 복원 실패:', e.message);
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(market.serialize()));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error('저장 실패:', e.message); }
}

// ---------- 정적 파일 ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.end('ok'); return; }
  if (url.pathname === '/vendor/lightweight-charts.js') {
    return serveFile(res, CHART_LIB, '.js', 'public, max-age=86400');
  }
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  if (url.pathname === '/') file = path.join(PUBLIC, 'index.html');
  serveFile(res, file, path.extname(file), 'no-cache');
});

function serveFile(res, file, ext, cache) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(buf);
  });
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const clients = new Set(); // { ws, player, bucket, last }

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const c of clients) if (c.ws.readyState === 1) c.ws.send(s); };
const sendToPlayer = (pid, msg) => { for (const c of clients) if (c.player && c.player.id === pid) send(c.ws, msg); };
const online = () => new Set([...clients].filter((c) => c.player).map((c) => c.player.id)).size;

wss.on('connection', (ws) => {
  const c = { ws, player: null, tokens: 20, lastRefill: Date.now() };
  clients.add(c);
  send(ws, {
    t: 'hello',
    symbols: [...market.symbols.values()].map((s) => ({ code: s.code, name: s.name, sector: s.sector })),
    md: market.marketData(), news: market.news, chat: market.chat.slice(-50), lb: market.leaderboard(),
  });

  ws.on('message', (raw) => {
    // 간단한 토큰 버킷 레이트 리밋 (초당 10개)
    const now = Date.now();
    c.tokens = Math.min(20, c.tokens + ((now - c.lastRefill) / 1000) * 10); c.lastRefill = now;
    if (c.tokens < 1) { send(ws, { t: 'error', msg: '요청이 너무 많습니다.' }); return; }
    c.tokens--;

    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try {
      handle(c, m);
    } catch (e) {
      if (e instanceof MarketError) send(ws, { t: 'error', msg: e.message, req: m.req });
      else { console.error(e); send(ws, { t: 'error', msg: '서버 오류', req: m.req }); }
    }
  });
  ws.on('close', () => clients.delete(c));
  ws.on('error', () => {});
});

function handle(c, m) {
  if (m.t === 'join') {
    const p = market.join(m.name, m.token);
    c.player = p;
    send(c.ws, { t: 'joined', token: p.token, account: market.account(p) });
    return;
  }
  if (m.t === 'history') {
    const tf = m.tf === 5 ? 5 : 60;
    send(c.ws, { t: 'history', sym: m.sym, tf, candles: market.history(m.sym, tf) });
    return;
  }
  if (!c.player) throw new MarketError('먼저 접속해 주세요.');
  const p = c.player;
  switch (m.t) {
    case 'order': {
      const o = market.placeOrder(p, m);
      send(c.ws, { t: 'ack', req: m.req, order: o });
      break;
    }
    case 'cancel':
      market.cancelOrder(p, m.id);
      break;
    case 'cancelAll':
      for (const o of [...market.orders.values()]) if (o.owner === p.id && (!m.sym || o.sym === m.sym)) market._cancel(o);
      break;
    case 'reset':
      market.resetPlayer(p);
      break;
    case 'chat': {
      const text = String(m.text || '').trim().slice(0, 200);
      if (!text) return;
      const item = { name: p.name, text, ts: Date.now() };
      market.chat.push(item);
      if (market.chat.length > 100) market.chat.splice(0, market.chat.length - 100);
      broadcast({ t: 'chat', item });
      break;
    }
  }
}

// ---------- 루프 ----------
let lastNewsId = market.news[0]?.id;
setInterval(() => {
  market.step();
  if (market.news[0] && market.news[0].id !== lastNewsId) {
    lastNewsId = market.news[0].id;
    broadcast({ t: 'news', item: market.news[0] });
  }
}, 1000);

setInterval(() => {
  const trades = market.pendingTrades.splice(0);
  broadcast({ t: 'md', md: market.marketData(), trades: trades.slice(-60) });
  for (const ev of market.events.splice(0)) sendToPlayer(ev.playerId, { t: 'event', ...ev.msg });
  for (const pid of market.dirty) {
    const p = market.players.get(pid);
    if (p) sendToPlayer(pid, { t: 'account', account: market.account(p) });
  }
  market.dirty.clear();
}, 500);

setInterval(() => broadcast({ t: 'lb', lb: market.leaderboard(), online: online() }), 2000);
setInterval(save, 15000);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { save(); process.exit(0); });

server.listen(PORT, () => console.log(`주식 게임 서버 실행 중: http://localhost:${PORT}`));
