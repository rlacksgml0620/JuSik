'use strict';
// 시장 엔진: 종목별 호가창(가격-시간 우선 매칭), 계좌 정산, 시장조성/노이즈 봇, 뉴스 이벤트
const crypto = require('crypto');

const FEE = 0.00015;   // 매매 수수료 0.015% (매수/매도 공통)
const TAX = 0.0018;    // 매도 시 거래세 0.18%
const START_CASH = 10_000_000;
const MAX_QTY = 1_000_000;
const BOOK_DEPTH = 10;
const C5 = 5, C60 = 60;              // 캔들 간격(초)
const MAX_C5 = 4000, MAX_C60 = 3000; // 보관할 캔들 수
const KST = 9 * 3600 * 1000;

const SYMBOLS = [
  { code: 'GRM', name: '구름전자', price: 72000, vol: 0.0011, sector: '반도체' },
  { code: 'BNN', name: '바나나모빌리티', price: 18500, vol: 0.0018, sector: '자동차' },
  { code: 'DKB', name: '도깨비바이오', price: 4200, vol: 0.0032, sector: '바이오' },
  { code: 'DLB', name: '달빛엔터', price: 31000, vol: 0.0015, sector: '엔터' },
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
const NEWS_SECTOR = {
  '바이오': ['{n}, 임상 3상 결과 발표 임박', '{n}, 신약 FDA 심사 일정 확정'],
  '반도체': ['{n}, 차세대 칩 양산 일정 공개'],
  '자동차': ['{n}, 자율주행 규제 관련 정부 발표 예정'],
  '엔터': ['{n}, 소속 아티스트 월드투어 발표'],
};

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
const isOnTick = (p) => p % tickSize(p) === 0;
const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const rand = (a, b) => a + Math.random() * (b - a);
const kstDay = (ms) => Math.floor((ms + KST) / 86400000);

class MarketError extends Error {}

class Market {
  constructor() {
    this.players = new Map();   // id -> player
    this.byName = new Map();    // lower(name) -> id
    this.byToken = new Map();   // token -> id
    this.orders = new Map();    // id -> order (활성 주문만)
    this.symbols = new Map();
    this.news = [];
    this.chat = [];
    this.pendingTrades = [];    // 다음 브로드캐스트로 보낼 체결
    this.dirty = new Set();     // 계좌가 바뀐 플레이어
    this.events = [];           // 개인 알림 {playerId, msg}
    this.seq = 1;
    this.nextNewsAt = Date.now() + rand(40, 90) * 1000;
    for (const s of SYMBOLS) this.symbols.set(s.code, this._newSymbol(s));
  }

  _newSymbol(s) {
    return {
      code: s.code, name: s.name, sector: s.sector, vol: s.vol,
      fair: s.price, anchor: s.price, last: s.price, ref: s.price, refDay: kstDay(Date.now()),
      high: s.price, low: s.price, volume: 0, value: 0,
      bids: [], asks: [], c5: [], c60: [], drift: null,
    };
  }

  // ---------- 플레이어 ----------
  join(name, token) {
    if (token && this.byToken.has(token)) {
      return this.players.get(this.byToken.get(token));
    }
    name = String(name || '').trim();
    if (!/^[\p{L}\p{N}_\- ]{2,12}$/u.test(name)) throw new MarketError('닉네임은 2~12자의 글자/숫자만 가능합니다.');
    if (this.byName.has(name.toLowerCase())) throw new MarketError('이미 사용 중인 닉네임입니다.');
    const p = {
      id: crypto.randomUUID(), token: crypto.randomUUID(), name,
      cash: START_CASH, reservedCash: 0, positions: {}, realized: 0,
      history: [], createdAt: Date.now(), resets: 0,
    };
    this._index(p);
    this.dirty.add(p.id);
    return p;
  }

  _index(p) {
    this.players.set(p.id, p);
    this.byName.set(p.name.toLowerCase(), p.id);
    this.byToken.set(p.token, p.id);
  }

  resetPlayer(p) {
    for (const o of [...this.orders.values()]) if (o.owner === p.id) this._cancel(o);
    p.cash = START_CASH; p.reservedCash = 0; p.positions = {}; p.realized = 0; p.history = [];
    p.resets = (p.resets || 0) + 1;
    this.dirty.add(p.id);
  }

  pos(p, sym) {
    return p.positions[sym] || (p.positions[sym] = { qty: 0, reserved: 0, avgCost: 0 });
  }

  equity(p) {
    let v = p.cash;
    for (const [sym, ps] of Object.entries(p.positions)) v += ps.qty * this.symbols.get(sym).last;
    return v;
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
      equity: Math.round(this.equity(p)), startCash: START_CASH,
    };
  }

  leaderboard(n = 20) {
    const rows = [];
    for (const p of this.players.values()) {
      const eq = this.equity(p);
      rows.push({ name: p.name, equity: Math.round(eq), ret: (eq / START_CASH - 1) * 100 });
    }
    rows.sort((a, b) => b.equity - a.equity);
    return { top: rows.slice(0, n), total: rows.length };
  }

  // ---------- 주문 ----------
  placeOrder(p, { sym, side, type, price, qty }) {
    const s = this.symbols.get(sym);
    if (!s) throw new MarketError('없는 종목입니다.');
    if (side !== 'buy' && side !== 'sell') throw new MarketError('잘못된 주문 방향');
    if (type !== 'limit' && type !== 'market') throw new MarketError('잘못된 주문 유형');
    qty = Number(qty);
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) throw new MarketError('수량은 1 이상의 정수여야 합니다.');

    const o = {
      id: this.seq++, owner: p.id, sym, side, type, qty, filled: 0, reserved: 0,
      price: null, ts: Date.now(), bot: false,
    };

    if (type === 'limit') {
      price = Number(price);
      if (!Number.isInteger(price) || price <= 0) throw new MarketError('가격이 올바르지 않습니다.');
      if (!isOnTick(price)) throw new MarketError(`호가 단위(${tickSize(price)}원)에 맞지 않는 가격입니다.`);
      if (price > s.ref * 1.3 || price < s.ref * 0.7) throw new MarketError('가격제한폭(기준가 ±30%)을 벗어났습니다.');
      o.price = price;
    }

    if (side === 'buy') {
      const avail = p.cash - p.reservedCash;
      if (type === 'limit') {
        const need = Math.ceil(o.price * qty * (1 + FEE));
        if (need > avail) throw new MarketError('주문 가능 금액이 부족합니다.');
        o.reserved = need; p.reservedCash += need;
      } else {
        // 시장가 매수: 호가를 미리 훑어 살 수 있는 수량으로 제한
        let left = avail, can = 0;
        for (const a of s.asks) {
          if (a.owner === p.id) continue;
          const rem = a.qty - a.filled;
          const unit = a.price * (1 + FEE);
          const k = Math.min(rem, Math.floor(left / unit), qty - can);
          can += k; left -= k * unit + 1; // +1: 체결별 수수료 반올림 여유
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

  _pubOrder(o) {
    return { id: o.id, sym: o.sym, side: o.side, type: o.type, price: o.price, qty: o.qty, filled: o.filled, ts: o.ts };
  }

  _process(o) {
    const s = this.symbols.get(o.sym);
    const opp = o.side === 'buy' ? s.asks : s.bids;
    while (o.filled < o.qty && opp.length) {
      const best = opp[0];
      if (o.type === 'limit' && (o.side === 'buy' ? best.price > o.price : best.price < o.price)) break;
      if (!o.bot && best.owner === o.owner) { this._cancel(best); continue; } // 자전거래 방지: 기존 주문 취소
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

  // 주문 종료: 남은 예약금/예약수량 해제
  _finish(o, canceled = false) {
    this.orders.delete(o.id);
    if (o.bot) return;
    const p = this.players.get(o.owner);
    if (!p) return;
    if (o.side === 'buy') { p.reservedCash -= o.reserved; o.reserved = 0; }
    else { this.pos(p, o.sym).reserved -= (o.qty - o.filled); }
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
      const fee = Math.round(notional * FEE);
      if (buy.reserved > 0) {
        const rel = Math.min(buy.reserved, Math.ceil(buy.price * q * (1 + FEE)));
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
      const fee = Math.round(notional * FEE);
      const tax = Math.round(notional * TAX);
      const ps = this.pos(p, sell.sym);
      ps.qty -= q; ps.reserved -= q;
      p.cash += notional - fee - tax;
      const pnl = notional - fee - tax - ps.avgCost * q;
      p.realized += pnl;
      if (ps.qty === 0) ps.avgCost = 0;
      this._record(p, { sym: sell.sym, side: 'sell', price, qty: q, fee: fee + tax, pnl: Math.round(pnl), ts: now });
    }

    // 시세 갱신
    s.last = price;
    s.high = Math.max(s.high, price); s.low = Math.min(s.low, price);
    s.volume += q; s.value += notional;
    // 체결가가 내재가치를 끌어당김 → 대량 매수/매도가 실제로 가격을 움직임
    s.fair += 0.35 * (price - s.fair);
    this._candle(s, price, q, now);
    this.pendingTrades.push({ sym: s.code, price, qty: q, side: aggressor, ts: now, player: !(buy.bot && sell.bot) });
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

  // ---------- 봇 & 시뮬레이션 (1초마다) ----------
  step() {
    const now = Date.now();
    const day = kstDay(now);
    if (now >= this.nextNewsAt) this._news(now);

    for (const s of this.symbols.values()) {
      if (s.refDay !== day) { // 날짜 변경: 전일 종가를 기준가로
        s.ref = s.last; s.refDay = day; s.high = s.low = s.last; s.volume = 0; s.value = 0;
      }
      // 내재가치 랜덤워크 + 뉴스 드리프트 + 약한 평균회귀
      let mu = 0.000002 * Math.log(s.anchor / s.fair);
      if (s.drift) { mu += s.drift.perSec; if (--s.drift.left <= 0) s.drift = null; }
      s.fair *= Math.exp(mu + s.vol * gauss());
      s.fair = Math.min(Math.max(s.fair, s.ref * 0.71, 50), s.ref * 1.29);

      this._marketMake(s);
      this._noise(s);
      this._candle(s, s.last, 0, now); // 거래 없어도 캔들 생성
    }
  }

  _botOrder(s, side, type, price, qty) {
    const o = { id: this.seq++, owner: 'bot', sym: s.code, side, type, price, qty, filled: 0, reserved: 0, ts: Date.now(), bot: true };
    this._process(o);
  }

  _marketMake(s) {
    // 기존 봇 호가 철회
    for (const arr of [s.bids, s.asks]) {
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i].bot) { this.orders.delete(arr[i].id); arr.splice(i, 1); }
    }
    const t = tickSize(s.fair);
    const half = Math.max(t, s.fair * 0.0006);
    const step = Math.max(t, s.fair * 0.0008);
    const baseQty = 2_500_000 / s.fair;
    const hiLim = floorTick(s.ref * 1.3), loLim = ceilTick(s.ref * 0.7);
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

  _news(now) {
    this.nextNewsAt = now + rand(60, 150) * 1000;
    const syms = [...this.symbols.values()];
    const s = syms[Math.floor(Math.random() * syms.length)];
    let good = Math.random() < 0.5;
    let pool = good ? NEWS_UP : NEWS_DOWN;
    let mag = rand(0.03, 0.12);
    // 가끔 방향이 애매한 '루머' 뉴스
    if (Math.random() < 0.2 && NEWS_SECTOR[s.sector]) { pool = NEWS_SECTOR[s.sector]; mag *= 1.4; }
    const title = pool[Math.floor(Math.random() * pool.length)].replace('{n}', s.name);
    const secs = Math.round(rand(8, 30));
    const lr = Math.log(1 + (good ? mag : -mag));
    s.drift = { perSec: lr / secs, left: secs };
    const item = { id: this.seq++, sym: s.code, title, ts: now };
    this.news.unshift(item);
    if (this.news.length > 30) this.news.length = 30;
    return item;
  }

  // ---------- 시세 스냅샷 ----------
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
      upper: floorTick(s.ref * 1.3), lower: ceilTick(s.ref * 0.7),
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

  // ---------- 저장/복원 ----------
  serialize() {
    const symbols = {};
    for (const s of this.symbols.values()) {
      const { bids, asks, ...rest } = s;
      symbols[s.code] = rest;
    }
    const orders = [...this.orders.values()].filter((o) => !o.bot);
    return { v: 1, seq: this.seq, players: [...this.players.values()], orders, symbols, news: this.news, chat: this.chat };
  }

  restore(d) {
    if (!d || d.v !== 1) return;
    this.seq = d.seq || 1;
    for (const p of d.players || []) this._index(p);
    for (const [code, saved] of Object.entries(d.symbols || {})) {
      const s = this.symbols.get(code);
      if (s) Object.assign(s, saved, { bids: [], asks: [] });
    }
    for (const o of d.orders || []) {
      const s = this.symbols.get(o.sym);
      if (!s || !this.players.has(o.owner)) continue;
      this._insert(s, o);
      this.orders.set(o.id, o);
    }
    this.news = d.news || [];
    this.chat = d.chat || [];
  }
}

module.exports = { Market, MarketError, tickSize, FEE, TAX, START_CASH };
