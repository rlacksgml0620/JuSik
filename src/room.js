'use strict';
// 방 하나 = 게임 한 판. 로비 → [거래 라운드 → 카드 선택 or 미니게임] × N → 최종 순위
const crypto = require('crypto');
const { Market, MarketError } = require('./market');
const { drawOptions, describe, applyCard } = require('./cards');

const FAST = !!process.env.DEV_FAST; // 테스트용: 짧은 시간 허용
const MAX_PLAYERS = 4;
const DRAFT_MS = FAST ? 6000 : 15000;
const MG_INTRO_MS = FAST ? 1500 : 4000;
const MG_PLAY_MS = 20000;
const MG_GRACE_MS = 3000;
const MG_RESULT_MS = FAST ? 3000 : 7000;
const ROUND_OPTS = [6, 10, 15];
const SECS_OPTS = [30, 45, 60];
const MG_REWARD = [2_000_000, 1_300_000, 800_000, 500_000];
const MG_LIMITS = { // 최대 점수(검증용), '잘함' 기준 점수
  chip: { max: 80, good: 28 },
  parking: { max: 500, good: 380 },
  math: { max: 60, good: 18 },
  reaction: { max: 4000, good: 2700 },
};

class Room {
  constructor(code, io) {
    this.code = code;
    this.io = io; // { sendTo(pid, msg), broadcast(room, msg) }
    this.players = new Map(); // id -> { id, name, token, online }
    this.hostId = null;
    this.settings = FAST ? { rounds: 4, roundSecs: 8 } : { rounds: 10, roundSecs: 45 };
    this.chat = [];
    this.reset();
  }

  reset() {
    this.phase = 'lobby';
    this.round = 0;
    this.endsAt = 0;
    this.market = null;
    this.drafts = new Map();
    this.mg = null;
    this.mgResult = null;
    this.final = null;
    this.pausedAt = 0;
  }

  // ---------- 참가 ----------
  join(name) {
    name = String(name || '').trim();
    if (!/^[\p{L}\p{N}_\- ]{2,12}$/u.test(name)) throw new MarketError('닉네임은 2~12자의 글자/숫자만 가능합니다.');
    if (this.phase !== 'lobby') throw new MarketError('이미 게임이 진행 중인 방입니다.');
    if (this.players.size >= MAX_PLAYERS) throw new MarketError('방이 가득 찼습니다. (최대 4명)');
    for (const p of this.players.values()) if (p.name.toLowerCase() === name.toLowerCase()) throw new MarketError('방에 같은 닉네임이 있습니다.');
    const p = { id: crypto.randomUUID(), token: crypto.randomUUID(), name, online: true };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.chatSystem(`${name}님이 입장했습니다.`);
    return p;
  }

  byToken(token) {
    for (const p of this.players.values()) if (p.token === token) return p;
    return null;
  }

  leave(pid) {
    const p = this.players.get(pid);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.players.delete(pid);
      this.chatSystem(`${p.name}님이 나갔습니다.`);
    }
    if (this.hostId === pid) this._pickHost();
  }

  setOnline(pid, online) {
    const p = this.players.get(pid);
    if (!p) return;
    p.online = online;
    if (!online && this.hostId === pid) this._pickHost();
  }

  _pickHost() {
    const next = [...this.players.values()].find((p) => p.online && p.id !== this.hostId) || [...this.players.values()].find((p) => p.id !== this.hostId);
    this.hostId = next ? next.id : null;
  }

  onlineCount() { return [...this.players.values()].filter((p) => p.online).length; }

  chatSystem(text) { this.addChat({ name: null, text, ts: Date.now() }); }
  addChat(item) {
    this.chat.push(item);
    if (this.chat.length > 100) this.chat.shift();
    this.io.broadcast(this, { t: 'chat', item });
  }

  // ---------- 진행 ----------
  configure(pid, s) {
    if (pid !== this.hostId) throw new MarketError('방장만 설정할 수 있습니다.');
    if (this.phase !== 'lobby') return;
    const rounds = Number(s.rounds), secs = Number(s.roundSecs);
    if (ROUND_OPTS.includes(rounds) || (FAST && rounds > 0)) this.settings.rounds = rounds;
    if (SECS_OPTS.includes(secs) || (FAST && secs >= 3)) this.settings.roundSecs = secs;
  }

  start(pid) {
    if (pid !== this.hostId) throw new MarketError('방장만 시작할 수 있습니다.');
    if (this.phase !== 'lobby' && this.phase !== 'ended') throw new MarketError('이미 시작했습니다.');
    if (this.phase === 'ended') this.reset();
    this.market = new Market();
    for (const p of this.players.values()) this.market.addPlayer(p.id, p.name);
    this.io.broadcast(this, { t: 'game', symbols: this.market.symbolList(), md: this.market.marketData() });
    this.chatSystem('게임 시작! 라운드마다 카드를 고르고, 3라운드마다 미니게임이 열립니다.');
    this._startTrading();
  }

  backToLobby(pid) {
    if (pid !== this.hostId) throw new MarketError('방장만 할 수 있습니다.');
    if (this.phase !== 'ended') return;
    this.reset();
  }

  _startTrading() {
    const m = this.market;
    const now = Date.now();
    if (this.pausedAt) {
      const shift = now - this.pausedAt;
      m.shiftClock(shift);
      for (const p of m.players.values()) if (p.mods.scalpUntil > this.pausedAt) p.mods.scalpUntil += shift;
      this.pausedAt = 0;
    }
    this.round++;
    if (this.round > 1) m.newDay();
    m.paused = false;
    this.phase = 'trading';
    this.endsAt = now + this.settings.roundSecs * 1000;
  }

  _endTrading() {
    const m = this.market;
    m.paused = true;
    this.pausedAt = Date.now();
    // 당일 주문 만료 + 라운드 보상(이자/배당)
    for (const p of m.players.values()) {
      m.cancelAll(p);
      const parts = [];
      if (p.mods.interest > 0) {
        const v = Math.round(p.cash * p.mods.interest);
        if (v > 0) { m.addCash(p, v); parts.push(`이자 ${v.toLocaleString('ko-KR')}원`); }
      }
      if (p.mods.dividend > 0) {
        let val = 0;
        for (const [sym, ps] of Object.entries(p.positions)) val += ps.qty * m.symbols.get(sym).last;
        const v = Math.round(val * p.mods.dividend);
        if (v > 0) { m.addCash(p, v); parts.push(`배당 ${v.toLocaleString('ko-KR')}원`); }
      }
      if (parts.length) m.events.push({ playerId: p.id, msg: { kind: 'buff', text: `🏦 라운드 보상: ${parts.join(', ')}` } });
    }
    if (this.round >= this.settings.rounds) return this._end();
    if (this.round % 3 === 0) this._startMinigame();
    else this._startDraft();
  }

  // ---------- 카드 선택 ----------
  _startDraft() {
    this.phase = 'draft';
    this.endsAt = Date.now() + DRAFT_MS;
    this.drafts.clear();
    for (const p of this.market.players.values()) {
      this.drafts.set(p.id, { options: drawOptions(this.market, p), picked: null });
      this._sendDraft(p.id);
    }
  }

  _sendDraft(pid) {
    const msg = this._draftMsg(pid);
    if (msg) this.io.sendTo(pid, msg);
  }

  _draftMsg(pid) {
    const d = this.drafts.get(pid);
    const p = this.market.players.get(pid);
    if (!d || !p) return null;
    return {
      t: 'draft', endsAt: this.endsAt, rerolls: p.mods.rerolls, picked: d.picked,
      options: d.options.map((o) => describe(this.market, p, o)),
    };
  }

  pick(pid, idx) {
    if (this.phase !== 'draft') throw new MarketError('카드 선택 시간이 아닙니다.');
    const d = this.drafts.get(pid);
    if (!d || d.picked != null) return;
    const opt = d.options[Number(idx)];
    if (!opt) throw new MarketError('잘못된 카드');
    this._apply(pid, d, Number(idx));
    if ([...this.drafts.values()].every((x) => x.picked != null)) this.endsAt = Math.min(this.endsAt, Date.now() + 1200);
  }

  _apply(pid, d, idx) {
    const p = this.market.players.get(pid);
    d.picked = idx;
    const { info, msg } = applyCard(this.market, p, d.options[idx], { tradingResumeAt: Date.now() });
    this.io.sendTo(pid, { t: 'picked', card: info, msg });
    const pl = this.players.get(pid);
    if (info.rarity >= 2) this.chatSystem(`✨ ${pl.name}님이 ${info.rarityName} 카드 [${info.icon} ${info.name}]을(를) 획득했습니다!`);
  }

  reroll(pid) {
    if (this.phase !== 'draft') return;
    const d = this.drafts.get(pid);
    const p = this.market.players.get(pid);
    if (!d || d.picked != null) return;
    if (p.mods.rerolls <= 0) throw new MarketError('다시 뽑기권이 없습니다.');
    p.mods.rerolls--;
    d.options = drawOptions(this.market, p);
    this.market.dirty.add(pid);
    this._sendDraft(pid);
  }

  _endDraft() {
    for (const [pid, d] of this.drafts) if (d.picked == null) this._apply(pid, d, Math.floor(Math.random() * d.options.length));
    this.drafts.clear();
    this._startTrading();
  }

  // ---------- 미니게임 ----------
  _startMinigame() {
    const syms = this.market.symbolList();
    const s = syms[(this.round / 3 - 1) % syms.length];
    const startAt = Date.now() + MG_INTRO_MS;
    this.mg = { sym: s.code, name: s.name, game: s.game, seed: Math.floor(Math.random() * 2 ** 31), startAt, playMs: MG_PLAY_MS, scores: new Map() };
    this.phase = 'minigame';
    this.endsAt = startAt + MG_PLAY_MS + MG_GRACE_MS;
    this.io.broadcast(this, { t: 'minigame', ...this._mgPublic() });
  }

  _mgPublic() {
    const { scores, ...rest } = this.mg;
    return { ...rest, rewards: MG_REWARD, done: [...scores.keys()] };
  }

  submitScore(pid, score) {
    if (this.phase !== 'minigame' || !this.mg || this.mg.scores.has(pid)) return;
    if (Date.now() < this.mg.startAt) return;
    const lim = MG_LIMITS[this.mg.game];
    score = Math.max(0, Math.min(lim.max, Math.floor(Number(score) || 0)));
    this.mg.scores.set(pid, score);
    if ([...this.players.values()].filter((p) => p.online).every((p) => this.mg.scores.has(p.id))) {
      this.endsAt = Math.min(this.endsAt, Date.now() + 500);
    }
  }

  _endMinigame() {
    const m = this.market, mg = this.mg;
    const s = m.symbols.get(mg.sym);
    const lim = MG_LIMITS[mg.game];
    const rows = [...this.players.values()].map((p) => ({ id: p.id, name: p.name, score: mg.scores.get(p.id) ?? 0 }));
    rows.sort((a, b) => b.score - a.score);
    rows.forEach((r, i) => {
      const p = m.players.get(r.id);
      if (r.score <= 0) { r.shares = 0; r.rank = i + 1; return; }
      const base = MG_REWARD[Math.min(i, MG_REWARD.length - 1)];
      const perf = 0.5 + 0.5 * Math.min(1, r.score / lim.good);
      const value = base * perf * p.mods.gameMult;
      r.rank = i + 1;
      r.shares = Math.max(1, Math.floor(value / s.last));
      r.value = r.shares * s.last;
      m.grantShares(p, mg.sym, r.shares, s.last);
    });
    this.mgResult = { sym: mg.sym, name: mg.name, game: mg.game, rows };
    this.mg = null;
    this.phase = 'mgresult';
    this.endsAt = Date.now() + MG_RESULT_MS;
    this.io.broadcast(this, { t: 'mgresult', ...this.mgResult });
  }

  // ---------- 종료 ----------
  _end() {
    this.phase = 'ended';
    this.endsAt = 0;
    const rows = this.market.standings().map((r, i) => {
      const p = this.market.players.get(r.id);
      return { ...r, rank: i + 1, profit: r.equity - 10_000_000, realized: Math.round(p.realized), cardList: p.cards.map((c) => ({ icon: c.icon, name: c.name, rarityKey: c.rarityKey })) };
    });
    this.final = { rows };
    this.io.broadcast(this, { t: 'final', ...this.final });
    if (rows[0]) this.chatSystem(`🏆 게임 종료! 우승: ${rows[0].name} (${rows[0].equity.toLocaleString('ko-KR')}원)`);
  }

  // 250ms마다 호출
  tick() {
    const now = Date.now();
    if (this.phase === 'lobby' || this.phase === 'ended' || now < this.endsAt) return;
    if (this.phase === 'trading') this._endTrading();
    else if (this.phase === 'draft') this._endDraft();
    else if (this.phase === 'minigame') this._endMinigame();
    else if (this.phase === 'mgresult') this._startTrading();
  }

  state() {
    return {
      t: 'room', code: this.code, phase: this.phase, round: this.round, rounds: this.settings.rounds,
      roundSecs: this.settings.roundSecs, endsAt: this.endsAt, now: Date.now(), hostId: this.hostId,
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, online: p.online,
        picked: this.phase === 'draft' ? this.drafts.get(p.id)?.picked != null : undefined,
        submitted: this.phase === 'minigame' && this.mg ? this.mg.scores.has(p.id) : undefined,
      })),
      standings: this.market ? this.market.standings() : null,
    };
  }

  // 재접속한 플레이어에게 현재 상황 전체 전송
  snapshotFor(pid) {
    const msgs = [this.state(), { t: 'chatlog', items: this.chat.slice(-50) }];
    if (this.market) {
      msgs.push({ t: 'game', symbols: this.market.symbolList(), md: this.market.marketData(), news: this.market.news });
      const p = this.market.players.get(pid);
      if (p) msgs.push({ t: 'account', account: this.market.account(p) });
    }
    if (this.phase === 'draft') { const d = this._draftMsg(pid); if (d) msgs.push(d); }
    if (this.phase === 'minigame') msgs.push({ t: 'minigame', ...this._mgPublic() });
    if (this.phase === 'mgresult') msgs.push({ t: 'mgresult', ...this.mgResult });
    if (this.phase === 'ended') msgs.push({ t: 'final', ...this.final });
    return msgs;
  }

  summary() {
    const host = this.players.get(this.hostId);
    return { code: this.code, host: host ? host.name : '-', players: this.players.size, max: MAX_PLAYERS, phase: this.phase, round: this.round, rounds: this.settings.rounds };
  }
}

module.exports = { Room, MG_LIMITS };
