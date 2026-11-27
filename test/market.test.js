'use strict';
// 무작위 주문을 대량으로 넣고 계좌/호가 불변식이 깨지지 않는지 확인
const assert = require('assert');
const { Market, MarketError, tickSize } = require('../src/market');

const m = new Market();
const players = Array.from({ length: 8 }, (_, i) => m.join('테스터' + i));
const syms = [...m.symbols.keys()];
let ok = 0, rejected = 0;

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

for (let round = 0; round < 3000; round++) {
  if (round % 10 === 0) m.step();
  const p = players[Math.floor(Math.random() * players.length)];
  const sym = syms[Math.floor(Math.random() * syms.length)];
  const s = m.symbols.get(sym);
  const r = Math.random();
  try {
    if (r < 0.1) {
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

// 저장/복원 왕복
const m2 = new Market();
m2.restore(JSON.parse(JSON.stringify(m.serialize())));
assert.strictEqual(m2.players.size, m.players.size);
const p0 = players[0];
assert.strictEqual(Math.round(m2.equity(m2.players.get(p0.id))), Math.round(m.equity(p0)));

// 대량 시장가 매수가 가격을 끌어올리는지
const whale = m.join('고래');
const g = m.symbols.get('GRM');
const before = g.last;
m.placeOrder(whale, { sym: 'GRM', side: 'buy', type: 'market', qty: 120 });
assert.ok(g.last > before, `대량 매수 후 가격 상승해야 함 (${before} -> ${g.last})`);

console.log(`OK: 주문 ${ok}건 처리, ${rejected}건 거부, 불변식 유지. 고래 매수 ${before} -> ${g.last}`);
