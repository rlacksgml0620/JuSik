'use strict';
(() => {
  const FEE = 0.00015, TAX = 0.0018, KST = 9 * 3600;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (n == null || isNaN(n) ? '-' : Math.round(n).toLocaleString('ko-KR'));
  const pct = (n) => (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const hhmmss = (ts) => { const d = new Date(ts + KST * 1000); return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':'); };
  const tickSize = (p) => (p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  const S = {
    ws: null, token: store.get('jusik.token'), name: store.get('jusik.name'),
    symbols: [], md: {}, sym: store.get('jusik.sym'), tf: 5, base: [], account: null,
    side: 'buy', otype: 'limit', tape: [], news: [], lb: null, reqId: 1, priceTouched: false,
  };

  // ---------- 차트 ----------
  const chartEl = $('chart');
  const chart = LightweightCharts.createChart(chartEl, {
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

  const baseTf = () => (S.tf === 5 ? 5 : 60);
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
    if (ps && ps.qty > 0) {
      avgLine = candles.createPriceLine({ price: ps.avgCost, color: '#ffd166', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '평균단가' });
    }
  }

  // ---------- 네트워크 ----------
  let retry = 0;
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => { retry = 0; if (S.token || S.name) send({ t: 'join', token: S.token, name: S.name }); };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => { setTimeout(connect, Math.min(10000, 500 * 2 ** retry++)); $('online').textContent = '· 재연결 중…'; };
  }
  const send = (m) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); };

  function onMessage(m) {
    switch (m.t) {
      case 'hello':
        S.symbols = m.symbols; S.md = m.md; S.news = m.news; S.lb = m.lb;
        if (!S.md[S.sym]) S.sym = S.symbols[0].code;
        renderTabs(); selectSymbol(S.sym, true);
        $('chat').innerHTML = ''; m.chat.forEach(addChat);
        renderNews(); renderLb();
        if (!S.token && !S.name) $('login').classList.remove('hidden');
        else $('login').classList.add('hidden');
        break;
      case 'joined':
        S.token = m.token; S.name = m.account.name;
        store.set('jusik.token', S.token); store.set('jusik.name', S.name);
        $('login').classList.add('hidden');
        setAccount(m.account);
        break;
      case 'account': setAccount(m.account); break;
      case 'history':
        if (m.sym === S.sym && m.tf === baseTf()) { S.base = m.candles.slice(); setChartData(); chart.timeScale().scrollToRealTime(); }
        break;
      case 'md': onMarketData(m); break;
      case 'lb': S.lb = m.lb; $('online').textContent = `· 접속 ${m.online}명 / 참가 ${m.lb.total}명`; renderLb(); break;
      case 'chat': addChat(m.item); break;
      case 'news':
        S.news.unshift(m.item); renderNews(); showTicker(m.item);
        break;
      case 'event': onEvent(m); break;
      case 'ack': setMsg(''); break;
      case 'error':
        if (!$('login').classList.contains('hidden') || !S.account) {
          // 저장된 닉네임이 이미 사용 중이면 로그인 화면으로
          S.token = null; store.set('jusik.token', '');
          $('login').classList.remove('hidden'); $('loginMsg').textContent = m.msg;
        } else { setMsg(m.msg); toast(m.msg, 'err'); }
        break;
    }
  }

  function onMarketData(m) {
    S.md = m.md;
    const q = S.md[S.sym];
    updateChart(baseTf() === 5 ? q.c5 : q.c60);
    for (const t of m.trades) if (t.sym === S.sym) S.tape.unshift(t);
    if (S.tape.length > 40) S.tape.length = 40;
    renderTabs(); renderQuote(); renderBook(); renderTape(m.trades.some((t) => t.sym === S.sym));
    renderMe(); renderPositions(); renderSummary();
  }

  function onEvent(e) {
    const name = symName(e.sym);
    if (e.kind === 'fill') {
      const extra = e.side === 'sell' && e.pnl != null ? ` (손익 <span class="${cls(e.pnl)}">${fmt(e.pnl)}</span>)` : '';
      toast(`<b>${esc(name)}</b> ${fmt(e.qty)}주 ${e.side === 'buy' ? '매수' : '매도'} 체결 @${fmt(e.price)}${extra}`, e.side);
    } else if (e.kind === 'cancel') {
      toast(`${esc(name)} 주문 #${e.id} 취소 (${fmt(e.left)}주)`);
    }
  }

  // ---------- 렌더링 ----------
  const symName = (c) => (S.symbols.find((s) => s.code === c) || {}).name || c;
  const chg = (q) => ((q.last / q.ref - 1) * 100);

  function renderTabs() {
    const box = $('symbolTabs');
    if (box.children.length !== S.symbols.length) {
      box.innerHTML = S.symbols.map((s) => `<button class="sym-tab" data-sym="${s.code}"><span class="n">${esc(s.name)}</span><span class="p"></span></button>`).join('');
    }
    for (const el of box.children) {
      const q = S.md[el.dataset.sym];
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
    document.title = `${q.name} ${fmt(q.last)} (${pct(c)}) · 주식 게임`;
  }

  function myPrices() {
    const set = new Set();
    if (S.account) for (const o of S.account.orders) if (o.sym === S.sym) set.add(o.price);
    return set;
  }

  function renderBook() {
    const q = S.md[S.sym];
    const asks = q.asks.slice(0, 10).reverse(), bids = q.bids.slice(0, 10);
    const max = Math.max(1, ...asks.map((r) => r[1]), ...bids.map((r) => r[1]));
    const mine = myPrices();
    const row = (r, k) => {
      const w = (r[1] / max) * 33.3;
      const c = cls(r[0] - q.ref);
      const qty = `<span class="q">${fmt(r[1])}</span>`;
      return `<div class="row ${k}${r[0] === q.last ? ' cur' : ''}" data-price="${r[0]}"><span class="bar" style="width:${w}%"></span>${k === 'ask' ? qty : ''}<span class="price ${c}${mine.has(r[0]) ? ' mine' : ''}">${fmt(r[0])}</span>${k === 'bid' ? qty : ''}</div>`;
    };
    $('book').innerHTML = asks.map((r) => row(r, 'ask')).join('') + '<div class="mid"></div>' + bids.map((r) => row(r, 'bid')).join('');
  }

  function renderTape(flash) {
    $('tape').innerHTML = S.tape.slice(0, 14).map((t, i) =>
      `<div class="${flash && i === 0 ? 'flash' : ''}"><span class="muted">${hhmmss(t.ts)}</span><span class="${t.side === 'buy' ? 'up' : 'down'}">${fmt(t.price)}</span><span>${fmt(t.qty)}</span></div>`).join('');
  }

  function equityOf(acc) {
    let v = acc.cash;
    for (const [k, p] of Object.entries(acc.positions)) v += p.qty * (S.md[k] ? S.md[k].last : 0);
    return v;
  }

  function renderMe() {
    if (!S.account) { $('meBox').innerHTML = ''; return; }
    const eq = equityOf(S.account);
    const r = (eq / S.account.startCash - 1) * 100;
    $('meBox').innerHTML = `${esc(S.account.name)} · 총자산 <b class="${cls(r)}">${fmt(eq)}원</b> <span class="${cls(r)}">${pct(r)}</span>`;
  }

  function renderPositions() {
    const a = S.account;
    if (!a) return;
    const rows = Object.entries(a.positions).filter(([, p]) => p.qty > 0);
    const head = '<tr><th>종목</th><th>보유</th><th>매도가능</th><th>평균단가</th><th>현재가</th><th>평가금액</th><th>평가손익</th><th>수익률</th></tr>';
    let totalVal = 0, totalCost = 0;
    const body = rows.map(([k, p]) => {
      const last = S.md[k].last, val = p.qty * last, cost = p.qty * p.avgCost;
      const pnl = val - cost - val * (FEE + TAX), r = cost ? (pnl / cost) * 100 : 0;
      totalVal += val; totalCost += cost;
      return `<tr class="click" data-sym="${k}"><td>${esc(symName(k))}</td><td>${fmt(p.qty)}</td><td>${fmt(p.qty - p.reserved)}</td><td>${fmt(p.avgCost)}</td><td>${fmt(last)}</td><td>${fmt(val)}</td><td class="${cls(pnl)}">${fmt(pnl)}</td><td class="${cls(r)}">${pct(r)}</td></tr>`;
    }).join('');
    const sum = `<tr><td class="muted">예수금 ${fmt(a.cash)} · 주문가능 ${fmt(a.cash - a.reservedCash)}</td><td colspan="4"></td><td>${fmt(totalVal)}</td><td colspan="2" class="muted">실현손익 <span class="${cls(a.realized)}">${fmt(a.realized)}</span></td></tr>`;
    $('posTable').innerHTML = head + (body || '<tr><td colspan="8" class="empty">보유 종목이 없습니다</td></tr>') + sum;
  }

  function renderOrders() {
    const a = S.account;
    const head = `<tr><th>종목</th><th>구분</th><th>주문가</th><th>주문수량</th><th>미체결</th><th>시간</th><th>${a.orders.length ? '<button data-cancel-all>전체취소</button>' : ''}</th></tr>`;
    const body = a.orders.map((o) => `<tr><td>${esc(symName(o.sym))}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? '매수' : '매도'}</td><td>${fmt(o.price)}</td><td>${fmt(o.qty)}</td><td>${fmt(o.qty - o.filled)}</td><td class="muted">${hhmmss(o.ts)}</td><td><button data-cancel="${o.id}">취소</button></td></tr>`).join('');
    $('openTable').innerHTML = head + (body || '<tr><td colspan="7" class="empty">미체결 주문이 없습니다</td></tr>');
    $('openCount').textContent = a.orders.length ? `(${a.orders.length})` : '';
  }

  function renderHistory() {
    const a = S.account;
    const head = '<tr><th>시간</th><th>종목</th><th>구분</th><th>체결가</th><th>수량</th><th>금액</th><th>수수료·세금</th><th>실현손익</th></tr>';
    const body = a.history.map((h) => `<tr><td class="muted">${hhmmss(h.ts)}</td><td>${esc(symName(h.sym))}</td><td class="${h.side === 'buy' ? 'up' : 'down'}">${h.side === 'buy' ? '매수' : '매도'}</td><td>${fmt(h.price)}</td><td>${fmt(h.qty)}</td><td>${fmt(h.price * h.qty)}</td><td>${fmt(h.fee)}</td><td class="${cls(h.pnl || 0)}">${h.pnl != null ? fmt(h.pnl) : ''}</td></tr>`).join('');
    $('histTable').innerHTML = head + (body || '<tr><td colspan="8" class="empty">체결 내역이 없습니다</td></tr>');
  }

  function renderLb() {
    if (!S.lb) return;
    $('lb').innerHTML = S.lb.top.map((r, i) => `<li class="${S.account && r.name === S.account.name ? 'me' : ''}"><span class="rank">${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</span><span class="nm">${esc(r.name)}</span><span class="eq">${fmt(r.equity)}<small class="${cls(r.ret)}">${pct(r.ret)}</small></span></li>`).join('') || '<li class="muted">아직 참가자가 없습니다</li>';
  }

  function renderNews() {
    $('news').innerHTML = S.news.map((n) => `<li><time>${hhmmss(n.ts)} · ${esc(symName(n.sym))}</time>${esc(n.title)}</li>`).join('') || '<li class="muted">아직 뉴스가 없습니다</li>';
  }

  function addChat(item) {
    const el = $('chat');
    const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
    const d = document.createElement('div');
    d.innerHTML = `<span class="muted">${hhmmss(item.ts).slice(0, 5)}</span> <b>${esc(item.name)}</b>${esc(item.text)}`;
    el.appendChild(d);
    while (el.children.length > 100) el.firstChild.remove();
    if (stick) el.scrollTop = el.scrollHeight;
  }

  let tickerTimer;
  function showTicker(n) {
    const el = $('ticker');
    el.textContent = `📰 ${n.title}`;
    el.classList.add('show');
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
    renderMe(); renderPositions(); renderOrders(); renderHistory(); renderSummary(); renderLb(); updateAvgLine();
    if (S.md[S.sym]) renderBook();
  }

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
      const p = orderPrice();
      return p ? Math.floor((S.account.cash - S.account.reservedCash) / (p * (1 + FEE))) : 0;
    }
    const ps = S.account.positions[S.sym];
    return ps ? ps.qty - ps.reserved : 0;
  }

  function renderSummary() {
    if (!S.md[S.sym]) return;
    const a = S.account;
    if (S.side === 'buy') {
      $('availLabel').textContent = '주문가능 금액';
      $('avail').textContent = a ? `${fmt(a.cash - a.reservedCash)}원` : '-';
    } else {
      $('availLabel').textContent = '매도가능 수량';
      $('avail').textContent = a ? `${fmt(maxQty())}주` : '-';
    }
    const total = orderPrice() * num(qtyIn);
    $('oTotal').textContent = `${S.otype === 'market' ? '약 ' : ''}${fmt(total)}원`;
  }

  function setSide(side) {
    S.side = side;
    document.querySelectorAll('.side-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.side === side));
    const btn = $('submit');
    btn.className = `submit ${side}`;
    btn.textContent = side === 'buy' ? '매수' : '매도';
    renderSummary();
  }

  function setType(t) {
    S.otype = t;
    document.querySelector(`input[name="otype"][value="${t}"]`).checked = true;
    priceIn.disabled = t === 'market';
    if (t === 'market') priceIn.value = '시장가';
    else setNum(priceIn, S.md[S.sym].last);
    renderSummary();
  }

  function selectSymbol(code, force) {
    if (code === S.sym && !force) return;
    S.sym = code; store.set('jusik.sym', code);
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
    p = Math.round(p / tickSize(p)) * tickSize(p);
    setNum(priceIn, p); renderSummary();
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
  [priceIn, qtyIn].forEach((el) => el.addEventListener('input', () => { const n = num(el); if (el.value !== '' ) setNum(el, n); renderSummary(); }));
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
    if (!S.account) { $('login').classList.remove('hidden'); return; }
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
  $('resetBtn').addEventListener('click', () => {
    if (confirm('모든 주식과 주문이 사라지고 10,000,000원으로 다시 시작합니다. 계속할까요?')) send({ t: 'reset' });
  });
  document.querySelectorAll('.tabs').forEach((tabs) => tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]'); if (!b) return;
    const panel = tabs.parentElement;
    tabs.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    panel.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
    if (b.dataset.tab === 'chat') $('chat').scrollTop = $('chat').scrollHeight;
  }));
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!S.account) { $('login').classList.remove('hidden'); return; }
    const v = $('chatInput').value.trim();
    if (v) send({ t: 'chat', text: v });
    $('chatInput').value = '';
  });
  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('nameInput').value.trim();
    if (!name) return;
    S.name = name; S.token = null;
    $('loginMsg').textContent = '';
    send({ t: 'join', name });
  });

  $('login').classList.add('hidden');
  connect();
})();
