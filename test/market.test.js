'use strict';
// 무작위 주문 + 카드 효과를 섞어 넣고 계좌/호가 불변식이 깨지지 않는지 확인
const assert = require('assert');
const { Market, MarketError, tickSize } = require('../src/market');
const { CARDS, drawOptions, applyCard } = require('../src/cards');

const m = new Market();
m.paused = false;
const players = Array.from({ length: 8 }, (_, i) => m.addPlayer('p' + i, '테스터' + i));
const syms = [...m.symbols.keys()];
let ok = 0, rejected = 0, cardsApplied = 0;

function check() {
  for (const p of players) {
    let reservedCash = 0;
    const reservedQty = {};
    for (const o of m.orders.values()) {
      if (o.owner !== p.id) continue;
      if (o.side === 'buy') reservedCash += o.reserved;
      else reservedQty[o.sym] = (reservedQty[o.sym] || 0) + (o.qty - o.filled);
    }
    assert.strictEqual(p.reservedCash, reservedCash, 'reservedCash 불일치');
    assert.ok(p.cash >= p.reservedCash, `현금 < 예약금 (${p.cash} < ${p.reservedCash})`);
    assert.ok(p.cash >= 0, '현금 음수');
    for (const [s, ps] of Object.entries(p.positions)) {
      assert.strictEqual(ps.reserved, reservedQty[s] || 0, '예약수량 불일치');
      assert.ok(ps.qty >= ps.reserved && ps.qty >= 0, '보유수량 음수/부족');
    }
  }
  for (const s of m.symbols.values()) {
    for (let i = 1; i < s.bids.length; i++) assert.ok(s.bids[i - 1].price >= s.bids[i].price, '매수호가 정렬 오류');
    for (let i = 1; i < s.asks.length; i++) assert.ok(s.asks[i - 1].price <= s.asks[i].price, '매도호가 정렬 오류');
    if (s.bids.length && s.asks.length) assert.ok(s.bids[0].price < s.asks[0].price, '호가 교차');
  }
}

for (let round = 0; round < 4000; round++) {
  if (round % 10 === 0) m.step();
  if (round % 300 === 0) m.newDay();
  const p = players[Math.floor(Math.random() * players.length)];
  if (round % 50 === 0) { // 카드 적용 (레버리지 등이 정산 불변식을 깨지 않는지)
    const opts = drawOptions(m, p);
    applyCard(m, p, opts[0], { tradingResumeAt: Date.now() });
    cardsApplied++;
  }
  const sym = syms[Math.floor(Math.random() * syms.length)];
  const s = m.symbols.get(sym);
  try {
    if (Math.random() < 0.1) {
      const mine = [...m.orders.values()].filter((o) => o.owner === p.id);
      if (mine.length) m.cancelOrder(p, mine[0].id);
    } else {
      const side = Math.random() < 0.55 ? 'buy' : 'sell';
      const type = Math.random() < 0.4 ? 'market' : 'limit';
      let price = Math.round(s.last * (1 + (Math.random() - 0.5) * 0.02));
      price = Math.round(price / tickSize(price)) * tickSize(price);
      const qty = 1 + Math.floor(Math.random() * (side === 'buy' ? 3_000_000 / s.last : 200));
      m.placeOrder(p, { sym, side, type, price, qty });
    }
    ok++;
  } catch (e) {
    if (!(e instanceof MarketError)) throw e;
    rejected++;
  }
  check();
}

// 레버리지: 같은 매매에서 손익이 배율만큼 커지는지
const a = new Market(); a.paused = false;
const x1 = a.addPlayer('x1', 'x1'), x3 = a.addPlayer('x3', 'x3');
x3.mods.leverage = 3; x1.mods.feeFree = x3.mods.feeFree = true;
const g = a.symbols.get('GRM');
for (const p of [x1, x3]) { a.grantShares(p, 'GRM', 10, g.last); }
const base1 = x1.cash, base3 = x3.cash;
const sellAt = g.bids[0] ? g.bids[0].price : null;
a.step();
a.placeOrder(x1, { sym: 'GRM', side: 'sell', type: 'market', qty: 10 });
a.placeOrder(x3, { sym: 'GRM', side: 'sell', type: 'market', qty: 10 });
const pnl1 = x1.realized, pnl3 = x3.realized;
if (Math.abs(pnl1) > 0) assert.ok(Math.abs(pnl3) > Math.abs(pnl1) * 2, `레버리지 3배 손익 확대 (${pnl1} vs ${pnl3})`);

// 깡통 보호: 큰 레버리지 손실이 현금을 음수로 만들지 않음
const b = new Market(); b.paused = false;
const z = b.addPlayer('z', 'z');
z.mods.leverage = 50;
const d = b.symbols.get('DKB');
b.grantShares(z, 'DKB', 5000, d.last * 1.25); // 평균단가를 높게 → 큰 손실
b.step();
b.placeOrder(z, { sym: 'DKB', side: 'sell', type: 'market', qty: 5000 });
assert.ok(z.cash >= 0, '깡통 보호 실패');

// 모든 카드가 모든 등급에서 설명/적용 가능
const c = new Market();
const cp = c.addPlayer('c', 'c');
for (const card of CARDS) for (let r = card.minRarity || 0; r < 4; r++) {
  applyCard(c, cp, { id: card.id, rarity: r, sym: card.needsSym ? 'GRM' : undefined }, { tradingResumeAt: Date.now() });
}

// 상장폐지: 보유 주식 소멸, 보험금 지급, 주문 취소, 다음 라운드에 신규 상장
const dm = new Market(); dm.paused = false;
const holder = dm.addPlayer('h', 'h'), insured = dm.addPlayer('i', 'i');
insured.mods.delistIns = 0.7;
const victim = dm.symbols.get('DKB');
dm.grantShares(holder, 'DKB', 100, victim.last); dm.grantShares(insured, 'DKB', 100, victim.last);
dm.placeOrder(holder, { sym: 'DKB', side: 'sell', type: 'limit', price: victim.ref * 1.2 - (victim.ref * 1.2) % tickSize(victim.ref * 1.2), qty: 50 });
const cashBefore = insured.cash;
victim.status = 'warning'; victim.warnAt = 0; victim.last = Math.round(victim.base * 0.3); // 폭락 → 심사 시 무조건 폐지
dm.roundEnd(dm.indexValue());
assert.strictEqual(victim.status, 'delisted');
assert.ok(!holder.positions.DKB && !insured.positions.DKB, '보유 주식 소멸');
assert.strictEqual(insured.cash - cashBefore, Math.round(100 * victim.base * 0.7), '보험금 70%');
assert.ok(![...dm.orders.values()].some((o) => o.sym === 'DKB'), '주문 취소');
assert.throws(() => dm.placeOrder(holder, { sym: 'DKB', side: 'buy', type: 'market', qty: 1 }), /상장폐지/);
assert.ok(dm.roundStart(), '신규 상장');
assert.ok(!dm.symbols.has('DKB') && dm.symbols.size === 4, '자리 교체');
assert.ok(dm.broadcasts.some((b) => b.t === 'symbols'));

// 지수 베팅: 지수가 내리면 인버스만 받음 / 대출은 총자산에서 차감
const bm = new Market();
const bear = bm.addPlayer('b', 'b'), bull = bm.addPlayer('u', 'u');
bear.mods.bets.push({ type: 'down', per: 100_000 }); bull.mods.bets.push({ type: 'up', per: 100_000 });
const st = bm.indexValue();
for (const x of bm.symbols.values()) x.last = Math.round(x.last * 0.95);
const c0 = bear.cash, c1 = bull.cash;
bm.roundEnd(st);
assert.ok(bear.cash - c0 > 400_000 && bull.cash === c1, '인버스 베팅 정산');
const lp = bm.addPlayer('l', 'l');
applyCard(bm, lp, { id: 'loan', rarity: 0 }, {});
assert.strictEqual(Math.round(bm.equity(lp)), 10_000_000 - 300_000, '대출 이자만큼 총자산 감소');

console.log(`OK: 주문 ${ok}건 처리, ${rejected}건 거부, 카드 ${cardsApplied}장 적용, 불변식 유지. 레버리지 손익 x1=${Math.round(pnl1)} x3=${Math.round(pnl3)}`);
