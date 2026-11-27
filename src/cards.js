'use strict';
// 로그라이크 카드: 등급(0 일반 ~ 3 전설)별로 효과 수치가 다름
const RARITIES = [
  { key: 'common', name: '일반', weight: 60 },
  { key: 'rare', name: '희귀', weight: 27 },
  { key: 'epic', name: '영웅', weight: 10 },
  { key: 'legendary', name: '전설', weight: 3 },
];

const won = (n) => Math.round(n).toLocaleString('ko-KR') + '원';
const pctS = (n) => Math.round(n * 100) + '%';

// v: 등급별 수치, needsSym: 카드에 대상 종목이 붙음
const CARDS = [
  {
    id: 'leverage', name: '레버리지', icon: '📈', type: '영구', v: [0.5, 1, 1.5, 2.5],
    desc: (v, c) => `모든 손익(수익·손실)이 영구적으로 +${v}배 커집니다. (현재 x${c.p.mods.leverage} → x${c.p.mods.leverage + v})`,
    apply: (m, p, v) => { p.mods.leverage = Math.round((p.mods.leverage + v) * 10) / 10; },
  },
  {
    id: 'scalp', name: '단타의 신', icon: '⚡', type: '지속', v: [[30, 0.5, 0.2], [45, 0.6, 0.3], [60, 0.75, 0.5], [90, 0.9, 1]],
    desc: ([s, save, bonus]) => `${s}초 동안 손실 매도 시 ${pctS(save)} 확률로 손실 무효화, 수익 매도 시 수익 +${pctS(bonus)}. (거래 시간 기준)`,
    apply: (m, p, [s, save, bonus], c) => {
      p.mods.scalpUntil = Math.max(p.mods.scalpUntil, c.tradingResumeAt) + s * 1000;
      p.mods.scalpSave = Math.max(p.mods.scalpSave, save); p.mods.scalpBonus = Math.max(p.mods.scalpBonus, bonus);
    },
  },
  {
    id: 'shield', name: '손절 방패', icon: '🛡️', type: '영구', v: [0.85, 0.75, 0.6, 0.4],
    desc: (v) => `모든 손실이 영구적으로 ${pctS(1 - v)} 줄어듭니다.`,
    apply: (m, p, v) => { p.mods.lossMult = Math.round(p.mods.lossMult * v * 100) / 100; },
  },
  {
    id: 'nofee', name: 'VIP 계좌', icon: '💳', type: '영구', v: [null, true, true, true], minRarity: 1,
    desc: () => '수수료와 거래세가 영구 면제됩니다.',
    apply: (m, p) => { p.mods.feeFree = true; },
  },
  {
    id: 'cash', name: '긴급 자금', icon: '💰', type: '즉시', v: [500_000, 1_200_000, 3_000_000, 7_000_000],
    desc: (v) => `즉시 현금 ${won(v)}을 받습니다.`,
    apply: (m, p, v) => m.addCash(p, v),
  },
  {
    id: 'interest', name: '복리 예금', icon: '🏦', type: '영구', v: [0.01, 0.02, 0.035, 0.06],
    desc: (v) => `라운드가 끝날 때마다 보유 현금의 ${(v * 100).toFixed(1)}%를 이자로 받습니다. (중첩)`,
    apply: (m, p, v) => { p.mods.interest += v; },
  },
  {
    id: 'dividend', name: '배당 투자', icon: '🌾', type: '영구', v: [0.015, 0.03, 0.05, 0.08],
    desc: (v) => `라운드가 끝날 때마다 보유 주식 평가액의 ${(v * 100).toFixed(1)}%를 배당으로 받습니다. (중첩)`,
    apply: (m, p, v) => { p.mods.dividend += v; },
  },
  {
    id: 'insider', name: '내부자 정보', icon: '🕵️', type: '횟수', v: [1, 2, 3, 5],
    desc: (v) => `다음 뉴스 ${v}건을 다른 사람보다 15초 먼저 받아봅니다.`,
    apply: (m, p, v) => { p.mods.insider += v; },
  },
  {
    id: 'pump', name: '작전 세력', icon: '🚀', type: '즉시', v: [0.05, 0.08, 0.12, 0.2], needsSym: true,
    desc: (v, c) => `다음 라운드 시작과 함께 ${c.symName} 주가를 약 +${pctS(v)} 끌어올립니다. 모두의 차트가 움직입니다!`,
    apply: (m, p, v, c) => { m.push(c.sym, v, 12); },
  },
  {
    id: 'rumor', name: '악성 루머', icon: '💣', type: '즉시', v: [0.05, 0.08, 0.12, 0.2], needsSym: true,
    desc: (v, c) => `다음 라운드 시작과 함께 ${c.symName} 주가를 약 -${pctS(v)} 떨어뜨립니다. 경쟁자를 노리세요.`,
    apply: (m, p, v, c) => { m.push(c.sym, -v, 12); },
  },
  {
    id: 'freeshares', name: '스톡옵션', icon: '🎁', type: '즉시', v: [800_000, 2_000_000, 4_500_000, 10_000_000], needsSym: true,
    desc: (v, c) => `${c.symName} 주식 ${won(v)}어치를 무료로 받습니다.`,
    apply: (m, p, v, c) => {
      const s = m.symbols.get(c.sym);
      m.grantShares(p, c.sym, Math.max(1, Math.floor(v / s.last)), s.last);
    },
  },
  {
    id: 'luck', name: '행운의 부적', icon: '🍀', type: '영구', v: [1, 1.5, 2.5, 4],
    desc: (v) => `앞으로 높은 등급 카드가 나올 확률이 올라갑니다. (행운 +${v})`,
    apply: (m, p, v) => { p.mods.luck += v; },
  },
  {
    id: 'reroll', name: '다시 뽑기권', icon: '🔄', type: '횟수', v: [1, 2, 3, 5],
    desc: (v) => `카드 선택지를 새로 뽑을 수 있는 기회 ${v}회.`,
    apply: (m, p, v) => { p.mods.rerolls += v; },
  },
  {
    id: 'gamer', name: '미니게임 고수', icon: '🎮', type: '영구', v: [0.3, 0.6, 1, 2],
    desc: (v) => `미니게임 보상이 영구적으로 +${pctS(v)} 늘어납니다.`,
    apply: (m, p, v) => { p.mods.gameMult += v; },
  },
  {
    id: 'gamble', name: '도박꾼', icon: '🎲', type: '즉시', v: [null, [0.4, 0.25], [0.6, 0.25], [1, 0.2]], minRarity: 1,
    desc: ([up, down]) => `50% 확률로 현금 +${pctS(up)}, 50% 확률로 현금 -${pctS(down)}.`,
    apply: (m, p, [up, down]) => {
      const free = p.cash - p.reservedCash;
      const win = Math.random() < 0.5;
      m.addCash(p, win ? free * up : -free * down);
      return win ? `🎲 도박 성공! 현금 +${pctS(up)}` : `🎲 도박 실패… 현금 -${pctS(down)}`;
    },
  },
];
const BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));

function rollRarity(luck) {
  const w = RARITIES.map((r, i) => (i === 0 ? Math.max(15, r.weight - 8 * luck) : r.weight + [0, 4, 3, 1.2][i] * luck));
  let x = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) { x -= w[i]; if (x < 0) return i; }
  return 0;
}

// 플레이어에게 보여줄 카드 3장
function drawOptions(market, p, n = 3) {
  const out = [];
  const used = new Set();
  const syms = [...market.symbols.values()];
  while (out.length < n) {
    const rarity = rollRarity(p.mods.luck);
    const pool = CARDS.filter((c) => !used.has(c.id) && rarity >= (c.minRarity || 0) && !(c.id === 'nofee' && p.mods.feeFree));
    if (!pool.length) break;
    const card = pool[Math.floor(Math.random() * pool.length)];
    used.add(card.id);
    const opt = { id: card.id, rarity };
    if (card.needsSym) opt.sym = syms[Math.floor(Math.random() * syms.length)].code;
    out.push(opt);
  }
  return out;
}

function ctxFor(market, p, opt, extra = {}) {
  const s = opt.sym && market.symbols.get(opt.sym);
  return { p, sym: opt.sym, symName: s ? s.name : '', ...extra };
}

// 클라이언트에 보낼 카드 설명
function describe(market, p, opt) {
  const card = BY_ID[opt.id];
  const v = card.v[opt.rarity];
  return {
    id: card.id, name: card.name, icon: card.icon, type: card.type, rarity: opt.rarity,
    rarityName: RARITIES[opt.rarity].name, rarityKey: RARITIES[opt.rarity].key, sym: opt.sym || null,
    desc: card.desc(v, ctxFor(market, p, opt)),
  };
}

function applyCard(market, p, opt, extra) {
  const card = BY_ID[opt.id];
  const info = describe(market, p, opt);
  const msg = card.apply(market, p, card.v[opt.rarity], ctxFor(market, p, opt, extra));
  p.cards.push({ id: card.id, name: card.name, icon: card.icon, rarity: opt.rarity, rarityKey: info.rarityKey, desc: info.desc });
  market.dirty.add(p.id);
  return { info, msg };
}

module.exports = { CARDS, RARITIES, drawOptions, describe, applyCard };
