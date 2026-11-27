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
const TREND = 0.0005;         // 시장 전체 우상향 추세 (거래 1초당 로그 수익률, 60초 ≈ +3%)
const TREND_PULL = 0.003;     // 지수가 추세선에서 벗어났을 때 되돌리는 힘
const STOCK_PULL = 0.0006;    // 개별 종목이 추세선으로 돌아오는 힘 (약하게)

const SYMBOLS = [
  { code: 'GRM', name: '구름전자', price: 72000, vol: 0.0009, sector: '반도체', game: 'chip' },
  { code: 'BNN', name: '바나나모빌리티', price: 18500, vol: 0.0013, sector: '자동차', game: 'parking' },
  { code: 'DKB', name: '도깨비바이오', price: 4200, vol: 0.0022, sector: '바이오', game: 'math' },
  { code: 'DLB', name: '달빛엔터', price: 31000, vol: 0.0011, sector: '엔터', game: 'reaction' },
];
// 상장폐지된 자리를 채울 신규 상장 후보
const IPO_POOL = [
  { code: 'BGB', name: '번개배터리', price: 26000, vol: 0.0016, sector: '2차전지', game: 'chip' },
  { code: 'GRG', name: '고래게임즈', price: 9800, vol: 0.0018, sector: '게임', game: 'reaction' },
  { code: 'EHA', name: '은하항공', price: 15200, vol: 0.0012, sector: '항공', game: 'parking' },
  { code: 'TKF', name: '토끼푸드', price: 6400, vol: 0.0010, sector: '식품', game: 'math' },
  { code: 'BYC', name: '별빛코인', price: 2300, vol: 0.0030, sector: '가상자산', game: 'reaction' },
  { code: 'HMR', name: '하마로보틱스', price: 41000, vol: 0.0014, sector: '로봇', game: 'chip' },
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
const SURGE_UP = ['{n}, 세계 최초 기술 개발 성공… 상한가 직행?', '{n}, 글로벌 빅테크가 인수 추진 중이라는 보도'];
const SURGE_DOWN = ['{n}, 공장 대형 화재로 생산 전면 중단', '{n}, 핵심 사업 정부 규제 철퇴'];
const BOOM = ['🚀 전체 호황! 기준금리 전격 인하', '🚀 전체 호황! 정부 대규모 경기부양책 발표', '🚀 전체 호황! 외국인 투자자 역대 최대 순매수'];
const BUST = ['🥶 전체 불황! 글로벌 금융위기 우려 확산', '🥶 전체 불황! 기준금리 기습 인상', '🥶 전체 불황! 경기침체 공식 진입'];
const THEME = ['🔥 테마주 열풍! {a}·{b} 동반 급등', '🔥 개인투자자 커뮤니티 화제… {a}·{b} 매수 몰려'];

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
    debt: 0,           // 마진 대출 상환액 (총자산에서 차감)
    bets: [],          // 다음 라운드 지수 베팅 [{ type: 'up'|'down', per }]
    delistIns: 0,      // 상장폐지 보험 보상률
    analyst: 0,        // 적정가 표시 남은 라운드
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
    this.upcoming = null;      // 다음 이벤트
    this.trend = 0;            // 추세선 (로그), 거래 시간에 따라 증가
    this.ipoPool = IPO_POOL.slice().sort(() => Math.random() - 0.5);
    for (const s of SYMBOLS) this._list(s, false);
    this._scheduleNews(Date.now());
    this.refreshQuotes();
  }

  _list(def, isNew) {
    // 게임마다 시작가를 조금씩 다르게. base: 지수 계산 기준가(상장가)
    const price = roundTick(def.price * rand(0.75, 1.3));
    const s = {
      code: def.code, name: def.name, sector: def.sector, game: def.game, vol: def.vol,
      fair: price, base: price, trendAt: this.trend, last: price, ref: price, open: price,
      high: price, low: price, volume: 0, value: 0, status: 'normal', warnAt: 0, isNew,
      bids: [], asks: [], c5: [], c60: [], drifts: [],
    };
    this.symbols.set(s.code, s);
    return s;
  }

  listed() { return [...this.symbols.values()].filter((s) => s.status !== 'delisted'); }

  // 시장지수: 상장 종목들의 (현재가/상장가) 기하평균 x 1000
  indexValue(useFair = false) {
    const ls = this.listed();
    if (!ls.length) return 1000;
    let sum = 0;
    for (const s of ls) sum += Math.log((useFair ? s.fair : s.last) / s.base) + s.trendAt;
    return 1000 * Math.exp(sum / ls.length);
  }

  // 봇 호가를 즉시 깔아둠 (게임 생성/라운드 개장 직후 빈 호가창 방지)
  refreshQuotes() {
    for (const s of this.listed()) this._marketMake(s);
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
    let v = p.cash - p.mods.debt;
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
      fairs: p.mods.analyst > 0 ? Object.fromEntries(this.listed().map((s) => [s.code, roundTick(s.fair)])) : null,
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
    if (s.status === 'delisted') throw new MarketError('상장폐지된 종목입니다.');
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
    // 우상향: 추세선이 계속 오르고, 지수가 추세선에서 멀어지면 전체를 끌어당김
    this.trend += TREND;
    const idxGap = this.trend - Math.log(this.indexValue(true) / 1000);
    for (const p of this.players.values()) if (p.mods.analyst > 0) this.dirty.add(p.id);
    for (const s of this.listed()) {
      const own = this.trend - s.trendAt - Math.log(s.fair / s.base);
      let mu = TREND + TREND_PULL * idxGap + STOCK_PULL * own;
      for (const d of s.drifts) { mu += d.perSec; d.left--; }
      s.drifts = s.drifts.filter((d) => d.left > 0);
      const vol = s.isNew ? s.vol * 2 : s.vol; // 신규 상장 첫 라운드는 변동성 2배
      s.fair *= Math.exp(mu + vol * gauss());
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
    const n = Math.random() < 0.5 ? 1 + (Math.random() < 0.2 ? 1 : 0) : 0;
    for (let i = 0; i < n; i++) {
      const side = Math.random() < 0.5 ? 'buy' : 'sell';
      const qty = Math.max(1, Math.round((rand(200_000, 2_000_000) / s.last) * (Math.random() < 0.05 ? 5 : 1)));
      this._botOrder(s, side, 'market', null, qty);
    }
  }

  // ---------- 이벤트 (내부자 카드 보유자는 미리 받음) ----------
  // 종류: 개별 호재/악재, 개별 급등/폭락, 전체 호황/불황, 테마, 감사의견 거절(관리종목), 관리종목 회생 기대
  _scheduleNews(now) {
    const ls = this.listed();
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const warned = ls.filter((s) => s.status === 'warning');
    const kinds = [['news', 46], ['surge', 9], ['boom', 13], ['bust', 9], ['theme', 9]];
    if (!warned.length && ls.length >= 3) kinds.push(['audit', 7]);
    if (warned.length) kinds.push(['rescue', 6]);
    let r = Math.random() * kinds.reduce((a, k) => a + k[1], 0);
    let kind = kinds[0][0];
    for (const [k, w] of kinds) { r -= w; if (r < 0) { kind = k; break; } }

    const ev = { kind, effects: [], sym: null };
    const s = pick(ls);
    if (kind === 'news') {
      const good = Math.random() < 0.55;
      ev.sym = s.code; ev.good = good;
      ev.title = pick(good ? NEWS_UP : NEWS_DOWN).replace('{n}', s.name);
      ev.effects.push([s.code, (good ? 1 : -1) * rand(0.05, 0.14), rand(10, 25)]);
    } else if (kind === 'surge') {
      const good = Math.random() < 0.5;
      ev.sym = s.code; ev.good = good;
      ev.title = (good ? '⚡ ' : '💥 ') + pick(good ? SURGE_UP : SURGE_DOWN).replace('{n}', s.name);
      ev.effects.push([s.code, (good ? 1 : -1) * rand(0.18, 0.27), rand(8, 15)]);
    } else if (kind === 'boom' || kind === 'bust') {
      const good = kind === 'boom';
      ev.good = good;
      ev.title = pick(good ? BOOM : BUST);
      const base = good ? rand(0.06, 0.13) : -rand(0.05, 0.11);
      for (const x of ls) ev.effects.push([x.code, base * rand(0.6, 1.4), rand(20, 40)]);
    } else if (kind === 'theme') {
      const two = ls.slice().sort(() => Math.random() - 0.5).slice(0, 2);
      ev.good = true;
      ev.title = pick(THEME).replace('{a}', two[0].name).replace('{b}', two[1] ? two[1].name : two[0].name);
      for (const x of two) ev.effects.push([x.code, rand(0.08, 0.16), rand(12, 25)]);
    } else if (kind === 'audit') {
      ev.sym = s.code; ev.good = false;
      ev.title = `🚨 ${s.name}, 감사의견 거절… 관리종목 지정! 라운드 종료 후 상장폐지 심사`;
      ev.effects.push([s.code, -rand(0.15, 0.25), rand(8, 15)]);
    } else if (kind === 'rescue') {
      const w = pick(warned);
      ev.sym = w.code; ev.good = true;
      ev.title = `🛟 ${w.name}, 대형 투자 유치 추진… 상장 유지 기대감`;
      ev.effects.push([w.code, rand(0.12, 0.2), rand(10, 20)]);
      ev.rescue = true;
    }
    const at = now + rand(25, 45) * 1000;
    this.upcoming = { ...ev, at, revealAt: at - INSIDER_LEAD, revealed: false };
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
      for (const [code, pct, secs] of u.effects) {
        const s = this.symbols.get(code);
        if (s && s.status !== 'delisted') this.push(code, pct, Math.round(secs));
      }
      if (u.kind === 'audit') { const s = this.symbols.get(u.sym); if (s && s.status === 'normal') { s.status = 'warning'; s.warnAt = now; } }
      if (u.rescue) { const s = this.symbols.get(u.sym); if (s) s.rescued = true; }
      this._announce(u.kind, u.sym, u.title);
      this._scheduleNews(now);
    }
  }

  _announce(kind, sym, title) {
    const item = { id: this.seq++, kind, sym, title, ts: Date.now() };
    this.news.unshift(item);
    if (this.news.length > 40) this.news.length = 40;
    this.broadcasts.push({ t: 'news', item });
  }

  // ---------- 라운드 경계 (방에서 호출) ----------
  // 라운드 종료: 지수 베팅 정산, 적정가 표시 차감, 관리종목 심사/지정
  roundEnd(idxStart) {
    const idx = this.indexValue();
    const chg = (idx / idxStart - 1) * 100;
    for (const p of this.players.values()) {
      for (const b of p.mods.bets) {
        const pts = Math.max(0, b.type === 'down' ? -chg : chg);
        const pay = Math.round(pts * b.per);
        if (pay > 0) this.addCash(p, pay);
        this.events.push({ playerId: p.id, msg: { kind: 'buff', text: `${b.type === 'down' ? '🐻 인버스' : '🐂 불장'} 베팅 정산: 지수 ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% → ${pay > 0 ? '+' + pay.toLocaleString('ko-KR') + '원' : '꽝'}` } });
      }
      if (p.mods.bets.length) { p.mods.bets = []; this.dirty.add(p.id); }
      if (p.mods.analyst > 0) { p.mods.analyst--; this.dirty.add(p.id); }
    }
    const now = Date.now();
    for (const s of this.listed()) {
      s.isNew = false;
      const ratio = s.last / s.base / Math.exp(this.trend - s.trendAt);
      if (s.status === 'warning') {
        if (now - s.warnAt < 20_000) continue; // 라운드 막판 지정이면 다음 라운드 종료 때 심사
        // 심사: 주가가 많이 빠졌으면 무조건 폐지, 아니면 반반 (회생 뉴스가 있었으면 유리)
        const p = ratio < 0.55 ? 1 : s.rescued ? 0.25 : 0.5;
        if (Math.random() < p) this._delist(s);
        else {
          s.status = 'normal'; s.rescued = false;
          this.push(s.code, 0.12, 15);
          this._announce('relief', s.code, `✅ ${s.name}, 상장폐지 심사 통과! 관리종목 해제`);
        }
      } else if (ratio < 0.5) {
        s.status = 'warning'; s.warnAt = 0; // 다음 라운드 종료 때 심사
        this._announce('warn', s.code, `🚨 ${s.name}, 주가 급락으로 관리종목 지정. 다음 라운드 종료 후 상장폐지 심사`);
      }
    }
  }

  _delist(s) {
    s.status = 'delisted';
    for (const o of [...this.orders.values()]) if (o.sym === s.code) this._cancel(o);
    s.bids = []; s.asks = []; s.drifts = [];
    for (const p of this.players.values()) {
      const ps = p.positions[s.code];
      if (!ps || !ps.qty) continue;
      const cost = ps.qty * ps.avgCost;
      const refund = Math.round(cost * p.mods.delistIns);
      if (refund > 0) this.addCash(p, refund);
      p.realized += refund - cost;
      p.history.unshift({ sym: s.code, side: 'delist', price: 0, qty: ps.qty, fee: 0, pnl: Math.round(refund - cost), ts: Date.now() });
      this.events.push({ playerId: p.id, msg: { kind: 'buff', text: `💀 ${s.name} 상장폐지! 보유 ${ps.qty.toLocaleString('ko-KR')}주가 휴지조각이 됐습니다${refund > 0 ? ` (보험금 ${refund.toLocaleString('ko-KR')}원)` : ''}` } });
      delete p.positions[s.code];
      this.dirty.add(p.id);
    }
    this._announce('delist', s.code, `💀 ${s.name} 상장폐지 확정! 보유 주식은 0원이 됩니다`);
  }

  // 라운드 시작: 상장폐지된 자리에 신규 상장. 바뀌었으면 true
  roundStart() {
    let changed = false;
    for (const s of [...this.symbols.values()]) {
      if (s.status !== 'delisted') continue;
      this.symbols.delete(s.code);
      const def = this.ipoPool.find((d) => !this.symbols.has(d.code));
      if (def) {
        this.ipoPool = this.ipoPool.filter((d) => d !== def);
        const n = this._list(def, true);
        n.trendAt = this.trend;
        this._announce('ipo', n.code, `🎉 ${n.name}(${n.sector}) 신규 상장! 첫날은 변동성이 큽니다`);
      }
      changed = true;
    }
    if (changed) this.broadcasts.push({ t: 'symbols', symbols: this.symbolList(), md: this.marketData() });
    return changed;
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
      code: s.code, name: s.name, sector: s.sector, last: s.last, ref: s.ref, status: s.status, isNew: s.isNew,
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
    return [...this.symbols.values()].map((s) => ({ code: s.code, name: s.name, sector: s.sector, game: s.game, status: s.status }));
  }
}

module.exports = { Market, MarketError, tickSize, roundTick, FEE, TAX, START_CASH, SYMBOLS };
