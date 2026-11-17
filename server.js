'use strict';

/**
 * Duel Arena - server.js
 *
 * 判定はすべてサーバー側で行う。クライアントは「入力」を送り、「状態」を受け取って描画するだけ。
 *
 * 拡張ポイント
 *   - SKILLS          : スキルの数値データ (ダメージ・時間など)
 *   - SKILL_KINDS     : スキル種別ごとの振る舞い (press / release / update / resolve / onStateEnd)
 *   - CHARACTERS      : キャラクター定義 (HP・ガード量・使えるスキルのスロット割り当て)
 *
 *   新スキル : SKILLS に追加 → 既存 kind を使うならこれだけ。新しい挙動なら SKILL_KINDS に kind を追加。
 *   新キャラ : CHARACTERS に追加 (skills のスロットに SKILLS の定義を割り当てる)。
 */

const path = require('path');
const http = require('http');
const { performance } = require('perf_hooks');
const express = require('express');
const { Server } = require('socket.io');

/* ------------------------------------------------------------------ *
 *  1. 全体設定
 * ------------------------------------------------------------------ */
const PORT = process.env.PORT || 3000;
const TICK_RATE = 60; // 1秒あたりの更新回数
const COUNTDOWN_MS = 3000; // マッチ成立後のカウントダウン
const MAX_DT = 0.1; // 1tickで進める最大秒数 (処理落ち対策)
const INPUT_LIMIT_PER_SEC = 120; // 1接続あたりの入力数上限 (連打・不正対策)
const DEFAULT_CHARACTER = 'fighter';

/* ------------------------------------------------------------------ *
 *  2. スキル定義 (純粋なデータ。JSONとしてクライアントにも送る)
 * ------------------------------------------------------------------ */
const SKILLS = {
  // 攻撃: 入力の0.2秒後に判定 / 判定後0.3秒の硬直
  slash: {
    id: 'slash',
    name: '斬撃',
    kind: 'strike',
    windupMs: 200,
    recoveryMs: 300,
    damage: 10,
    guardDamage: 20, // ガードされたとき相手のガードゲージを削る量
  },
  // ガード: 長押し中はゲージ減少 / 解除で回復 / 0でガードブレイク
  guard: {
    id: 'guard',
    name: 'ガード',
    kind: 'guard',
    drainPerSec: 25,
    regenPerSec: 30,
    breakMs: 2000, // ガードブレイク中の行動不能時間
    breakRestore: 50, // ブレイク終了時に戻るゲージ量
  },
  // 回避: 発動中は完全無敵
  dodge: {
    id: 'dodge',
    name: '回避',
    kind: 'dodge',
    invincibleMs: 400,
    cooldownMs: 1000,
  },
};

/* ------------------------------------------------------------------ *
 *  3. キャラクター定義
 *     skills のキー = 入力スロット名 (クライアントの操作と対応)
 * ------------------------------------------------------------------ */
const CHARACTERS = {
  fighter: {
    id: 'fighter',
    name: 'ファイター',
    maxHp: 100,
    maxGuard: 100,
    skills: {
      attack: SKILLS.slash,
      guard: SKILLS.guard,
      dodge: SKILLS.dodge,
    },
  },
};

/* ------------------------------------------------------------------ *
 *  4. スキル種別 (kind) ごとの振る舞い
 *     ctx = { now, dt, snapshot, fx(type, target, extra), breakGuard(fighter) }
 * ------------------------------------------------------------------ */
const SKILL_KINDS = {
  /** 攻撃: 発動 → windup後に判定 → recovery後に行動可能 */
  strike: {
    press(f, skill, ctx) {
      if (f.state !== 'idle' && f.state !== 'guard') return;
      if (!f.cooldownReady(skill, ctx.now)) return;
      f.startState('attack', ctx.now, skill.windupMs + skill.recoveryMs, skill);
      f.pending = { skill, resolveAt: ctx.now + skill.windupMs };
      f.startCooldown(skill, ctx.now);
    },
    // 判定。defenderの状態は「このtickの判定開始前」のスナップショットで見る (同時判定の公平性)
    resolve(attacker, defender, skill, ctx) {
      const defenderState = ctx.snapshot.get(defender).state;

      if (defenderState === 'dodge') {
        ctx.fx('dodge', defender);
        return;
      }
      if (defenderState === 'guard') {
        defender.guardGauge = Math.max(0, defender.guardGauge - skill.guardDamage);
        ctx.fx('block', defender);
        if (defender.guardGauge <= 0) ctx.breakGuard(defender);
        return;
      }
      defender.hp = Math.max(0, defender.hp - skill.damage);
      ctx.fx('hit', defender, { damage: skill.damage });
    },
  },

  /** ガード: 押している間 guard 状態。ゲージ減少 / 解除で回復 / 0でブレイク */
  guard: {
    press(f, skill, ctx) {
      f.guardHeld = true;
      if (f.state === 'idle' && f.guardGauge > 0) f.startState('guard', ctx.now, 0, skill);
    },
    release(f, skill, ctx) {
      f.guardHeld = false;
      if (f.state === 'guard') f.startState('idle', ctx.now);
    },
    update(f, skill, ctx) {
      if (f.state === 'guard') {
        f.guardGauge -= skill.drainPerSec * ctx.dt;
        if (f.guardGauge <= 0) ctx.breakGuard(f);
      } else if (f.state !== 'broken') {
        f.guardGauge = Math.min(f.maxGuard, f.guardGauge + skill.regenPerSec * ctx.dt);
      }
    },
    breakGuard(f, skill, ctx) {
      f.guardGauge = 0;
      f.guardHeld = false; // ブレイク後は押し直しが必要
      f.pending = null;
      f.startState('broken', ctx.now, skill.breakMs, skill);
      ctx.fx('guardBreak', f);
    },
    onStateEnd(f, skill) {
      if (f.state === 'broken') f.guardGauge = skill.breakRestore;
    },
  },

  /** 回避: 発動中は無敵 (判定側が state === 'dodge' を見る) */
  dodge: {
    press(f, skill, ctx) {
      if (f.state !== 'idle' && f.state !== 'guard') return;
      if (!f.cooldownReady(skill, ctx.now)) return;
      f.startState('dodge', ctx.now, skill.invincibleMs, skill);
      f.pending = null;
      f.startCooldown(skill, ctx.now);
    },
  },
};

/* ------------------------------------------------------------------ *
 *  5. Fighter: 1人ぶんの戦闘状態
 *     state: idle | guard | attack | dodge | broken
 * ------------------------------------------------------------------ */
class Fighter {
  constructor(socket, character, now) {
    this.socket = socket;
    this.character = character;
    this.maxHp = character.maxHp;
    this.maxGuard = character.maxGuard;
    this.hp = this.maxHp;
    this.guardGauge = this.maxGuard;
    this.guardHeld = false;
    this.pending = null; // { skill, resolveAt } 判定待ちの攻撃
    this.cooldowns = new Map(); // skillId -> readyAt
    this.startState('idle', now);
  }

  skillOfKind(kind) {
    return Object.values(this.character.skills).find((s) => s.kind === kind) || null;
  }

  startState(state, now, durationMs = 0, skill = null) {
    this.state = state;
    this.stateStart = now;
    this.stateDuration = durationMs;
    this.stateEnd = durationMs > 0 ? now + durationMs : null;
    this.stateSkill = skill;
  }

  cooldownReady(skill, now) {
    return now >= (this.cooldowns.get(skill.id) || 0);
  }

  startCooldown(skill, now) {
    if (skill.cooldownMs) this.cooldowns.set(skill.id, now + skill.cooldownMs);
  }

  /** 行動が終わったあとの待機状態 (ガード押しっぱなしならガードに戻る) */
  toNeutral(now) {
    const guardSkill = this.skillOfKind('guard');
    if (this.guardHeld && guardSkill && this.guardGauge > 0) {
      this.startState('guard', now, 0, guardSkill);
    } else {
      this.startState('idle', now);
    }
  }

  update(ctx) {
    if (this.stateEnd !== null && ctx.now >= this.stateEnd) {
      const kind = this.stateSkill && SKILL_KINDS[this.stateSkill.kind];
      if (kind && kind.onStateEnd) kind.onStateEnd(this, this.stateSkill, ctx);
      this.toNeutral(ctx.now);
    }
    for (const skill of Object.values(this.character.skills)) {
      const kind = SKILL_KINDS[skill.kind];
      if (kind && kind.update) kind.update(this, skill, ctx);
    }
  }

  snapshot(now) {
    const cooldowns = {};
    for (const [slot, skill] of Object.entries(this.character.skills)) {
      if (!skill.cooldownMs) continue;
      cooldowns[slot] = {
        remain: Math.max(0, Math.round((this.cooldowns.get(skill.id) || 0) - now)),
        total: skill.cooldownMs,
      };
    }
    return {
      characterId: this.character.id,
      hp: this.hp,
      maxHp: this.maxHp,
      guard: Math.round(this.guardGauge * 10) / 10,
      maxGuard: this.maxGuard,
      state: this.state,
      skillId: this.stateSkill ? this.stateSkill.id : null,
      elapsed: Math.round(now - this.stateStart),
      duration: this.stateDuration,
      cooldowns,
    };
  }
}

/* ------------------------------------------------------------------ *
 *  6. Room: 1試合
 *     phase: countdown -> fighting -> ended
 * ------------------------------------------------------------------ */
class Room {
  constructor(id, sockets, now = performance.now()) {
    this.id = id;
    this.phase = 'countdown';
    this.phaseStart = now;
    this.closed = false;
    this.fighters = sockets.map((socket) => {
      const fighter = new Fighter(socket, CHARACTERS[DEFAULT_CHARACTER], now);
      socket.data.room = this;
      socket.data.fighter = fighter;
      return fighter;
    });
  }

  opponentOf(fighter) {
    return this.fighters[0] === fighter ? this.fighters[1] : this.fighters[0];
  }

  /** 各プレイヤーに「自分 / 相手」視点で試合開始を通知 */
  announce() {
    for (const f of this.fighters) {
      f.socket.emit('matchFound', {
        roomId: this.id,
        countdownMs: COUNTDOWN_MS,
        you: { characterId: f.character.id },
        opponent: { characterId: this.opponentOf(f).character.id },
      });
    }
  }

  emitFx(type, target, extra = {}) {
    for (const f of this.fighters) {
      f.socket.emit('fx', { type, target: f === target ? 'you' : 'opponent', ...extra });
    }
  }

  makeCtx(now, dt) {
    const ctx = {
      now,
      dt,
      snapshot: null,
      fx: (type, target, extra) => this.emitFx(type, target, extra),
    };
    ctx.breakGuard = (fighter) => {
      const skill = fighter.skillOfKind('guard');
      if (skill) SKILL_KINDS.guard.breakGuard(fighter, skill, ctx);
    };
    return ctx;
  }

  handleInput(fighter, msg, now = performance.now()) {
    if (this.closed || this.phase !== 'fighting') return;
    if (!msg || typeof msg.action !== 'string' || typeof msg.down !== 'boolean') return;

    const skills = fighter.character.skills;
    if (!Object.prototype.hasOwnProperty.call(skills, msg.action)) return;

    const skill = skills[msg.action];
    const kind = SKILL_KINDS[skill.kind];
    const handler = msg.down ? kind.press : kind.release;
    if (handler) handler(fighter, skill, this.makeCtx(now, 0));
  }

  update(now, dt) {
    if (this.closed) return;

    if (this.phase === 'countdown' && now - this.phaseStart >= COUNTDOWN_MS) {
      this.phase = 'fighting';
      this.phaseStart = now;
    }
    if (this.phase === 'fighting') this.step(now, dt);

    if (!this.closed) this.broadcastState(now);
  }

  step(now, dt) {
    const ctx = this.makeCtx(now, dt);

    // 1) 状態の時間経過・ゲージ増減
    for (const f of this.fighters) f.update(ctx);

    // 2) 攻撃判定: 判定前の状態を固定して全員ぶんを同時に処理する
    ctx.snapshot = new Map(this.fighters.map((f) => [f, { state: f.state }]));
    const due = this.fighters.filter((f) => f.pending && now >= f.pending.resolveAt);
    for (const attacker of due) {
      const { skill } = attacker.pending;
      attacker.pending = null;
      if (attacker.state !== 'attack') continue;
      SKILL_KINDS[skill.kind].resolve(attacker, this.opponentOf(attacker), skill, ctx);
    }

    // 3) 勝敗判定 (同時撃破は引き分け)
    const dead = this.fighters.filter((f) => f.hp <= 0);
    if (dead.length === 2) this.finish(null, 'doubleKO', now);
    else if (dead.length === 1) this.finish(this.opponentOf(dead[0]), 'ko', now);
  }

  broadcastState(now) {
    const countdown = this.phase === 'countdown' ? Math.max(0, COUNTDOWN_MS - (now - this.phaseStart)) : 0;
    for (const f of this.fighters) {
      f.socket.emit('state', {
        phase: this.phase,
        countdown: Math.round(countdown),
        you: f.snapshot(now),
        opponent: this.opponentOf(f).snapshot(now),
      });
    }
  }

  finish(winner, reason, now = performance.now()) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.broadcastState(now);
    for (const f of this.fighters) {
      f.socket.emit('gameOver', {
        result: !winner ? 'draw' : winner === f ? 'win' : 'lose',
        reason,
      });
      if (f.socket.data.room === this) {
        f.socket.data.room = null;
        f.socket.data.fighter = null;
      }
    }
    this.closed = true;
  }

  /** 切断: 相手の勝利 */
  handleLeave(fighter) {
    if (this.phase === 'ended') return;
    this.finish(this.opponentOf(fighter), 'opponentLeft');
  }
}

/* ------------------------------------------------------------------ *
 *  7. マッチメイキング / ゲームループ
 * ------------------------------------------------------------------ */
const rooms = new Set();
const queue = [];
let nextRoomId = 1;

function removeFromQueue(socket) {
  const i = queue.indexOf(socket);
  if (i !== -1) queue.splice(i, 1);
}

function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    if (!a.connected) { if (b.connected) queue.unshift(b); continue; }
    if (!b.connected) { queue.unshift(a); continue; }
    const room = new Room(nextRoomId++, [a, b]);
    rooms.add(room);
    room.announce();
  }
}

let lastTick = performance.now();
function loop() {
  const now = performance.now();
  const dt = Math.min((now - lastTick) / 1000, MAX_DT);
  lastTick = now;
  for (const room of rooms) {
    room.update(now, dt);
    if (room.closed) rooms.delete(room);
  }
}

/* ------------------------------------------------------------------ *
 *  8. HTTP / Socket.IO
 * ------------------------------------------------------------------ */
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// クライアントに渡す定義 (関数を含まないデータのみ)
const PUBLIC_CONFIG = {
  tickRate: TICK_RATE,
  skills: SKILLS,
  characters: Object.fromEntries(
    Object.values(CHARACTERS).map((c) => [
      c.id,
      {
        id: c.id,
        name: c.name,
        maxHp: c.maxHp,
        maxGuard: c.maxGuard,
        slots: Object.fromEntries(Object.entries(c.skills).map(([slot, s]) => [slot, s.id])),
      },
    ])
  ),
};

io.on('connection', (socket) => {
  socket.data.room = null;
  socket.data.fighter = null;
  socket.emit('config', PUBLIC_CONFIG);

  socket.on('findMatch', () => {
    if (socket.data.room || queue.includes(socket)) return;
    queue.push(socket);
    socket.emit('queue', { status: 'waiting' });
    tryMatch();
  });

  let windowStart = Date.now();
  let count = 0;
  socket.on('input', (msg) => {
    const t = Date.now();
    if (t - windowStart >= 1000) { windowStart = t; count = 0; }
    if (++count > INPUT_LIMIT_PER_SEC) return;

    const room = socket.data.room;
    if (room && socket.data.fighter) room.handleInput(socket.data.fighter, msg);
  });

  socket.on('disconnect', () => {
    removeFromQueue(socket);
    const room = socket.data.room;
    if (room && socket.data.fighter) room.handleLeave(socket.data.fighter);
  });
});

if (require.main === module) {
  setInterval(loop, 1000 / TICK_RATE);
  server.listen(PORT, () => {
    console.log(`Duel Arena: http://localhost:${PORT}`);
  });
}

module.exports = { Room, Fighter, SKILLS, CHARACTERS, SKILL_KINDS };
