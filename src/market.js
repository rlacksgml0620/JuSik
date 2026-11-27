'use strict';
// 시장 엔진 (방마다 하나): 호가창 매칭, 계좌 정산, 카드 효과(손익 배율 등), 봇, 뉴스
const FEE = 0.00015;   // 매매 수수료 0.015%
const TAX = 0.0018;    // 매도 거래세 0.18%
const START_CASH = 10_000_000;
const MAX_QTY = 1_000_000;
const BOOK_DEPTH = 10;
const C5 = 5, C60 = 60;
const MAX_C5 = 4000, MAX_C60 = 3000;
const LIMIT = 0.3;            // 라운드(하루) 가격제한폭
const INSIDER_LEAD = 15_000;  // 내부자 정보: 뉴스 몇 ms 전에 알려주나

const SYMBOLS = [
  { code: 'GRM', name: '구름전자', price: 72000, vol: 0.0011, sector: '반도체', game: 'chip' },
  { code: 'BNN', name: '바나나모빌리티', price: 18500, vol: 0.0018, sector: '자동차', game: 'parking' },
  { code: 'DKB', name: '도깨비바이오', price: 4200, vol: 0.0030, sector: '바이오', game: 'math' },
  { code: 'DLB', name: '달빛엔터', price: 31000, vol: 0.0015, sector: '엔터', game: 'reaction' },
];

const NEWS_UP = [
  '{n}, 분기 실적 어닝 서프라이즈… 영업이익 시장 예상치 2배',
  '{n}, 글로벌 대형 고객사와 장기 공급 계약 체결',
  '{n}, 외국인 대규모 순매수 유입',
  '{n}, 신제품 공개 후 사전 주문 폭주',
  '{n}, 자사주 매입 및 소각 결정 발표',
];
const NEWS_DOWN = [
  '{n}, 핵심 임원 횡령 의혹 제기',
  '{n}, 분기 실적 쇼크… 적자 전환',
  '{n}, 대규모 유상증자 결정',
  '{n}, 주력 제품 리콜 사태',
  '{n}, 경쟁사 신제품 출시로 점유율 하락 우려',
];

function tickSize(p) {
  if (p < 2000) return 1;
  if (p < 5000) return 5;
  if (p < 20000) return 10;
  if (p < 50000) return 50;
  if (p < 200000) return 100;
  if (p < 500000) return 500;
  return 1000;
}
const floorTick = (p) => { const t = tickSize(p); return Math.max(t, Math.floor(p / t) * t); };
const ceilTick = (p) => { const t = tickSize(p); return Math.ceil(p / t) * t; };
const roundTick = (p) => { const t = tickSize(p); return Math.max(t, Math.round(p / t) * t); };
const isOnTick = (p) => p % tickSize(p) === 0;
const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const rand = (a, b) => a + Math.random() * (b - a);

class MarketError extends Error {}

function defaultMods() {
  return {
    leverage: 1,       // 손익 배율 (영구)
    lossMult: 1,       // 손실 감소 배율 (영구)
    feeFree: false,    // 수수료·세금 면제
    scalpUntil: 0,     // 단타의 신 종료 시각
    scalpSave: 0,      // 손실 무효화 확률
    scalpBonus: 0,     // 수익 보너스
    insider: 0,        // 남은 내부자 정보 횟수
    interest: 0,       // 라운드 종료 시 현금 이자율
    dividend: 0,       // 라운드 종료 시 보유주식 배당률
    luck: 0,           // 카드 등급 운
    rerolls: 0,        // 다시 뽑기권
    gameMult: 1,       // 미니게임 보상 배율
  };
}

class Market {
  constructor() {
    this.players = new Map();
    this.orders = new Map();
    this.symbols = new Map();
    this.news = [];
    this.pendingTrades = [];
    this.dirty = new Set();
    this.events = [];          // { playerId, msg }
    this.broadcasts = [];      // 방 전체 알림 { t, ... }
    this.checkCash = new Set();
    this.seq = 1;
    this.paused = true;
    this.upcoming = null;      // 다음 뉴스
    for (const s of SYMBOLS) {
      // 게임마다 시작가를 조금씩 다르게
      const price = roundTick(s.price * rand(0.75, 1.3));
      this.symbols.set(s.code, {
        code: s.code, name: s.name, sector: s.sector, game: s.game, vol: s.vol,
        fair: price, anchor: price, last: price, ref: price, open: price,
        high: price, low: price, volume: 0, value: 0,
        bids: [], asks: [], c5: [], c60: [], drifts: [],
      });
    }
    this._scheduleNews(Date.now());
  }

  // ---------- 플레이어 ----------
  addPlayer(id, name) {
    const p = { id, name, cash: START_CASH, reservedCash: 0, positions: {}, realized: 0, history: [], mods: defaultMods(), cards: [] };
    this.players.set(id, p);
    this.dirty.add(id);
    return p;
  }

  pos(p, sym) {
    return p.positions[sym] || (p.positions[sym] = { qty: 0, reserved: 0, avgCost: 0 });
  }

  // 카드 효과를 반영한 손익 (realize=true면 단타 효과까지 굴림)
  adjustPnl(p, pnl, realize) {
    const m = p.mods;
    let v = pnl * m.leverage;
    if (v < 0) v *= m.lossMult;
    if (realize && m.scalpUntil > Date.now()) {
      if (v < 0 && Math.random() < m.scalpSave) {
        this.events.push({ playerId: p.id, msg: { kind: 'buff', text: `⚡ 단타의 신! 손실 ${Math.round(-v).toLocaleString('ko-KR')}원 무효화` } });
        v = 0;
      } else if (v > 0) v *= 1 + m.scalpBonus;
    }
    return v;
  }

  equity(p) {
    let v = p.cash;
    for (const [sym, ps] of Object.entries(p.positions)) {
      if (!ps.qty) continue;
      const val = ps.qty * this.symbols.get(sym).last;
      const base = val - ps.qty * ps.avgCost;
      v += val + (this.adjustPnl(p, base, false) - base);
    }
    return Math.max(0, v);
  }

  account(p) {
    const orders = [];
    for (const o of this.orders.values()) if (o.owner === p.id) orders.push(this._pubOrder(o));
    orders.sort((a, b) => b.ts - a.ts);
    const positions = {};
    for (const [k, v] of Object.entries(p.positions)) if (v.qty > 0 || v.reserved > 0) positions[k] = v;
    return {
      id: p.id, name: p.name, cash: p.cash, reservedCash: p.reservedCash,
      positions, realized: Math.round(p.realized), orders, history: p.history.slice(0, 50),
      equity: Math.round(this.equity(p)), startCash: START_CASH, mods: p.mods, cards: p.cards,
    };
  }

  standings() {
    const rows = [];
    for (const p of this.players.values()) {
      const eq = this.equity(p);
      rows.push({ id: p.id, name: p.name, equity: Math.round(eq), ret: (eq / START_CASH - 1) * 100, leverage: p.mods.leverage, cards: p.cards.length });
    }
    rows.sort((a, b) => b.equity - a.equity);
    return rows;
  }

  // ---------- 카드/이벤트용 조작 ----------
  grantShares(p, sym, qty, price) {
    if (qty <= 0) return;
    const ps = this.pos(p, sym);
    ps.avgCost = (ps.avgCost * ps.qty + price * qty) / (ps.qty + qty);
    ps.qty += qty;
    this.dirty.add(p.id);
  }

  addCash(p, amount) {
    p.cash = Math.max(p.reservedCash, Math.round(p.cash + amount));
    this.dirty.add(p.id);
  }

  // 종목 내재가치를 secs초 동안 pct만큼 이동 (작전/루머 카드)
  push(sym, pct, secs) {
    const s = this.symbols.get(sym);
    s.drifts.push({ perSec: Math.log(1 + pct) / secs, left: secs });
  }

  // 새 라운드 = 새 거래일: 기준가 갱신
  newDay() {
    for (const s of this.symbols.values()) {
      s.ref = s.last; s.open = s.last; s.high = s.low = s.last; s.volume = 0; s.value = 0;
    }
  }

  // ---------- 주문 ----------
  placeOrder(p, { sym, side, type, price, qty }) {
    if (this.paused) throw new MarketError('지금은 거래 시간이 아닙니다.');
    const s = this.symbols.get(sym);
    if (!s) throw new MarketError('없는 종목입니다.');
    if (side !== 'buy' && side !== 'sell') throw new MarketError('잘못된 주문 방향');
    if (type !== 'limit' && type !== 'market') throw new MarketError('잘못된 주문 유형');
    qty = Number(qty);
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) throw new MarketError('수량은 1 이상의 정수여야 합니다.');

    const fee = p.mods.feeFree ? 0 : FEE;
    const o = { id: this.seq++, owner: p.id, sym, side, type, qty, filled: 0, reserved: 0, price: null, ts: Date.now(), bot: false, feeRate: fee };

    if (type === 'limit') {
      price = Number(price);
      if (!Number.isInteger(price) || price <= 0) throw new MarketError('가격이 올바르지 않습니다.');
      if (!isOnTick(price)) throw new MarketError(`호가 단위(${tickSize(price)}원)에 맞지 않는 가격입니다.`);
      if (price > s.ref * (1 + LIMIT) || price < s.ref * (1 - LIMIT)) throw new MarketError('가격제한폭(기준가 ±30%)을 벗어났습니다.');
      o.price = price;
    }

    if (side === 'buy') {
      const avail = p.cash - p.reservedCash;
      if (type === 'limit') {
        const need = Math.ceil(o.price * qty * (1 + fee));
        if (need > avail) throw new MarketError('주문 가능 금액이 부족합니다.');
        o.reserved = need; p.reservedCash += need;
      } else {
        let left = avail, can = 0;
        for (const a of s.asks) {
          if (a.owner === p.id) continue;
          const rem = a.qty - a.filled;
          const unit = a.price * (1 + fee);
          const k = Math.min(rem, Math.floor(left / unit), qty - can);
          can += k; left -= k * unit + 1;
          if (can >= qty || k < rem) break;
        }
        if (can <= 0) throw new MarketError(s.asks.length ? '주문 가능 금액이 부족합니다.' : '매도 호가가 없습니다.');
        o.qty = can;
      }
    } else {
      const ps = this.pos(p, sym);
      if (ps.qty - ps.reserved < qty) throw new MarketError('매도 가능 수량이 부족합니다.');
      ps.reserved += qty;
    }

    this.dirty.add(p.id);
    this._process(o);
    return this._pubOrder(o);
  }

  cancelOrder(p, id) {
    const o = this.orders.get(Number(id));
    if (!o || o.owner !== p.id) throw new MarketError('취소할 수 없는 주문입니다.');
    this._cancel(o);
  }

  cancelAll(p, sym) {
    for (const o of [...this.orders.values()]) if (o.owner === p.id && (!sym || o.sym === sym)) this._cancel(o);
  }

  _pubOrder(o) {
    return { id: o.id, sym: o.sym, side: o.side, type: o.type, price: o.price, qty: o.qty, filled: o.filled, ts: o.ts };
  }

  _process(o) {
    const s = this.symbols.get(o.sym);
    const opp = o.side === 'buy' ? s.asks : s.bids;
    while (o.filled < o.qty && opp.length) {
      const best = opp[0];
      if (o.type === 'limit' && (o.side === 'buy' ? best.price > o.price : best.price < o.price)) break;
      if (!o.bot && best.owner === o.owner) { this._cancel(best); continue; }
      const q = Math.min(o.qty - o.filled, best.qty - best.filled);
      if (o.side === 'buy') this._execute(o, best, best.price, q, 'buy');
      else this._execute(best, o, best.price, q, 'sell');
      if (best.filled >= best.qty) { opp.shift(); this._finish(best); }
    }
    if (o.filled < o.qty && o.type === 'limit') {
      this._insert(s, o);
      this.orders.set(o.id, o);
    } else {
      this._finish(o);
    }
    this._settleCash();
  }

  // 레버리지 손실로 현금이 예약금보다 작아지면: 매수 주문 취소, 그래도 음수면 0으로 (깡통 보호)
  _settleCash() {
    if (!this.checkCash.size) return;
    const ids = [...this.checkCash];
    this.checkCash.clear();
    for (const id of ids) {
      const p = this.players.get(id);
      if (!p || p.cash >= p.reservedCash) continue;
      for (const o of [...this.orders.values()]) if (o.owner === id && o.side === 'buy') this._cancel(o);
      if (p.cash < 0) {
        this.events.push({ playerId: id, msg: { kind: 'buff', text: '💀 레버리지 손실로 현금이 바닥났습니다! (깡통)' } });
        p.cash = 0;
      }
    }
  }

  _insert(s, o) {
    const arr = o.side === 'buy' ? s.bids : s.asks;
    const better = o.side === 'buy' ? (a, b) => a.price > b.price : (a, b) => a.price < b.price;
    let i = arr.length;
    while (i > 0 && better(o, arr[i - 1])) i--;
    arr.splice(i, 0, o);
  }

  _remove(o) {
    const s = this.symbols.get(o.sym);
    const arr = o.side === 'buy' ? s.bids : s.asks;
    const i = arr.indexOf(o);
    if (i >= 0) arr.splice(i, 1);
  }

  _cancel(o) {
    this._remove(o);
    this._finish(o, true);
  }

  _finish(o, canceled = false) {
    this.orders.delete(o.id);
    if (o.bot) return;
    const p = this.players.get(o.owner);
    if (!p) return;
    if (o.side === 'buy') { p.reservedCash -= o.reserved; o.reserved = 0; }
    else this.pos(p, o.sym).reserved -= (o.qty - o.filled);
    if (canceled && o.filled < o.qty) {
      this.events.push({ playerId: p.id, msg: { kind: 'cancel', id: o.id, sym: o.sym, side: o.side, left: o.qty - o.filled } });
    }
    this.dirty.add(p.id);
  }

  _execute(buy, sell, price, q, aggressor) {
    const s = this.symbols.get(buy.sym);
    const notional = price * q;
    buy.filled += q; sell.filled += q;
    const now = Date.now();

    if (!buy.bot) {
      const p = this.players.get(buy.owner);
      const fee = p.mods.feeFree ? 0 : Math.round(notional * FEE);
      if (buy.reserved > 0) {
        const rel = Math.min(buy.reserved, Math.ceil(buy.price * q * (1 + buy.feeRate)));
        buy.reserved -= rel; p.reservedCash -= rel;
      }
      p.cash -= notional + fee;
      const ps = this.pos(p, buy.sym);
      ps.avgCost = (ps.avgCost * ps.qty + notional + fee) / (ps.qty + q);
      ps.qty += q;
      this._record(p, { sym: buy.sym, side: 'buy', price, qty: q, fee, ts: now });
    }
    if (!sell.bot) {
      const p = this.players.get(sell.owner);
      const fee = p.mods.feeFree ? 0 : Math.round(notional * FEE) + Math.round(notional * TAX);
      const ps = this.pos(p, sell.sym);
      const base = notional - fee - ps.avgCost * q;
      const pnl = this.adjustPnl(p, base, true);
      ps.qty -= q; ps.reserved -= q;
      p.cash += notional - fee + (pnl - base);
      p.realized += pnl;
      if (ps.qty === 0) ps.avgCost = 0;
      if (p.cash < p.reservedCash) this.checkCash.add(p.id);
      this._record(p, { sym: sell.sym, side: 'sell', price, qty: q, fee, pnl: Math.round(pnl), ts: now });
    }

    s.last = price;
    s.high = Math.max(s.high, price); s.low = Math.min(s.low, price);
    s.volume += q; s.value += notional;
    s.fair += 0.35 * (price - s.fair);
    this._candle(s, price, q, now);
    this.pendingTrades.push({ sym: s.code, price, qty: q, side: aggressor, ts: now });
    if (this.pendingTrades.length > 500) this.pendingTrades.splice(0, this.pendingTrades.length - 500);
  }

  _record(p, t) {
    p.history.unshift(t);
    if (p.history.length > 100) p.history.length = 100;
    this.dirty.add(p.id);
    this.events.push({ playerId: p.id, msg: { kind: 'fill', ...t } });
  }

  _candle(s, price, q, now) {
    for (const [arr, iv, max] of [[s.c5, C5, MAX_C5], [s.c60, C60, MAX_C60]]) {
      const t = Math.floor(now / 1000 / iv) * iv;
      let c = arr[arr.length - 1];
      if (!c || c.time < t) {
        c = { time: t, open: c ? c.close : price, high: price, low: price, close: price, volume: 0 };
        c.high = Math.max(c.open, price); c.low = Math.min(c.open, price);
        arr.push(c);
        if (arr.length > max) arr.splice(0, arr.length - max);
      }
      if (price > c.high) c.high = price;
      if (price < c.low) c.low = price;
      c.close = price;
      c.volume += q;
    }
  }

  // ---------- 시뮬레이션 (거래 중 1초마다) ----------
  step() {
    if (this.paused) return;
    const now = Date.now();
    this._newsTick(now);
    for (const s of this.symbols.values()) {
      let mu = 0.000002 * Math.log(s.anchor / s.fair);
      for (const d of s.drifts) { mu += d.perSec; d.left--; }
      s.drifts = s.drifts.filter((d) => d.left > 0);
      s.fair *= Math.exp(mu + s.vol * gauss());
      s.fair = Math.min(Math.max(s.fair, s.ref * (1 - LIMIT + 0.01), 50), s.ref * (1 + LIMIT - 0.01));
      this._marketMake(s);
      this._noise(s);
      this._candle(s, s.last, 0, now);
    }
  }

  // 일시정지 동안 뉴스 시계도 멈추도록 밀어줌
  shiftClock(ms) {
    if (this.upcoming) { this.upcoming.at += ms; this.upcoming.revealAt += ms; }
  }

  _botOrder(s, side, type, price, qty) {
    this._process({ id: this.seq++, owner: 'bot', sym: s.code, side, type, price, qty, filled: 0, reserved: 0, ts: Date.now(), bot: true });
  }

  _marketMake(s) {
    for (const arr of [s.bids, s.asks]) {
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i].bot) { this.orders.delete(arr[i].id); arr.splice(i, 1); }
    }
    const t = tickSize(s.fair);
    const half = Math.max(t, s.fair * 0.0006);
    const step = Math.max(t, s.fair * 0.0008);
    const baseQty = 2_500_000 / s.fair;
    const hiLim = floorTick(s.ref * (1 + LIMIT)), loLim = ceilTick(s.ref * (1 - LIMIT));
    let lastBid = Infinity, lastAsk = 0;
    for (let i = 0; i < 12; i++) {
      let bp = floorTick(s.fair - half - i * step);
      let ap = ceilTick(s.fair + half + i * step);
      if (bp >= lastBid) bp = lastBid - tickSize(lastBid - 1);
      if (ap <= lastAsk) ap = lastAsk + tickSize(lastAsk);
      lastBid = bp; lastAsk = ap;
      const qb = Math.max(1, Math.round(baseQty * (0.5 + i * 0.35) * rand(0.4, 1.6)));
      const qa = Math.max(1, Math.round(baseQty * (0.5 + i * 0.35) * rand(0.4, 1.6)));
      if (bp >= loLim) this._botOrder(s, 'buy', 'limit', bp, qb);
      if (ap <= hiLim) this._botOrder(s, 'sell', 'limit', ap, qa);
    }
  }

  _noise(s) {
    const n = Math.random() < 0.7 ? 1 + (Math.random() < 0.3 ? 1 : 0) : 0;
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? 'buy' : 'sell';
      const qty = Math.max(1, Math.round((rand(200_000, 2_000_000) / s.last) * (Math.random() < 0.05 ? 5 : 1)));
      this._botOrder(s, side, 'market', null, qty);
    }
  }

  // ---------- 뉴스 (내부자 카드 보유자는 미리 받음) ----------
  _scheduleNews(now) {
    const syms = [...this.symbols.values()];
    const s = syms[Math.floor(Math.random() * syms.length)];
    const good = Math.random() < 0.5;
    const pool = good ? NEWS_UP : NEWS_DOWN;
    const at = now + rand(22, 40) * 1000;
    this.upcoming = {
      sym: s.code, good, mag: rand(0.03, 0.12), secs: Math.round(rand(8, 25)),
      title: pool[Math.floor(Math.random() * pool.length)].replace('{n}', s.name),
      at, revealAt: at - INSIDER_LEAD, revealed: false,
    };
  }

  _newsTick(now) {
    const u = this.upcoming;
    if (!u) return;
    if (!u.revealed && now >= u.revealAt) {
      u.revealed = true;
      for (const p of this.players.values()) {
        if (p.mods.insider > 0) {
          p.mods.insider--;
          this.dirty.add(p.id);
          this.events.push({ playerId: p.id, msg: { kind: 'insider', sym: u.sym, title: u.title, good: u.good, inSec: Math.round((u.at - now) / 1000) } });
        }
      }
    }
    if (now >= u.at) {
      this.push(u.sym, u.good ? u.mag : -u.mag, u.secs);
      const item = { id: this.seq++, sym: u.sym, title: u.title, ts: now };
      this.news.unshift(item);
      if (this.news.length > 30) this.news.length = 30;
      this.broadcasts.push({ t: 'news', item });
      this._scheduleNews(now);
    }
  }

  // ---------- 시세 ----------
  book(s) {
    const agg = (arr) => {
      const out = [];
      for (const o of arr) {
        const q = o.qty - o.filled;
        const lastRow = out[out.length - 1];
        if (lastRow && lastRow[0] === o.price) lastRow[1] += q;
        else { if (out.length >= BOOK_DEPTH) break; out.push([o.price, q]); }
      }
      return out;
    };
    return { bids: agg(s.bids), asks: agg(s.asks) };
  }

  quote(s) {
    return {
      code: s.code, name: s.name, sector: s.sector, last: s.last, ref: s.ref,
      high: s.high, low: s.low, volume: s.volume, value: s.value, tick: tickSize(s.last),
      upper: floorTick(s.ref * (1 + LIMIT)), lower: ceilTick(s.ref * (1 - LIMIT)),
      c5: s.c5[s.c5.length - 1] || null, c60: s.c60[s.c60.length - 1] || null,
      ...this.book(s),
    };
  }

  marketData() {
    const out = {};
    for (const s of this.symbols.values()) out[s.code] = this.quote(s);
    return out;
  }

  history(sym, tf) {
    const s = this.symbols.get(sym);
    if (!s) return [];
    return tf === 5 ? s.c5 : s.c60;
  }

  symbolList() {
    return [...this.symbols.values()].map((s) => ({ code: s.code, name: s.name, sector: s.sector, game: s.game }));
  }
}

module.exports = { Market, MarketError, tickSize, roundTick, FEE, TAX, START_CASH, SYMBOLS };
