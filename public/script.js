(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  設定 (キャラ・スキル追加時はここと server.js のデータを足す)
   * ------------------------------------------------------------------ */

  // 入力スロット(server.jsのCHARACTERS.skillsのキー) ごとのUIと割り当てキー
  const SLOT_UI = {
    attack: { label: '攻撃', keys: ['KeyJ', 'KeyZ'], hint: 'J / Z' },
    guard: { label: 'ガード', keys: ['KeyK', 'KeyX'], hint: 'K / X (長押し)' },
    dodge: { label: '回避', keys: ['KeyL', 'KeyC'], hint: 'L / C' },
  };

  const STATE_LABEL = { idle: '', guard: 'GUARD', attack: 'ATTACK', dodge: 'DODGE', broken: 'BREAK!' };

  const PALETTE = {
    you: { body: '#4da3ff', light: '#cfe6ff', dark: '#1d4f8f' },
    opponent: { body: '#ff5d6c', light: '#ffd0d5', dark: '#8f2531' },
  };

  // 左が常に自分、右が相手
  const ARENA = { W: 960, H: 420, GROUND: 340, X: { you: 270, opponent: 690 }, DIR: { you: 1, opponent: -1 } };

  /* ------------------------------------------------------------------ *
   *  DOM
   * ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  const canvas = $('arena');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = ARENA.W * dpr;
  canvas.height = ARENA.H * dpr;

  const overlay = $('overlay');
  const overlayTitle = $('overlay-title');
  const overlaySub = $('overlay-sub');
  const overlayBtn = $('overlay-btn');
  const banner = $('banner');
  const controls = $('controls');
  const connection = $('connection');

  const hud = {};
  for (const side of ['you', 'opponent']) {
    hud[side] = {
      hp: $(`hp-${side}`),
      hpNum: $(`hp-${side}-num`),
      guard: $(`guard-${side}`),
      tag: $(`tag-${side}`),
    };
  }

  /* ------------------------------------------------------------------ *
   *  状態
   * ------------------------------------------------------------------ */
  const socket = io();

  let config = null; // サーバーから受け取るスキル/キャラ定義
  let match = null; // 試合情報
  let snap = null; // 最新のstate + 受信時刻
  let over = false;
  let fightShownAt = null;
  let overTimer = null;

  const held = new Set(); // 押しているスロット
  const buttons = new Map(); // slot -> button
  let currentSlots = new Set();

  const floaters = []; // 浮かぶテキスト
  const particles = [];
  const flashUntil = { you: 0, opponent: 0 };
  const repelledUntil = { you: 0, opponent: 0 }; // ガードされて弾かれている間
  let shake = 0;

  /* ------------------------------------------------------------------ *
   *  オーバーレイ / 接続表示
   * ------------------------------------------------------------------ */
  function showOverlay(title, sub = '', showButton = false, cls = '') {
    overlayTitle.textContent = title;
    overlayTitle.className = cls;
    overlaySub.textContent = sub;
    overlayBtn.hidden = !showButton;
    overlay.classList.add('show');
  }
  function hideOverlay() {
    overlay.classList.remove('show');
  }
  function setConn(online) {
    connection.textContent = online ? 'オンライン' : '切断';
    connection.className = `conn ${online ? 'online' : 'offline'}`;
  }

  function findMatch() {
    clearTimeout(overTimer);
    match = null;
    snap = null;
    over = false;
    showOverlay('マッチング中…', '対戦相手を探しています');
    socket.emit('findMatch');
  }
  overlayBtn.addEventListener('click', findMatch);

  /* ------------------------------------------------------------------ *
   *  Socket.IO
   * ------------------------------------------------------------------ */
  socket.on('connect', () => {
    setConn(true);
    findMatch(); // 自動マッチング
  });

  socket.on('disconnect', () => {
    setConn(false);
    clearTimeout(overTimer);
    match = null;
    snap = null;
    releaseAll();
    showOverlay('接続が切れました', '再接続しています…');
  });

  socket.on('config', (cfg) => {
    config = cfg;
  });

  socket.on('matchFound', (data) => {
    clearTimeout(overTimer);
    match = data;
    over = false;
    snap = null;
    fightShownAt = null;
    floaters.length = 0;
    particles.length = 0;
    flashUntil.you = flashUntil.opponent = 0;
    repelledUntil.you = repelledUntil.opponent = 0;
    releaseAll();
    buildControls();
    hideOverlay();
  });

  socket.on('state', (data) => {
    snap = { ...data, at: performance.now() };
    updateHud();
  });

  socket.on('fx', (e) => handleFx(e));

  socket.on('gameOver', (data) => {
    over = true;
    releaseAll();
    // 最後の一撃を見せてから結果表示
    overTimer = setTimeout(() => {
      const reasonText = data.reason === 'opponentLeft' ? '相手が退出しました' : data.reason === 'doubleKO' ? '同時撃破' : '';
      if (data.result === 'win') showOverlay('勝利!', reasonText, true, 'win');
      else if (data.result === 'lose') showOverlay('敗北…', reasonText, true, 'lose');
      else showOverlay('引き分け', reasonText, true, 'draw');
    }, 700);
  });

  /* ------------------------------------------------------------------ *
   *  入力 (キーボード / ボタン)
   * ------------------------------------------------------------------ */
  const KEY_TO_SLOT = {};
  for (const [slot, ui] of Object.entries(SLOT_UI)) {
    for (const code of ui.keys) KEY_TO_SLOT[code] = slot;
  }

  function press(slot) {
    if (!match || over || held.has(slot) || !currentSlots.has(slot)) return;
    held.add(slot);
    socket.emit('input', { action: slot, down: true });
    const btn = buttons.get(slot);
    if (btn) btn.classList.add('active');
  }

  function release(slot) {
    if (!held.has(slot)) return;
    held.delete(slot);
    socket.emit('input', { action: slot, down: false });
    const btn = buttons.get(slot);
    if (btn) btn.classList.remove('active');
  }

  function releaseAll() {
    for (const slot of [...held]) {
      held.delete(slot);
      const btn = buttons.get(slot);
      if (btn) btn.classList.remove('active');
    }
  }

  window.addEventListener('keydown', (e) => {
    const slot = KEY_TO_SLOT[e.code];
    if (!slot) return;
    e.preventDefault();
    if (!e.repeat) press(slot);
  });
  window.addEventListener('keyup', (e) => {
    const slot = KEY_TO_SLOT[e.code];
    if (!slot) return;
    e.preventDefault();
    release(slot);
  });
  window.addEventListener('blur', () => {
    for (const slot of [...held]) release(slot);
  });

  function buildControls() {
    controls.innerHTML = '';
    buttons.clear();
    currentSlots = new Set();
    const slots = config.characters[match.you.characterId].slots;

    for (const slot of Object.keys(slots)) {
      const ui = SLOT_UI[slot];
      if (!ui) continue;
      currentSlots.add(slot);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ctl';
      btn.dataset.slot = slot;
      btn.innerHTML = `<span class="ctl-label">${ui.label}</span><span class="ctl-key">${ui.hint}</span>`;

      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { btn.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
        press(slot);
      });
      btn.addEventListener('pointerup', () => release(slot));
      btn.addEventListener('pointercancel', () => release(slot));
      btn.addEventListener('lostpointercapture', () => release(slot));
      btn.addEventListener('contextmenu', (e) => e.preventDefault());

      controls.appendChild(btn);
      buttons.set(slot, btn);
    }
  }

  /* ------------------------------------------------------------------ *
   *  HUD
   * ------------------------------------------------------------------ */
  const ratio = (v, max) => Math.max(0, Math.min(1, v / max));

  function updateHud() {
    if (!snap) return;
    for (const side of ['you', 'opponent']) {
      const f = snap[side];
      const h = hud[side];
      h.hp.style.width = `${ratio(f.hp, f.maxHp) * 100}%`;
      h.hp.classList.toggle('low', f.hp / f.maxHp <= 0.25);
      h.hpNum.textContent = Math.max(0, Math.ceil(f.hp));
      h.guard.style.width = `${ratio(f.guard, f.maxGuard) * 100}%`;
      h.guard.classList.toggle('broken', f.state === 'broken');
      h.tag.textContent = STATE_LABEL[f.state] || '';
    }
    // クールダウン表示 (自分)
    for (const [slot, btn] of buttons) {
      const cd = snap.you.cooldowns[slot];
      btn.style.setProperty('--cd', cd && cd.total ? String(ratio(cd.remain, cd.total)) : '0');
    }
  }

  /* ------------------------------------------------------------------ *
   *  エフェクト
   * ------------------------------------------------------------------ */
  function handleFx(e) {
    const side = e.target;
    const x = ARENA.X[side];
    const y = ARENA.GROUND - 100;
    const now = performance.now();

    if (e.type === 'hit') {
      flashUntil[side] = now + 120;
      shake = Math.max(shake, 10);
      addFloater(`-${e.damage}`, x, y, '#ff8a5c', 34);
      burst(x, y, '#ffd27a', 14);
    } else if (e.type === 'block') {
      shake = Math.max(shake, 4);
      addFloater('BLOCK', x, y, '#6fe3ff', 26);
      burst(x + ARENA.DIR[side] * 38, y + 20, '#bff4ff', 10);
    } else if (e.type === 'repelled') {
      repelledUntil[side] = now + 500;
      addFloater('弾かれた!', x, y - 10, '#c7a8ff', 24);
    } else if (e.type === 'dodge') {
      addFloater('DODGE', x, y, '#9dff9d', 26);
    } else if (e.type === 'guardBreak') {
      shake = Math.max(shake, 14);
      addFloater('GUARD BREAK!', x, y - 10, '#ffb04d', 30);
      burst(x + ARENA.DIR[side] * 38, y + 20, '#ffb04d', 22);
    }
  }

  function addFloater(text, x, y, color, size) {
    floaters.push({ text, x, y, color, size, born: performance.now() });
  }

  function burst(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 80 + Math.random() * 200;
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, life: 0.35 + Math.random() * 0.3, max: 0.65, color });
    }
  }

  /* ------------------------------------------------------------------ *
   *  描画
   * ------------------------------------------------------------------ */
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawBackground(now) {
    const { W, H, GROUND } = ARENA;
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#0d1433');
    sky.addColorStop(1, '#1b1f47');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // 遠景の柱
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let i = 0; i < 7; i++) ctx.fillRect(60 + i * 140, 40, 36, GROUND - 40);

    // 床
    const floor = ctx.createLinearGradient(0, GROUND, 0, H);
    floor.addColorStop(0, '#222a5a');
    floor.addColorStop(1, '#0d1130');
    ctx.fillStyle = floor;
    ctx.fillRect(0, GROUND, W, H - GROUND);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, GROUND);
    ctx.lineTo(W, GROUND);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const y = GROUND + i * 10 + i * i * 0.8;
      if (y > H) break;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    // 中央ライン
    ctx.setLineDash([8, 10]);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.moveTo(W / 2, 60);
    ctx.lineTo(W / 2, GROUND);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 剣士のからだ。前方向が +x (呼び出し側でdirに応じて反転済み)
  function renderBody(pose, pal, flash) {
    ctx.save();
    ctx.globalAlpha = pose.alpha;
    ctx.translate(pose.offsetX, 0);
    ctx.rotate(pose.lean);
    ctx.scale(1, pose.squash);
    ctx.translate(0, pose.bob);

    const body = flash ? '#ffffff' : pal.body;

    // 脚
    ctx.lineCap = 'round';
    ctx.lineWidth = 11;
    ctx.strokeStyle = flash ? '#ffffff' : pal.dark;
    ctx.beginPath();
    ctx.moveTo(-9, -36); ctx.lineTo(-13, 0);
    ctx.moveTo(9, -36); ctx.lineTo(15, 0);
    ctx.stroke();

    // 胴
    ctx.fillStyle = body;
    roundRect(-21, -98, 42, 68, 11);
    ctx.fill();
    ctx.fillStyle = flash ? '#ffffff' : pal.dark;
    ctx.fillRect(-21, -52, 42, 7); // ベルト

    // 頭
    ctx.fillStyle = flash ? '#ffffff' : pal.light;
    ctx.beginPath();
    ctx.arc(0, -115, 17, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b1220';
    ctx.beginPath();
    ctx.ellipse(8, -117, 3, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // 腕と剣
    ctx.save();
    ctx.translate(14, -80);
    ctx.rotate(pose.sword);
    ctx.lineWidth = 9;
    ctx.strokeStyle = flash ? '#ffffff' : pal.light;
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(24, 0);
    ctx.stroke();
    ctx.strokeStyle = '#d7deef';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(24, 0); ctx.lineTo(92, 0);
    ctx.stroke();
    ctx.strokeStyle = '#ffcf6b';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(28, -9); ctx.lineTo(28, 9);
    ctx.stroke();
    ctx.restore();

    ctx.restore();
  }

  function drawFighter(f, side, now) {
    const dir = ARENA.DIR[side];
    const pal = PALETTE[side];
    const skill = f.skillId && config.skills[f.skillId];

    let t = f.elapsed + (now - snap.at);
    if (f.duration > 0) t = Math.min(t, f.duration);

    const pose = {
      offsetX: 0,
      lean: 0,
      sword: 0.45,
      alpha: 1,
      squash: 1,
      bob: Math.sin(now / 240 + (side === 'you' ? 0 : 1.7)) * 2,
      shield: false,
      slash: 0,
      dizzy: false,
    };
    let afterimage = false;

    switch (f.state) {
      case 'attack':
        if (skill) {
          const w = skill.windupMs;
          const r = skill.recoveryMs;
          if (t < w) {
            const p = t / w;
            pose.offsetX = -16 * p;
            pose.lean = -0.14 * p;
            pose.sword = -1.3 - 0.5 * p; // 振りかぶり
          } else {
            const q = Math.min(1, (t - w) / r);
            pose.offsetX = 48 * (1 - q);
            pose.lean = 0.2 * (1 - q);
            pose.sword = 1.1 - 0.5 * q; // 振り下ろし
            const since = t - w;
            if (since < 140) pose.slash = 1 - since / 140;
            // ガードされた場合は後ろにのけぞる
            if (now < repelledUntil[side]) {
              pose.offsetX = -14 * Math.min(1, since / 150);
              pose.lean = -0.18;
              pose.sword = 0.2;
              pose.slash = 0;
            }
          }
        }
        break;
      case 'dodge': {
        const p = f.duration ? t / f.duration : 1;
        pose.offsetX = -120 * Math.sin(p * Math.PI * 0.5);
        pose.lean = -0.25;
        pose.alpha = 0.4;
        afterimage = true;
        break;
      }
      case 'guard':
        pose.shield = true;
        pose.sword = -0.2;
        pose.lean = -0.04;
        break;
      case 'broken':
        pose.lean = 0.32 + Math.sin(now / 90) * 0.04;
        pose.squash = 0.88;
        pose.bob = 0;
        pose.sword = 1.3;
        pose.dizzy = true;
        break;
      default:
        break;
    }

    if (f.hp <= 0) {
      pose.lean = -1.35;
      pose.alpha = 0.85;
      pose.shield = false;
      pose.slash = 0;
      pose.dizzy = false;
      pose.sword = 1.5;
    }

    const x = ARENA.X[side];
    const flash = now < flashUntil[side];

    // 影
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(x + pose.offsetX * dir, ARENA.GROUND + 4, 36, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(x, ARENA.GROUND);
    ctx.scale(dir, 1);

    if (afterimage) renderBody({ ...pose, offsetX: 0, lean: 0, alpha: 0.14 }, pal, false);
    renderBody(pose, pal, flash);

    // 斬撃エフェクト
    if (pose.slash > 0) {
      ctx.save();
      ctx.globalAlpha = pose.slash;
      ctx.strokeStyle = '#fff6d6';
      ctx.lineWidth = 12 * pose.slash;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(pose.offsetX + 14, -80, 82, -1.5, 1.05);
      ctx.stroke();
      ctx.restore();
    }

    // ガードのシールド
    if (pose.shield) {
      const gr = f.guard / f.maxGuard;
      const flick = gr < 0.25 ? (Math.sin(now / 45) > 0 ? 1 : 0.35) : 1;
      ctx.save();
      ctx.globalAlpha = 0.9 * flick;
      ctx.fillStyle = 'rgba(111,227,255,0.14)';
      ctx.beginPath();
      ctx.moveTo(26, -72);
      ctx.arc(26, -72, 58, -1.15, 1.15);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#6fe3ff';
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(26, -72, 58, -1.15, 1.15);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();

    // ラベル / めまい (反転させない)
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '800 13px system-ui, sans-serif';
    ctx.fillStyle = side === 'you' ? '#7db9ff' : '#ff8d98';
    ctx.fillText(side === 'you' ? 'YOU' : 'ENEMY', x + pose.offsetX * dir, ARENA.GROUND - 160);
    if (pose.dizzy) {
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillStyle = '#ffd27a';
      for (let i = 0; i < 3; i++) {
        const a = now / 220 + (i * Math.PI * 2) / 3;
        ctx.fillText('★', x + pose.offsetX * dir + Math.cos(a) * 28, ARENA.GROUND - 142 + Math.sin(a) * 7);
      }
    }
    ctx.restore();
  }

  function drawEffects(now, dtSec) {
    // パーティクル
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dtSec;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.vy += 520 * dtSec;
      p.x += p.vx * dtSec;
      p.y += p.vy * dtSec;
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;

    // 浮かぶテキスト
    for (let i = floaters.length - 1; i >= 0; i--) {
      const fl = floaters[i];
      const age = (now - fl.born) / 800;
      if (age >= 1) { floaters.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = 1 - age * age;
      ctx.textAlign = 'center';
      ctx.font = `900 ${fl.size}px system-ui, sans-serif`;
      ctx.lineWidth = 5;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeText(fl.text, fl.x, fl.y - age * 46);
      ctx.fillStyle = fl.color;
      ctx.fillText(fl.text, fl.x, fl.y - age * 46);
      ctx.restore();
    }
  }

  function updateBanner(now) {
    let text = '';
    if (snap && !over) {
      if (snap.phase === 'countdown') {
        const n = Math.ceil((snap.countdown - (now - snap.at)) / 1000);
        text = n > 0 ? String(n) : 'FIGHT!';
      } else if (snap.phase === 'fighting') {
        if (fightShownAt === null) fightShownAt = now;
        if (now - fightShownAt < 700) text = 'FIGHT!';
      }
    }
    if (text !== banner.textContent) {
      banner.textContent = text;
      banner.classList.remove('show');
      if (text) {
        void banner.offsetWidth; // アニメーション再起動
        banner.classList.add('show');
      }
    }
  }

  let lastFrame = performance.now();
  function frame(now) {
    const dtSec = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, ARENA.W, ARENA.H);

    ctx.save();
    if (shake > 0.4) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake *= 0.86;
    } else {
      shake = 0;
    }

    drawBackground(now);
    if (snap && config) {
      drawFighter(snap.you, 'you', now);
      drawFighter(snap.opponent, 'opponent', now);
    }
    drawEffects(now, dtSec);
    ctx.restore();

    updateBanner(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  showOverlay('接続中…');
})();
