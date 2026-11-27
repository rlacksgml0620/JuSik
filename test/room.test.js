'use strict';
// 방 하나를 가짜 시계로 끝까지 진행: 로비 → 거래 → 카드 → 미니게임 → 종료
const assert = require('assert');
const { Room } = require('../src/room');

const sent = [];
const io = { sendTo: (pid, msg) => sent.push({ pid, msg }), broadcast: (room, msg) => sent.push({ all: true, msg }) };
const room = new Room('TEST', io);
const a = room.join('철수'), b = room.join('영희');
assert.throws(() => room.join('철수'), /같은 닉네임/);
// 최대 4명: 3·4번째는 입장, 5번째는 거절
const extra = [room.join('민수'), room.join('지영')];
assert.throws(() => room.join('다섯째'), /가득/);
extra.forEach((p) => room.leave(p.id));
assert.throws(() => room.start(b.id), /방장만/);
room.configure(a.id, { rounds: 6, roundSecs: 30 });

let now = Date.now();
const realNow = Date.now;
Date.now = () => now;
const advance = (ms) => { for (let t = 0; t < ms; t += 250) { now += 250; room.tick(); if (room.market && !room.market.paused && t % 1000 === 0) room.market.step(); } };

room.start(a.id);
assert.strictEqual(room.phase, 'countdown', '시작 카운트다운');
assert.ok(room.market.paused, '카운트다운 중에는 장이 멈춤');
assert.throws(() => room.market.placeOrder(room.market.players.get(a.id), { sym: 'GRM', side: 'buy', type: 'market', qty: 1 }), /거래 시간/);
const phases = [];
let last = room.phase;
for (let i = 0; i < 2000 && room.phase !== 'ended'; i++) {
  if (room.phase === 'draft') {
    // 미니게임 고수 카드는 남은 미니게임이 있을 때만 등장
    for (const o of room.drafts.get(a.id).options) if (o.id === 'gamer') assert.ok(room.mgLeft > 0, '남은 미니게임 0인데 미니게임 카드 등장');
  }
  if (room.phase === 'trading' && room.round === 1 && !room._bought) {
    room._bought = true;
    room.market.placeOrder(room.market.players.get(a.id), { sym: 'GRM', side: 'buy', type: 'market', qty: 10 });
  }
  if (room.phase === 'draft' && room.drafts.get(a.id).picked == null) room.pick(a.id, 0); // b는 시간초과 → 자동 선택
  if (room.phase === 'minigame' && now >= room.mg.startAt && !room.mg.scores.has(a.id)) { room.submitScore(a.id, 20); room.submitScore(b.id, 99999); }
  advance(1000);
  if (room.phase !== last) { phases.push(room.phase); last = room.phase; }
}
Date.now = realNow;

assert.strictEqual(room.phase, 'ended');
assert.ok(phases.includes('draft') && phases.includes('minigame') && phases.includes('mgresult'), phases.join(','));
const mp = room.market.players;
assert.strictEqual(mp.get(a.id).cards.length, 4, '카드 4장 (라운드 1,2,4,5 후)');
assert.strictEqual(mp.get(b.id).cards.length, 4, '자동 선택도 4장');
assert.ok(room.final.rows.length === 2 && room.final.rows[0].rank === 1);
const mgMsg = sent.find((s) => s.msg.t === 'mgresult').msg;
assert.ok(mgMsg.rows[0].score <= 80, '점수 상한 적용');
// 미니게임 카드: 남은 미니게임 없으면 안 나오고, 배율은 x2.5 상한
const { drawOptions, applyCard } = require('../src/cards');
const { Market } = require('../src/market');
const mk = new Market(); const gp = mk.addPlayer('g', 'g');
for (let i = 0; i < 300; i++) assert.ok(!drawOptions(mk, gp, 3, { mgLeft: 0 }).some((o) => o.id === 'gamer'));
assert.ok(Array.from({ length: 300 }, () => drawOptions(mk, gp, 3, { mgLeft: 2 })).flat().some((o) => o.id === 'gamer'));
for (let i = 0; i < 5; i++) applyCard(mk, gp, { id: 'gamer', rarity: 3 }, { mgLeft: 2 });
assert.strictEqual(gp.mods.gameMult, 2.5);
for (let i = 0; i < 300; i++) assert.ok(!drawOptions(mk, gp, 3, { mgLeft: 2 }).some((o) => o.id === 'gamer'), '상한이면 더 안 나옴');
assert.ok(phases.filter((p) => p === 'countdown').length >= 4, '라운드마다 카운트다운');

console.log('OK: 진행 순서', phases.join(' → '));
console.log('최종:', room.final.rows.map((r) => `${r.rank}위 ${r.name} ${r.equity.toLocaleString()}원 카드:${r.cardList.map((c) => c.icon).join('')}`).join(' / '));
