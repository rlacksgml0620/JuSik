'use strict';
(() => {
  const FEE = 0.00015, TAX = 0.0018, KST = 9 * 3600, START = 10_000_000;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n == null || isNaN(n) ? '-' : Math.round(n).toLocaleString('ko-KR'));
  const pct = (n) => (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const hhmmss = (ts) => { const d = new Date(ts + KST * 1000); return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':'); };
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const tickSize = (p) => (p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} },
  };
  const getSession = () => { try { return JSON.parse(store.get('jusik.session')); } catch { return null; } };

  const S = {
    ws: null, offset: 0, you: null, code: null, room: null,
    symbols: [], md: {}, sym: null, tf: 5, base: [], account: null,
    side: 'buy', otype: 'limit', tape: [], news: [], reqId: 1,
    draft: null, mg: null, mgGame: null, mgSubmitted: false, result: null,
  };
  const serverNow = () => Date.now() + S.offset;

  // ---------- 화면 ----------
  function showScreen(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  }
  function showOverlay(id, on) { $(id).classList.toggle('hidden', !on); }

  // ---------- 차트 ----------
  const chart = LightweightCharts.createChart($('chart'), {
    layout: { background: { color: 'transparent' }, textColor: '#8b93a3', fontFamily: 'Noto Sans KR, sans-serif' },
    grid: { vertLines: { color: '#222733' }, horzLines: { color: '#222733' } },
    rightPriceScale: { borderColor: '#2a303c' },
    timeScale: { borderColor: '#2a303c', timeVisible: true, secondsVisible: true, rightOffset: 6 },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: { priceFormatter: (p) => fmt(p) },
    autoSize: true,
  });
  const candles = chart.addCandlestickSeries({
    upColor: '#f0465a', downColor: '#3d7bff', borderUpColor: '#f0465a', borderDownColor: '#3d7bff',
    wickUpColor: '#f0465a', wickDownColor: '#3d7bff', priceFormat: { type: 'price', precision: 0, minMove: 1 },
  });
  const volume = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' } });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  let avgLine = null;

  const baseTf = () => (S.tf < 60 ? 5 : 60);
  function aggregate(base, tf) {
    const out = [];
    for (const c of base) {
      const t = Math.floor(c.time / tf) * tf;
      const last = out[out.length - 1];
      if (last && last.time === t) {
        last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low);
        last.close = c.close; last.volume += c.volume;
      } else out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    }
    return out;
  }
  const toBar = (c) => ({ time: c.time + KST, open: c.open, high: c.high, low: c.low, close: c.close });
  const toVol = (c) => ({ time: c.time + KST, value: c.volume, color: c.close >= c.open ? 'rgba(240,70,90,.45)' : 'rgba(61,123,255,.45)' });
  function setChartData() {
    const agg = aggregate(S.base, S.tf);
    candles.setData(agg.map(toBar));
    volume.setData(agg.map(toVol));
  }
  function updateChart(c) {
    if (!c) return;
    const last = S.base[S.base.length - 1];
    if (last && last.time === c.time) S.base[S.base.length - 1] = c;
    else if (!last || c.time > last.time) S.base.push(c);
    else return;
    const t = Math.floor(c.time / S.tf) * S.tf;
    const bucket = [];
    for (let i = S.base.length - 1; i >= 0 && S.base[i].time >= t; i--) bucket.unshift(S.base[i]);
    const a = aggregate(bucket, S.tf)[0];
    if (a) { candles.update(toBar(a)); volume.update(toVol(a)); }
  }
  function loadHistory() {
    S.base = [];
    candles.setData([]); volume.setData([]);
    send({ t: 'history', sym: S.sym, tf: baseTf() });
  }
  function updateAvgLine() {
    const ps = S.account && S.account.positions[S.sym];
    if (avgLine) { candles.removePriceLine(avgLine); avgLine = null; }
    if (ps && ps.qty > 0) avgLine = candles.createPriceLine({ price: ps.avgCost, color: '#ffd166', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '평균단가' });
  }

  // ---------- 네트워크 ----------
  let retry = 0;
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => {
      retry = 0;
      const sess = getSession();
      if (sess) send({ t: 'rejoin', code: sess.code, token: sess.token });
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => { setTimeout(connect, Math.min(8000, 500 * 2 ** retry++)); toast('서버 연결이 끊겼습니다. 재연결 중…', 'err'); };
  }
  const send = (m) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); };

  function onMessage(m) {
    switch (m.t) {
      case 'rooms': renderRooms(m.rooms); break;
      case 'joined':
        S.you = m.you; S.code = m.code;
        store.set('jusik.session', JSON.stringify({ code: m.code, token: m.token }));
        store.set('jusik.name', m.name);
        history.replaceState(null, '', '#' + m.code);
        $('chat').innerHTML = ''; $('waitChat').innerHTML = '';
        break;
      case 'rejoinFailed': store.set('jusik.session', null); showScreen('lobbyScreen'); break;
      case 'left':
        S.room = null; S.code = null; S.account = null; store.set('jusik.session', null);
        history.replaceState(null, '', location.pathname);
        ['draftOverlay', 'mgOverlay', 'resultOverlay'].forEach((o) => showOverlay(o, false));
        showScreen('lobbyScreen');
        break;
      case 'room': onRoom(m); break;
      case 'game': onGame(m); break;
      case 'account': setAccount(m.account); break;
      case 'history':
        if (m.sym === S.sym && m.tf === baseTf()) { S.base = m.candles.slice(); setChartData(); chart.timeScale().scrollToRealTime(); }
        break;
      case 'md': onMarketData(m); break;
      case 'chat': addChat(m.item); break;
      case 'chatlog': $('chat').innerHTML = ''; $('waitChat').innerHTML = ''; m.items.forEach(addChat); break;
      case 'news': S.news.unshift(m.item); renderNews(); showTicker(`📰 ${m.item.title}`); break;
      case 'event': onEvent(m); break;
      case 'draft': S.draft = m; renderDraft(); break;
      case 'picked': onPicked(m); break;
      case 'minigame': onMinigame(m); break;
      case 'mgresult': showMgResult(m); break;
      case 'final': showFinal(m); break;
      case 'ack': setMsg(''); break;
      case 'error':
        if (!S.room) $('lobbyMsg').textContent = m.msg;
        else if (S.room.phase === 'lobby') $('waitMsg').textContent = m.msg;
        else { setMsg(m.msg); toast(m.msg, 'err'); }
        break;
    }
  }

  // ---------- 방 상태 ----------
  function onRoom(r) {
    S.offset = r.now - Date.now();
    const prev = S.room;
    S.room = r;
    const isHost = r.hostId === S.you;
    if (r.phase === 'lobby') {
      showScreen('waitScreen');
      ['draftOverlay', 'mgOverlay', 'resultOverlay'].forEach((o) => showOverlay(o, false));
      $('waitCode').textContent = r.code;
      $('waitPlayers').innerHTML = r.players.map((p) => `<li>${p.id === r.hostId ? '👑' : '👤'} ${esc(p.name)}${p.id === S.you ? ' <span class="muted">(나)</span>' : ''}${p.online ? '' : ' <span class="muted">(오프라인)</span>'}</li>`).join('');
      for (const [id, v, unit] of [['setRounds', r.rounds, ''], ['setSecs', r.roundSecs, '초']]) {
        const sel = $(id);
        if (![...sel.options].some((o) => o.value === String(v))) sel.add(new Option(v + unit, String(v)));
        sel.value = String(v);
      }
      $('setRounds').disabled = $('setSecs').disabled = !isHost;
      $('startBtn').disabled = !isHost;
      $('startBtn').textContent = isHost ? '게임 시작' : '방장이 시작하기를 기다리는 중…';
      return;
    }
    showScreen('gameScreen');
    if (r.phase !== 'draft') showOverlay('draftOverlay', false);
    if (r.phase !== 'minigame') { showOverlay('mgOverlay', false); if (S.mgGame) { S.mgGame.end(); S.mgGame = null; } }
    if (r.phase === 'trading' || r.phase === 'draft' || r.phase === 'minigame') showOverlay('resultOverlay', false);
    if (r.phase === 'ended' && S.result) renderFinalButtons();
    if (prev && prev.phase !== 'trading' && r.phase === 'trading' && r.round > 1) {
      showTicker(`🔔 라운드 ${r.round} 개장! 기준가가 직전 종가로 바뀌었습니다.`);
      if (S.md[S.sym] && S.otype === 'limit') setNum($('oPrice'), S.md[S.sym].last);
    }
    if (r.phase === 'draft') renderDraftWait();
    if (r.phase === 'minigame') renderMgWait();
    renderRoundInfo(); renderLb();
  }

  function renderRoundInfo() {
    const r = S.room;
    if (!r) return;
    $('roundLabel').textContent = r.phase === 'ended' ? '게임 종료' : `라운드 ${Math.max(1, r.round)} / ${r.rounds}`;
    const left = r.endsAt ? mmss(r.endsAt - serverNow()) : '';
    const label = { trading: `거래 중 ${left}`, draft: `카드 선택 ${left}`, minigame: `미니게임 ${left}`, mgresult: `미니게임 결과 ${left}`, ended: '최종 결과' }[r.phase] || '';
    $('phaseLabel').textContent = label;
    $('phaseLabel').className = 'phase ' + r.phase + (r.phase === 'trading' && r.endsAt - serverNow() < 10000 ? ' hurry' : '');
    $('pausedBadge').classList.toggle('hidden', r.phase === 'trading');
    $('submit').disabled = r.phase !== 'trading';
    if (r.phase === 'draft') $('draftTimer').textContent = mmss(r.endsAt - serverNow());
  }

  function onGame(m) {
    S.symbols = m.symbols; S.md = m.md;
    S.news = m.news || [];
    S.tape = [];
    S.result = null; S.mgSubmitted = false;
    if (!S.sym || !S.md[S.sym]) S.sym = S.symbols[0].code;
    $('symbolTabs').innerHTML = '';
    renderTabs(); selectSymbol(S.sym, true); renderNews();
  }

  function onMarketData(m) {
    S.md = m.md;
    const q = S.md[S.sym];
    if (!q) return;
    updateChart(baseTf() === 5 ? q.c5 : q.c60);
    for (const t of m.trades) if (t.sym === S.sym) S.tape.unshift(t);
    if (S.tape.length > 40) S.tape.length = 40;
    renderTabs(); renderQuote(); renderBook(); renderTape(m.trades.some((t) => t.sym === S.sym));
    renderMe(); renderPositions(); renderSummary();
  }

  function onEvent(e) {
    if (e.kind === 'fill') {
      const extra = e.side === 'sell' && e.pnl != null ? ` (손익 <span class="${cls(e.pnl)}">${fmt(e.pnl)}</span>)` : '';
      toast(`<b>${esc(symName(e.sym))}</b> ${fmt(e.qty)}주 ${e.side === 'buy' ? '매수' : '매도'} 체결 @${fmt(e.price)}${extra}`, e.side);
    } else if (e.kind === 'buff') toast(esc(e.text), 'gold');
    else if (e.kind === 'insider') {
      const msg = `🕵️ 내부자 정보 (${e.inSec}초 뒤 공개): ${e.title}`;
      showTicker(msg, 'insider'); toast(esc(msg), 'gold');
    }
  }

  // ---------- 계산 ----------
  const symName = (c) => (S.symbols.find((s) => s.code === c) || {}).name || c;
  const chg = (q) => (q.last / q.ref - 1) * 100;
  function adjust(acc, pnl) {
    let v = pnl * acc.mods.leverage;
    if (v < 0) v *= acc.mods.lossMult;
    return v;
  }
  function equityOf(acc) {
    let v = acc.cash;
    for (const [k, p] of Object.entries(acc.positions)) {
      if (!p.qty || !S.md[k]) continue;
      const val = p.qty * S.md[k].last, base = val - p.qty * p.avgCost;
      v += val + adjust(acc, base) - base;
    }
    return Math.max(0, v);
  }

  // ---------- 렌더링: 시세 ----------
  function renderTabs() {
    const box = $('symbolTabs');
    if (box.children.length !== S.symbols.length) {
      box.innerHTML = S.symbols.map((s) => `<button class="sym-tab" data-sym="${s.code}"><span class="n">${esc(s.name)}</span><span class="p"></span></button>`).join('');
    }
    for (const el of box.children) {
      const q = S.md[el.dataset.sym];
      if (!q) continue;
      el.classList.toggle('on', el.dataset.sym === S.sym);
      const c = chg(q);
      el.querySelector('.p').innerHTML = `<span class="${cls(c)}">${fmt(q.last)} <small>${pct(c)}</small></span>`;
    }
  }

  function renderQuote() {
    const q = S.md[S.sym];
    const c = chg(q), d = q.last - q.ref;
    $('qName').textContent = q.name;
    $('qCode').textContent = `${q.code} · ${q.sector}`;
    $('qPrice').innerHTML = `<span class="${cls(c)}">${fmt(q.last)}<small>${d > 0 ? '▲' : d < 0 ? '▼' : ''} ${fmt(Math.abs(d))} (${pct(c)})</small></span>`;
    $('qStats').innerHTML = `<span>고가 <b class="up">${fmt(q.high)}</b></span><span>저가 <b class="down">${fmt(q.low)}</b></span><span>거래량 <b>${fmt(q.volume)}</b></span><span>상한 <b>${fmt(q.upper)}</b> 하한 <b>${fmt(q.lower)}</b></span>`;
  }

  function renderBook() {
    const q = S.md[S.sym];
    const asks = q.asks.slice(0, 10).reverse(), bids = q.bids.slice(0, 10);
    const max = Math.max(1, ...asks.map((r) => r[1]), ...bids.map((r) => r[1]));
    const mine = new Set(S.account ? S.account.orders.filter((o) => o.sym === S.sym).map((o) => o.price) : []);
    const row = (r, k) => {
      const qty = `<span class="q">${fmt(r[1])}</span>`;
      return `<div class="row ${k}${r[0] === q.last ? ' cur' : ''}" data-price="${r[0]}"><span class="bar" style="width:${(r[1] / max) * 33.3}%"></span>${k === 'ask' ? qty : ''}<span class="price ${cls(r[0] - q.ref)}${mine.has(r[0]) ? ' mine' : ''}">${fmt(r[0])}</span>${k === 'bid' ? qty : ''}</div>`;
    };
    $('book').innerHTML = asks.map((r) => row(r, 'ask')).join('') + '<div class="mid"></div>' + bids.map((r) => row(r, 'bid')).join('');
  }

  function renderTape(flash) {
    $('tape').innerHTML = S.tape.slice(0, 14).map((t, i) =>
      `<div class="${flash && i === 0 ? 'flash' : ''}"><span class="muted">${hhmmss(t.ts)}</span><span class="${t.side === 'buy' ? 'up' : 'down'}">${fmt(t.price)}</span><span>${fmt(t.qty)}</span></div>`).join('');
  }

  // ---------- 렌더링: 내 계좌 ----------
  function renderMe() {
    if (!S.account) { $('meBox').innerHTML = ''; return; }
    const eq = equityOf(S.account), r = (eq / START - 1) * 100;
    $('meBox').innerHTML = `${esc(S.account.name)} · 총자산 <b class="${cls(r)}">${fmt(eq)}원</b> <span class="${cls(r)}">${pct(r)}</span>`;
  }

  function renderBuffs() {
    const a = S.account;
    if (!a) return;
    const m = a.mods, chips = [];
    if (m.leverage !== 1) chips.push(['📈', `레버리지 x${m.leverage}`, '모든 손익이 배율만큼 커집니다']);
    if (m.lossMult < 1) chips.push(['🛡️', `손실 -${Math.round((1 - m.lossMult) * 100)}%`, '손실 감소']);
    if (m.feeFree) chips.push(['💳', '수수료 면제', '수수료·거래세 0원']);
    if (m.scalpUntil > serverNow()) chips.push(['⚡', `단타 ${Math.ceil((m.scalpUntil - serverNow()) / 1000)}초`, `손실 무효화 ${Math.round(m.scalpSave * 100)}% · 수익 +${Math.round(m.scalpBonus * 100)}%`]);
    if (m.insider > 0) chips.push(['🕵️', `내부자 ${m.insider}회`, '다음 뉴스를 15초 먼저 받습니다']);
    if (m.interest > 0) chips.push(['🏦', `이자 ${(m.interest * 100).toFixed(1)}%`, '라운드마다 현금 이자']);
    if (m.dividend > 0) chips.push(['🌾', `배당 ${(m.dividend * 100).toFixed(1)}%`, '라운드마다 보유주식 배당']);
    if (m.luck > 0) chips.push(['🍀', `행운 ${m.luck}`, '높은 등급 카드 확률 증가']);
    if (m.rerolls > 0) chips.push(['🔄', `리롤 ${m.rerolls}`, '카드 다시 뽑기']);
    if (m.gameMult > 1) chips.push(['🎮', `미니게임 x${m.gameMult.toFixed(1)}`, '미니게임 보상 증가']);
    $('buffs').innerHTML = chips.length ? chips.map(([i, t, d]) => `<span class="buff" title="${esc(d)}">${i} ${esc(t)}</span>`).join('') : '<span class="muted">아직 카드 효과가 없습니다. 라운드가 끝나면 카드를 고릅니다.</span>';
    $('myCards').innerHTML = a.cards.length ? a.cards.slice().reverse().map((c) => `<li class="r-${c.rarityKey}"><b>${c.icon} ${esc(c.name)}</b><span>${esc(c.desc)}</span></li>`).join('') : '<li class="muted">획득한 카드가 없습니다</li>';
  }

  function renderPositions() {
    const a = S.account;
    if (!a) return;
    const rows = Object.entries(a.positions).filter(([, p]) => p.qty > 0);
    const head = '<tr><th>종목</th><th>보유</th><th>매도가능</th><th>평균단가</th><th>현재가</th><th>평가금액</th><th>평가손익</th><th>수익률</th></tr>';
    let totalVal = 0;
    const body = rows.map(([k, p]) => {
      const last = S.md[k] ? S.md[k].last : 0, val = p.qty * last, cost = p.qty * p.avgCost;
      const fee = a.mods.feeFree ? 0 : val * (FEE + TAX);
      const pnl = adjust(a, val - cost - fee), r = cost ? (pnl / cost) * 100 : 0;
      totalVal += val;
      return `<tr class="click" data-sym="${k}"><td>${esc(symName(k))}</td><td>${fmt(p.qty)}</td><td>${fmt(p.qty - p.reserved)}</td><td>${fmt(p.avgCost)}</td><td>${fmt(last)}</td><td>${fmt(val)}</td><td class="${cls(pnl)}">${fmt(pnl)}</td><td class="${cls(r)}">${pct(r)}</td></tr>`;
    }).join('');
    const sum = `<tr><td class="muted" colspan="5">예수금 ${fmt(a.cash)} · 주문가능 ${fmt(a.cash - a.reservedCash)}</td><td>${fmt(totalVal)}</td><td colspan="2" class="muted">실현손익 <span class="${cls(a.realized)}">${fmt(a.realized)}</span></td></tr>`;
    $('posTable').innerHTML = head + (body || '<tr><td colspan="8" class="empty">보유 종목이 없습니다</td></tr>') + sum;
  }

  function renderOrders() {
    const a = S.account;
    const head = `<tr><th>종목</th><th>구분</th><th>주문가</th><th>주문수량</th><th>미체결</th><th>시간</th><th>${a.orders.length ? '<button data-cancel-all>전체취소</button>' : ''}</th></tr>`;
    const body = a.orders.map((o) => `<tr><td>${esc(symName(o.sym))}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? '매수' : '매도'}</td><td>${fmt(o.price)}</td><td>${fmt(o.qty)}</td><td>${fmt(o.qty - o.filled)}</td><td class="muted">${hhmmss(o.ts)}</td><td><button data-cancel="${o.id}">취소</button></td></tr>`).join('');
    $('openTable').innerHTML = head + (body || '<tr><td colspan="7" class="empty">미체결 주문이 없습니다 (라운드 종료 시 자동 취소)</td></tr>');
    $('openCount').textContent = a.orders.length ? `(${a.orders.length})` : '';
  }

  function renderHistory() {
    const a = S.account;
    const head = '<tr><th>시간</th><th>종목</th><th>구분</th><th>체결가</th><th>수량</th><th>금액</th><th>수수료·세금</th><th>실현손익</th></tr>';
    const body = a.history.map((h) => `<tr><td class="muted">${hhmmss(h.ts)}</td><td>${esc(symName(h.sym))}</td><td class="${h.side === 'buy' ? 'up' : 'down'}">${h.side === 'buy' ? '매수' : '매도'}</td><td>${fmt(h.price)}</td><td>${fmt(h.qty)}</td><td>${fmt(h.price * h.qty)}</td><td>${fmt(h.fee)}</td><td class="${cls(h.pnl || 0)}">${h.pnl != null ? fmt(h.pnl) : ''}</td></tr>`).join('');
    $('histTable').innerHTML = head + (body || '<tr><td colspan="8" class="empty">체결 내역이 없습니다</td></tr>');
  }

  function renderLb() {
    const r = S.room;
    if (!r || !r.standings) return;
    const online = Object.fromEntries(r.players.map((p) => [p.id, p.online]));
    $('lb').innerHTML = r.standings.map((row, i) => `<li class="${row.id === S.you ? 'mine-row' : ''}"><span class="rank">${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</span><span class="nm">${esc(row.name)}${online[row.id] ? '' : ' 💤'}<small class="muted">${row.leverage !== 1 ? ` x${row.leverage}` : ''} · 카드 ${row.cards}</small></span><span class="eq">${fmt(row.equity)}<small class="${cls(row.ret)}">${pct(row.ret)}</small></span></li>`).join('');
  }

  function renderNews() {
    $('news').innerHTML = S.news.map((n) => `<li><time>${hhmmss(n.ts)} · ${esc(symName(n.sym))}</time>${esc(n.title)}</li>`).join('') || '<li class="muted">아직 뉴스가 없습니다</li>';
  }

  function addChat(item) {
    for (const el of [$('chat'), $('waitChat')]) {
      const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
      const d = document.createElement('div');
      d.innerHTML = item.name ? `<span class="muted">${hhmmss(item.ts).slice(0, 5)}</span> <b>${esc(item.name)}</b>${esc(item.text)}` : `<i class="sys">${esc(item.text)}</i>`;
      el.appendChild(d);
      while (el.children.length > 100) el.firstChild.remove();
      if (stick) el.scrollTop = el.scrollHeight;
    }
  }

  let tickerTimer;
  function showTicker(text, kind = '') {
    const el = $('ticker');
    el.textContent = text;
    el.className = `news-ticker show ${kind}`;
    clearTimeout(tickerTimer);
    tickerTimer = setTimeout(() => el.classList.remove('show'), 7000);
  }

  function toast(html, kind = '') {
    const d = document.createElement('div');
    d.className = `toast ${kind}`;
    d.innerHTML = html;
    $('toasts').appendChild(d);
    setTimeout(() => d.remove(), 4500);
    while ($('toasts').children.length > 5) $('toasts').firstChild.remove();
  }

  function setAccount(acc) {
    S.account = acc;
    renderMe(); renderPositions(); renderOrders(); renderHistory(); renderSummary(); renderBuffs(); updateAvgLine();
    if (S.md[S.sym]) renderBook();
  }

  // ---------- 카드 선택 ----------
  function renderDraft() {
    const d = S.draft;
    showOverlay('draftOverlay', true);
    $('draftTimer').textContent = mmss(d.endsAt - serverNow());
    $('draftSub').textContent = `라운드 ${S.room ? S.room.round : ''} 종료! 다음 라운드에 가져갈 카드 1장을 고르세요. 시간이 지나면 무작위로 선택됩니다.`;
    $('cardRow').innerHTML = d.options.map((c, i) => `
      <button class="card r-${c.rarityKey}${d.picked === i ? ' chosen' : ''}${d.picked != null && d.picked !== i ? ' faded' : ''}" data-idx="${i}" ${d.picked != null ? 'disabled' : ''}>
        <span class="rarity">${c.rarityName}</span>
        <span class="icon">${c.icon}</span>
        <span class="name">${esc(c.name)}</span>
        <span class="ctype">${c.type}${c.sym ? ' · ' + esc(symName(c.sym)) : ''}</span>
        <span class="desc">${esc(c.desc)}</span>
      </button>`).join('');
    $('rerollCount').textContent = d.rerolls;
    $('rerollBtn').disabled = d.rerolls <= 0 || d.picked != null;
    renderDraftWait();
  }
  function renderDraftWait() {
    const r = S.room;
    if (!r || r.phase !== 'draft') return;
    const done = r.players.filter((p) => p.picked).length;
    $('draftWait').textContent = `선택 완료 ${done}/${r.players.length}`;
  }
  function onPicked(m) {
    if (S.draft) { S.draft.picked = S.draft.options.findIndex((o) => o.id === m.card.id && o.rarity === m.card.rarity); renderDraft(); }
    toast(`${m.card.icon} <b>${esc(m.card.name)}</b> (${m.card.rarityName}) 획득!`, 'gold');
    if (m.msg) toast(esc(m.msg), 'gold');
  }

  // ---------- 미니게임 ----------
  function onMinigame(m) {
    S.mg = m;
    const info = Minigames.INFO[m.game];
    showOverlay('resultOverlay', false);
    showOverlay('mgOverlay', true);
    $('mgTitle').textContent = `${m.name} 미니게임 · ${info.title}`;
    $('mgSub').textContent = `${info.how}  순위 보상: ${m.name} 주식 (1위 약 ${fmt(m.rewards[0])}원어치)`;
    if (m.done.includes(S.you)) { S.mgSubmitted = true; $('mgStage').innerHTML = '<div class="mg-wait">점수 제출 완료! 결과를 기다리는 중…</div>'; return; }
    if (S.mgGame && S.mgSeed === m.seed) return; // 이미 진행 중
    S.mgSeed = m.seed; S.mgSubmitted = false;
    $('mgScore').textContent = '0';
    S.mgGame = Minigames.create($('mgStage'), m.game, m.seed, (s) => { $('mgScore').textContent = fmt(s); }, (s) => submitMg(s));
    S.mgStarted = false;
    $('mgStage').insertAdjacentHTML('beforeend', '<div class="mg-count" id="mgCount"></div>');
    renderMgWait();
  }
  function submitMg(score) {
    if (S.mgSubmitted) return;
    S.mgSubmitted = true;
    send({ t: 'mgscore', score });
    $('mgWait').textContent = '점수 제출 완료! 다른 플레이어를 기다리는 중…';
  }
  function tickMinigame() {
    const m = S.mg;
    if (!m || !S.room || S.room.phase !== 'minigame' || !S.mgGame) return;
    const now = serverNow();
    const cnt = $('mgCount');
    if (now < m.startAt) {
      if (cnt) cnt.textContent = Math.ceil((m.startAt - now) / 1000);
      $('mgTimer').textContent = mmss(m.playMs);
      return;
    }
    if (!S.mgStarted) { S.mgStarted = true; if (cnt) cnt.remove(); S.mgGame.start(); }
    const left = m.startAt + m.playMs - now;
    $('mgTimer').textContent = mmss(left);
    if (left <= 0 && !S.mgSubmitted) submitMg(S.mgGame.end());
  }
  function renderMgWait() {
    const r = S.room;
    if (!r || r.phase !== 'minigame') return;
    const done = r.players.filter((p) => p.submitted).length;
    if (!S.mgSubmitted) $('mgWait').textContent = `제출 ${done}/${r.players.length}`;
  }

  // ---------- 결과 ----------
  function showMgResult(m) {
    showOverlay('mgOverlay', false);
    if (S.mgGame) { S.mgGame.end(); S.mgGame = null; }
    showOverlay('resultOverlay', true);
    $('resultBox').innerHTML = `<h2>🎮 ${esc(m.name)} 미니게임 결과</h2>
      <table class="grid big"><tr><th>순위</th><th>이름</th><th>점수</th><th>보상</th></tr>
      ${m.rows.map((r) => `<tr class="${r.id === S.you ? 'mine-row' : ''}"><td>${r.rank}</td><td>${esc(r.name)}</td><td>${fmt(r.score)}</td><td>${r.shares ? `${esc(m.name)} ${fmt(r.shares)}주 <span class="muted">(${fmt(r.value)}원)</span>` : '<span class="muted">없음</span>'}</td></tr>`).join('')}</table>
      <p class="muted">곧 다음 라운드가 시작됩니다…</p>`;
  }

  function showFinal(m) {
    S.result = m;
    ['draftOverlay', 'mgOverlay'].forEach((o) => showOverlay(o, false));
    showOverlay('resultOverlay', true);
    const medal = ['🥇', '🥈', '🥉'];
    $('resultBox').innerHTML = `<h2>🏆 최종 순위</h2>
      <table class="grid big"><tr><th>순위</th><th>이름</th><th>총자산</th><th>수익</th><th>카드 빌드</th></tr>
      ${m.rows.map((r, i) => `<tr class="${r.id === S.you ? 'mine-row' : ''}"><td>${medal[i] || r.rank}</td><td>${esc(r.name)}</td><td>${fmt(r.equity)}원</td><td class="${cls(r.profit)}">${r.profit > 0 ? '+' : ''}${fmt(r.profit)}원 (${pct(r.ret)})</td><td class="build">${r.cardList.map((c) => `<span class="r-${c.rarityKey}" title="${esc(c.name)}">${c.icon}</span>`).join('')}</td></tr>`).join('')}</table>
      <div class="lobby-actions" id="finalBtns"></div>`;
    renderFinalButtons();
  }
  function renderFinalButtons() {
    const box = $('finalBtns');
    if (!box || !S.room) return;
    const host = S.room.hostId === S.you;
    box.innerHTML = (host ? '<button class="primary" data-act="again">한 판 더</button><button data-act="lobby">대기실로</button>' : '<span class="muted">방장이 다음 게임을 시작할 수 있습니다</span>') + '<button data-act="leave">나가기</button>';
  }
  $('resultOverlay').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'again') send({ t: 'start' });
    if (b.dataset.act === 'lobby') send({ t: 'lobby' });
    if (b.dataset.act === 'leave') send({ t: 'leave' });
  });

  // ---------- 로비 ----------
  function renderRooms(list) {
    const phaseName = { lobby: '대기 중', trading: '게임 중', draft: '게임 중', minigame: '게임 중', mgresult: '게임 중', ended: '종료' };
    $('roomList').innerHTML = list.length ? list.map((r) => `<li><span class="code">${r.code}</span><span>👑 ${esc(r.host)}</span><span class="muted">${r.players}/${r.max}명 · ${phaseName[r.phase]}${r.phase !== 'lobby' && r.phase !== 'ended' ? ` (R${r.round}/${r.rounds})` : ''}</span>${r.phase === 'lobby' ? `<button data-join="${r.code}">입장</button>` : ''}</li>`).join('') : '<li class="muted">열린 방이 없습니다. 방을 만들어 보세요!</li>';
  }
  const lobbyName = () => {
    const n = $('nameInput').value.trim();
    if (!n) { $('lobbyMsg').textContent = '닉네임을 입력하세요.'; $('nameInput').focus(); return null; }
    $('lobbyMsg').textContent = '';
    return n;
  };
  $('createBtn').onclick = () => { const name = lobbyName(); if (name) send({ t: 'create', name }); };
  $('joinBtn').onclick = () => { const name = lobbyName(); const code = $('codeInput').value.trim(); if (name && code) send({ t: 'join', name, code }); };
  $('roomList').addEventListener('click', (e) => { const b = e.target.closest('[data-join]'); if (!b) return; const name = lobbyName(); if (name) send({ t: 'join', name, code: b.dataset.join }); });
  $('refreshRooms').onclick = () => send({ t: 'rooms' });
  $('startBtn').onclick = () => { $('waitMsg').textContent = ''; send({ t: 'start' }); };
  $('leaveBtn').onclick = () => send({ t: 'leave' });
  $('copyLink').onclick = () => {
    const url = `${location.origin}${location.pathname}#${S.code}`;
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('링크를 복사했습니다'), () => prompt('링크', url));
  };
  const sendSettings = () => send({ t: 'settings', rounds: Number($('setRounds').value), roundSecs: Number($('setSecs').value) });
  $('setRounds').onchange = sendSettings; $('setSecs').onchange = sendSettings;
  $('nameInput').value = store.get('jusik.name') || '';
  if (location.hash.length === 5) $('codeInput').value = location.hash.slice(1).toUpperCase();

  // ---------- 주문 폼 ----------
  const priceIn = $('oPrice'), qtyIn = $('oQty');
  const num = (el) => Number(String(el.value).replace(/[^\d]/g, '')) || 0;
  const setNum = (el, n) => { el.value = n ? n.toLocaleString('ko-KR') : ''; };

  function orderPrice() {
    const q = S.md[S.sym];
    if (S.otype === 'limit') return num(priceIn);
    if (S.side === 'buy') return q.asks[0] ? q.asks[0][0] : q.last;
    return q.bids[0] ? q.bids[0][0] : q.last;
  }
  function maxQty() {
    if (!S.account) return 0;
    if (S.side === 'buy') {
      const p = orderPrice(), fee = S.account.mods.feeFree ? 0 : FEE;
      return p ? Math.floor((S.account.cash - S.account.reservedCash) / (p * (1 + fee))) : 0;
    }
    const ps = S.account.positions[S.sym];
    return ps ? ps.qty - ps.reserved : 0;
  }
  function renderSummary() {
    if (!S.md[S.sym]) return;
    const a = S.account;
    if (S.side === 'buy') { $('availLabel').textContent = '주문가능 금액'; $('avail').textContent = a ? `${fmt(a.cash - a.reservedCash)}원` : '-'; }
    else { $('availLabel').textContent = '매도가능 수량'; $('avail').textContent = a ? `${fmt(maxQty())}주` : '-'; }
    $('oTotal').textContent = `${S.otype === 'market' ? '약 ' : ''}${fmt(orderPrice() * num(qtyIn))}원`;
  }
  function setSide(side) {
    S.side = side;
    document.querySelectorAll('.side-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.side === side));
    $('submit').className = `submit ${side}`;
    $('submit').textContent = side === 'buy' ? '매수' : '매도';
    renderSummary();
  }
  function setType(t) {
    S.otype = t;
    document.querySelector(`input[name="otype"][value="${t}"]`).checked = true;
    priceIn.disabled = t === 'market';
    if (t === 'market') priceIn.value = '시장가'; else setNum(priceIn, S.md[S.sym].last);
    renderSummary();
  }
  function selectSymbol(code, force) {
    if (code === S.sym && !force) return;
    S.sym = code;
    S.tape = [];
    renderTabs(); renderQuote(); renderBook(); renderTape();
    if (S.otype === 'limit') setNum(priceIn, S.md[code].last);
    loadHistory(); updateAvgLine(); renderSummary();
  }
  function stepPrice(dir) {
    if (S.otype !== 'limit') return;
    let p = num(priceIn) || S.md[S.sym].last;
    p = dir > 0 ? p + tickSize(p) : p - tickSize(p - 1);
    const q = S.md[S.sym];
    p = Math.min(q.upper, Math.max(q.lower, p));
    setNum(priceIn, Math.round(p / tickSize(p)) * tickSize(p)); renderSummary();
  }
  function setMsg(t) { $('orderMsg').textContent = t; }

  // ---------- 이벤트 바인딩 ----------
  $('symbolTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-sym]'); if (b) selectSymbol(b.dataset.sym); });
  $('tfBtns').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tf]'); if (!b) return;
    const prevBase = baseTf();
    S.tf = Number(b.dataset.tf);
    $('tfBtns').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    chart.applyOptions({ timeScale: { secondsVisible: S.tf < 60 } });
    if (prevBase !== baseTf()) loadHistory(); else setChartData();
  });
  document.querySelectorAll('.side-tabs button').forEach((b) => b.addEventListener('click', () => setSide(b.dataset.side)));
  document.querySelectorAll('input[name="otype"]').forEach((r) => r.addEventListener('change', () => setType(r.value)));
  $('pUp').onclick = () => stepPrice(1);
  $('pDown').onclick = () => stepPrice(-1);
  $('qUp').onclick = () => { setNum(qtyIn, num(qtyIn) + 1); renderSummary(); };
  $('qDown').onclick = () => { setNum(qtyIn, Math.max(1, num(qtyIn) - 1)); renderSummary(); };
  [priceIn, qtyIn].forEach((el) => el.addEventListener('input', () => { if (el.value !== '') setNum(el, num(el)); renderSummary(); }));
  document.querySelector('.pct').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pct]'); if (!b) return;
    setNum(qtyIn, Math.max(0, Math.floor(maxQty() * Number(b.dataset.pct) / 100))); renderSummary();
  });
  $('book').addEventListener('click', (e) => {
    const r = e.target.closest('[data-price]'); if (!r) return;
    if (S.otype !== 'limit') setType('limit');
    setNum(priceIn, Number(r.dataset.price)); renderSummary();
  });
  $('submit').addEventListener('click', () => {
    const qty = num(qtyIn);
    if (!qty) { setMsg('수량을 입력하세요.'); return; }
    const o = { t: 'order', req: S.reqId++, sym: S.sym, side: S.side, type: S.otype, qty };
    if (S.otype === 'limit') o.price = num(priceIn);
    send(o);
    setMsg('주문 전송…');
  });
  $('posTable').addEventListener('click', (e) => { const r = e.target.closest('[data-sym]'); if (r) selectSymbol(r.dataset.sym); });
  $('openTable').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cancel]'); if (b) send({ t: 'cancel', id: Number(b.dataset.cancel) });
    if (e.target.closest('[data-cancel-all]')) send({ t: 'cancelAll' });
  });
  document.querySelectorAll('.tabs').forEach((tabs) => tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    const panel = tabs.parentElement;
    tabs.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    panel.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
    if (b.dataset.tab === 'chat') $('chat').scrollTop = $('chat').scrollHeight;
  }));
  document.querySelectorAll('[data-chat]').forEach((f) => f.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = f.querySelector('input');
    const v = input.value.trim();
    if (v) send({ t: 'chat', text: v });
    input.value = '';
  }));
  $('cardRow').addEventListener('click', (e) => {
    const b = e.target.closest('[data-idx]');
    if (!b || !S.draft || S.draft.picked != null) return;
    send({ t: 'pick', idx: Number(b.dataset.idx) });
  });
  $('rerollBtn').onclick = () => send({ t: 'reroll' });

  setInterval(() => { renderRoundInfo(); tickMinigame(); if (S.account && S.account.mods.scalpUntil > serverNow() - 1000) renderBuffs(); }, 200);
  showScreen(getSession() ? 'waitScreen' : 'lobbyScreen');
  connect();
})();
