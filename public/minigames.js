'use strict';
// 기업별 미니게임. 같은 seed → 모든 플레이어가 같은 문제/배치를 받음
window.Minigames = (() => {
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const INFO = {
    chip: { title: '불량 칩 검수', how: '빨간 불량 칩을 최대한 빨리 눌러 제거하세요. 정상 칩을 누르면 -1점.' },
    parking: { title: '정밀 주차', how: '움직이는 차를 노란 주차 칸에 멈추세요 (클릭/스페이스). 5번, 갈수록 빨라집니다.' },
    math: { title: '신약 배합 계산', how: '배합 수식을 계산해 입력하세요. 맞히면 자동으로 다음 문제로 넘어갑니다.' },
    reaction: { title: '무대 큐 사인', how: '화면이 금색으로 바뀌는 순간 누르세요! 4번. 너무 일찍 누르면 0점.' },
  };

  // 각 게임: (stage, rand, api) => { start(), stop() }  api = { add(n), finish() }
  const GAMES = {
    chip(stage, rand, api) {
      stage.innerHTML = '<div class="mg-chip"></div>';
      const grid = stage.firstChild;
      const cells = [];
      for (let i = 0; i < 16; i++) {
        const b = document.createElement('button');
        b.className = 'chip-cell';
        b.textContent = '▦';
        grid.appendChild(b);
        cells.push(b);
      }
      let target = -1, on = false;
      const next = () => {
        let t;
        do { t = Math.floor(rand() * 16); } while (t === target);
        if (target >= 0) cells[target].classList.remove('bad');
        target = t;
        cells[target].classList.add('bad');
      };
      grid.addEventListener('pointerdown', (e) => {
        const b = e.target.closest('.chip-cell');
        if (!b || !on) return;
        e.preventDefault();
        const i = cells.indexOf(b);
        if (i === target) { api.add(1); next(); }
        else { api.add(-1); b.classList.add('miss'); setTimeout(() => b.classList.remove('miss'), 250); }
      });
      return { start() { on = true; next(); }, stop() { on = false; } };
    },

    parking(stage, rand, api) {
      stage.innerHTML = '<div class="mg-park"><div class="lot"><div class="zone"></div><div class="car">🚗</div></div><div class="park-msg">클릭 또는 스페이스로 정지!</div><div class="tries"></div></div>';
      const lot = stage.querySelector('.lot'), zone = stage.querySelector('.zone'), car = stage.querySelector('.car');
      const msg = stage.querySelector('.park-msg'), tries = stage.querySelector('.tries');
      const W = 8;
      let attempt = 0, x = 0, dir = 1, zx = 50, moving = false, raf = 0, last = 0, on = false;
      const zones = Array.from({ length: 5 }, () => 12 + rand() * 76);
      const results = [];
      const draw = () => { car.style.left = x + '%'; tries.textContent = results.map((r) => r).join(' · ') || ' '; };
      const setup = () => {
        zx = zones[attempt];
        zone.style.left = (zx - W / 2) + '%'; zone.style.width = W + '%';
        x = attempt % 2 ? 100 : 0; dir = attempt % 2 ? -1 : 1;
        moving = true; last = performance.now();
        msg.textContent = `${attempt + 1}/5번째 주차`;
      };
      const loop = (t) => {
        const dt = (t - last) / 1000; last = t;
        if (moving) {
          const speed = 55 + attempt * 28; // %/초
          x += dir * speed * dt;
          if (x > 100) { x = 100; dir = -1; }
          if (x < 0) { x = 0; dir = 1; }
          draw();
        }
        if (on) raf = requestAnimationFrame(loop);
      };
      const stopCar = () => {
        if (!on || !moving) return;
        moving = false;
        const dist = Math.abs(x - zx);
        const pts = Math.max(0, Math.round(100 - dist * 7));
        results.push(pts);
        api.add(pts);
        msg.textContent = pts >= 90 ? `완벽! +${pts}` : pts > 0 ? `+${pts}` : '빗나감!';
        draw();
        attempt++;
        if (attempt >= 5) { setTimeout(() => api.finish(), 600); return; }
        setTimeout(() => on && setup(), 700);
      };
      lot.addEventListener('pointerdown', (e) => { e.preventDefault(); stopCar(); });
      const key = (e) => { if (e.code === 'Space') { e.preventDefault(); stopCar(); } };
      document.addEventListener('keydown', key);
      return {
        start() { on = true; setup(); raf = requestAnimationFrame(loop); },
        stop() { on = false; cancelAnimationFrame(raf); document.removeEventListener('keydown', key); },
      };
    },

    math(stage, rand, api) {
      stage.innerHTML = '<div class="mg-math"><div class="q"></div><input inputmode="numeric" autocomplete="off" /><div class="hint muted">Enter로 제출 · 맞으면 자동 진행</div></div>';
      const q = stage.querySelector('.q'), input = stage.querySelector('input');
      let ans = 0, on = false;
      const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
      const next = () => {
        const k = rand();
        let a, b, op;
        if (k < 0.35) { a = ri(12, 89); b = ri(12, 89); op = '+'; ans = a + b; }
        else if (k < 0.65) { a = ri(30, 99); b = ri(11, a - 1); op = '−'; ans = a - b; }
        else { a = ri(3, 9); b = ri(6, 19); op = '×'; ans = a * b; }
        q.textContent = `${a} ${op} ${b} = ?`;
        input.value = '';
      };
      input.addEventListener('input', () => {
        if (!on) return;
        if (Number(input.value) === ans) { api.add(1); q.classList.add('ok'); setTimeout(() => q.classList.remove('ok'), 150); next(); }
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && on && input.value !== '') {
          if (Number(input.value) !== ans) { q.classList.add('no'); setTimeout(() => q.classList.remove('no'), 250); next(); }
        }
      });
      return { start() { on = true; next(); input.focus(); }, stop() { on = false; input.blur(); } };
    },

    reaction(stage, rand, api) {
      stage.innerHTML = '<div class="mg-react"><div class="pad">준비…</div><div class="tries"></div></div>';
      const pad = stage.querySelector('.pad'), tries = stage.querySelector('.tries');
      const waits = Array.from({ length: 4 }, () => 1000 + rand() * 1800);
      let i = 0, state = 'idle', goAt = 0, timer = 0, on = false;
      const res = [];
      const arm = () => {
        state = 'wait'; pad.className = 'pad wait'; pad.textContent = '기다리세요…';
        timer = setTimeout(() => { state = 'go'; goAt = performance.now(); pad.className = 'pad go'; pad.textContent = '지금!'; }, waits[i]);
      };
      const hit = () => {
        if (!on) return;
        if (state === 'wait') {
          clearTimeout(timer); res.push('너무 빠름'); pad.className = 'pad early'; pad.textContent = '너무 빨라요! 0점';
        } else if (state === 'go') {
          const ms = Math.round(performance.now() - goAt);
          const pts = Math.max(0, 1000 - ms);
          api.add(pts); res.push(ms + 'ms');
          pad.className = 'pad done'; pad.textContent = `${ms}ms  +${pts}`;
        } else return;
        state = 'idle';
        tries.textContent = res.join(' · ');
        i++;
        if (i >= 4) { setTimeout(() => api.finish(), 700); return; }
        setTimeout(() => on && arm(), 900);
      };
      pad.addEventListener('pointerdown', (e) => { e.preventDefault(); hit(); });
      const key = (e) => { if (e.code === 'Space') { e.preventDefault(); hit(); } };
      document.addEventListener('keydown', key);
      return { start() { on = true; arm(); }, stop() { on = false; clearTimeout(timer); document.removeEventListener('keydown', key); } };
    },
  };

  // 게임 생성: onScore(점수) 실시간, onFinish() 조기 종료 시
  function create(stage, game, seed, onScore, onFinish) {
    let score = 0, finished = false;
    const api = {
      add(n) { score = Math.max(0, score + n); onScore(score); },
      finish() { if (!finished) { finished = true; inst.stop(); onFinish(score); } },
    };
    const inst = GAMES[game](stage, rng(seed), api);
    return {
      start: () => inst.start(),
      end() { if (!finished) { finished = true; inst.stop(); } return score; },
      get score() { return score; },
      get finished() { return finished; },
    };
  }

  return { INFO, create };
})();
