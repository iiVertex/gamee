// Client-side match: renderer, local first-person controller, remote
// interpolation, interactions, effects, HUD and in-game panels.
import * as THREE from 'three';
import { getMap } from '/shared/maps/index.js';
import { CollisionWorld, stepBody, lookDir } from '/shared/physics.js';
import { PHYS, NET, MODES } from '/shared/constants.js';
import { WEAPONS, FISTS, RESOURCE_NODES, itemLabel, RECIPES, MATERIALS, MATERIAL_IDS, AMMO, HEALS } from '/shared/items.js';
import { CONTAINER_DIMS } from '/shared/mapbuilder.js';
import { buildWorld, setupEnvironment } from './world.js';
import { Avatar } from './avatar.js';
import { ViewModel } from './viewmodel.js';
import { Effects } from './effects.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { itemModel, chickenModel, potatoModel, MUZZLE } from './models.js';
import { setTextureSize } from './textures.js';
import { settings, resolvedQuality, keyName } from '../settings.js';
import { audio } from '../audio.js';
import { h, mount, clear, toast } from '../util/dom.js';

const SEND_MS = 1000 / NET.CLIENT_SEND_HZ;
const _v = new THREE.Vector3();

let sharedRenderer = null;
function getRenderer(quality) {
  if (!sharedRenderer) {
    sharedRenderer = new THREE.WebGLRenderer({ antialias: quality !== 'low', powerPreference: 'high-performance', stencil: false });
    sharedRenderer.outputColorSpace = THREE.SRGBColorSpace;
    sharedRenderer.autoClear = false;
  }
  return sharedRenderer;
}

export class Game {
  constructor(app) {
    this.app = app;
    this.net = app.net;
    this.root = document.getElementById('game-root');
    this.players = new Map();
    this.loot = new Map();
    this.scores = {};
    this.modeState = {};
    this.inv = null;
    this.state = 'loading';
    this.alive = true;
    this.disposed = false;
    this.unsubs = [];
    this.panel = null;
    this.chatOpen = false;
    this.lastSend = 0;
    this.seq = 0;
    this.tpSeq = 0;
    this.camYOff = 0;
    this.shake = 0;
    this.fireHeld = false;
    this.lastShot = 0;
    this.lastPunch = 0;
    this.stepAcc = 0;
    this.spectating = -1;
    this.interactTarget = null;
    this.interactCheckT = 0;
    this.localMag = null;
  }

  // ------------------------------------------------------------------ setup
  async load(data, onProgress = () => {}) {
    this.matchId = data.matchId;
    this.mode = data.mode;
    this.modeId = data.mode;
    this.combat = data.mode === 'guns' || data.mode === 'craft';
    this.crafting = data.mode === 'craft';
    this.me = data.you;
    this.practice = data.practice;
    this.quality = resolvedQuality();
    setTextureSize(this.quality === 'low' ? 128 : 256);
    onProgress(0.1, 'Generating map…');
    await tick();
    if (this.disposed) throw cancelled(); // left/kicked while loading
    this.map = getMap(data.mapId);
    this.mapName = this.map.name;
    audio.setEnvironment(this.map.indoor ? 'indoor' : 'outdoor');
    this.world = new CollisionWorld(this.map.boxes.filter((b) => b.col !== false));
    this.doorOpen = new Map();
    for (const d of this.map.doors) { this.doorOpen.set(d.id, !!d.open); this.world.setDisabled(d.id, !!d.open); }
    onProgress(0.3, 'Building the world…');
    await tick();
    if (this.disposed) throw cancelled(); // left/kicked while loading

    // renderer + scenes
    const q = this.quality;
    this.renderer = getRenderer(q);
    const pr = Math.min(window.devicePixelRatio || 1, q === 'high' ? 1.5 : q === 'medium' ? 1 : 0.75);
    this.renderer.setPixelRatio(pr);
    this.root.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    // sky, fog, sun/hemisphere/fill lights and shadows for this map's theme
    const env = setupEnvironment(this.scene, this.map, { quality: q, renderer: this.renderer });
    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, env.far + 40);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.sky = env.sky;
    this.sun = env.sun;
    this.sunDir = env.sunDir;

    const built = buildWorld(this.map, { shadows: this.renderer.shadowMap.enabled, quality: q });
    this.scene.add(built.root);
    this.worldObjs = built;
    onProgress(0.7, 'Spawning players…');
    await tick();
    if (this.disposed) throw cancelled(); // left/kicked while loading

    this.effects = new Effects(this.scene, q);
    if (this.map.weather) this.effects.setWeather(this.map.weather);
    const meInfo = data.roster.find((r) => r.num === this.me);
    this.mySkins = meInfo ? meInfo.skins || {} : {};
    this.vm = new ViewModel(meInfo ? meInfo.avatar.color : '#4cc9f0');
    this.roster(data.roster);

    // chicken objective
    if (this.mode === 'grab') {
      this.chicken = chickenModel();
      this.chicken.visible = false;
      const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 14, 14, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }));
      glow.position.y = 7;
      this.chicken.add(glow);
      this.scene.add(this.chicken);
    }

    // input + hud
    this.input = new Input(this.renderer.domElement);
    this.input.handlers.lock = (locked) => this.onLockChange(locked);
    this.input.handlers.key = (e) => this.onKey(e);
    this.hudWrap = h('div', { style: { position: 'absolute', inset: '0', pointerEvents: 'none' } });
    this.root.appendChild(this.hudWrap);
    this.hud = new Hud(this.hudWrap, this);
    // clicking the 3D view always gets the player back into the game (closes an open chat box)
    this.clickCatcher = h('div', { style: { position: 'absolute', inset: '0' }, onClick: () => { if (this.chatOpen) this.closeChat(); else if (!this.panel) this.input.lock(); } });
    this.root.insertBefore(this.clickCatcher, this.hudWrap);
    this.input.surfaces.add(this.clickCatcher);
    this.buildGameChat();

    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    this.resize();
    this.bindNet();
    this.root.classList.remove('hidden');
    onProgress(1, 'Ready!');
    // body + camera
    this.body = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true };
    this.yaw = 0; this.pitch = 0;
    this.lastFrame = performance.now();
    this.running = true;
    this.renderer.setAnimationLoop(() => this.frame());
    this.net.emit('match:ready');
  }

  roster(list) {
    for (const r of list) {
      let p = this.players.get(r.num);
      if (!p) {
        p = { num: r.num, name: r.name, bot: r.bot, avatar: r.avatar, skins: r.skins || {}, buf: [], alive: true, left: r.left, connected: true, held: null, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, flags: 0 };
        this.players.set(r.num, p);
        if (r.num !== this.me) {
          p.avatar3d = new Avatar({ name: r.name, avatar: r.avatar, bot: r.bot });
          this.scene.add(p.avatar3d.root);
        }
      }
      p.left = r.left;
      if (p.left && p.avatar3d) p.avatar3d.root.visible = false;
    }
  }

  buildGameChat() {
    const lines = h('div', { class: 'lines' });
    const input = h('input', { class: 'input', maxlength: '200', placeholder: 'Say something… (Enter to send, Esc to close)' });
    const chanBtn = h('button', { class: 'chan', type: 'button', text: 'ALL' });
    this.gameChannel = 'game';
    const myParty = this.players.get(this.me)?.partyId;
    chanBtn.addEventListener('click', () => {
      if (!this.app.social.party) { this.gameChannel = 'game'; chanBtn.textContent = 'ALL'; toast('You are not in a party.'); return; }
      this.gameChannel = this.gameChannel === 'game' ? 'gameparty' : 'game';
      chanBtn.textContent = this.gameChannel === 'game' ? 'ALL' : 'PARTY';
      input.focus();
    });
    const sendBtn = h('button', { class: 'btn small cyan', type: 'submit', text: 'Send' });
    const form = h('form', { onSubmit: (e) => { e.preventDefault(); this.sendChat(input.value); input.value = ''; this.closeChat(); } }, chanBtn, input, sendBtn);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); input.value = ''; this.closeChat(); } e.stopPropagation(); });
    this.gameChatEl = h('div', { class: 'game-chat' }, lines, form, h('div', { class: 'hint', text: `Press ${keyName(settings.keys.chat)}${Object.values(settings.keys).includes('KeyT') ? '' : ' or T'} to chat` }));
    this.gameChatLines = lines;
    this.gameChatInput = input;
    this.hudWrap.appendChild(this.gameChatEl);
    void myParty;
    // replay recent in-game messages
    for (const m of this.app.chat.history('game').slice(-8)) this.addChatLine(m, true);
  }

  addChatLine(m, old = false) {
    const line = this.app.chat.renderLine(m, { compact: true });
    this.gameChatLines.appendChild(line);
    while (this.gameChatLines.children.length > 40) this.gameChatLines.firstChild.remove();
    this.gameChatLines.scrollTop = this.gameChatLines.scrollHeight;
    setTimeout(() => line.classList.add('fade'), old ? 0 : 9000);
  }

  openChat() {
    this.chatOpen = true;
    this.gameChatEl.classList.add('open');
    this.input.unlock();
    setTimeout(() => this.gameChatInput.focus(), 0);
  }
  closeChat() {
    this.chatOpen = false;
    this.gameChatEl.classList.remove('open');
    this.gameChatInput.blur();
    if (!this.panel) this.input.lock();
  }
  sendChat(text) {
    text = String(text || '').trim();
    if (!text) return;
    this.app.chat.send(this.gameChannel, text);
  }

  resize() {
    const w = window.innerWidth, hh = window.innerHeight;
    this.renderer.setSize(w, hh, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / hh;
    this.camera.updateProjectionMatrix();
    this.vm.setResolution(w, hh);
  }

  // ------------------------------------------------------------------ network
  bindNet() {
    const on = (ev, fn) => this.unsubs.push(this.net.on(ev, fn));
    on('match:init', (d) => this.onInit(d));
    on('match:go', (d) => { this.state = 'playing'; this.goAt = performance.now(); this.setModeState(d.modeState); audio.play('go'); audio.startMatchMusic(this.mode); });
    on('s', (d) => this.onSnapshot(d));
    on('ev', (d) => this.onEvent(d));
    on('mode', (d) => this.setModeState(d));
    on('inv', (d) => this.setInv(d));
    on('sc', (d) => { this.scores = d; });
    on('tp', (d) => {
      this.body.x = d.x; this.body.y = d.y; this.body.z = d.z; this.body.vx = this.body.vy = this.body.vz = 0;
      if (!d.keepLook && d.yaw !== undefined) { this.yaw = d.yaw; this.pitch = 0; }
      this.tpSeq = d.seq;
      this.camYOff = 0;
    });
    on('kb', (d) => { this.body.vx += d.vx; this.body.vz += d.vz; this.body.vy = Math.max(this.body.vy, d.vy); this.body.onGround = false; this.shake = 0.25; });
    on('chat:msg', (m) => { if (m.channel === 'game' || m.channel === 'gameparty') this.addChatLine(m); });
    on('net:connect', () => this.hud && this.hud.center('Reconnected!', '', 1200));
  }

  onInit(d) {
    this.state = d.state;
    this.countdownEndsAt = d.countdownEndsAt;
    this.roster(d.roster);
    for (const pd of d.players) {
      const p = this.players.get(pd.num);
      if (!p) continue;
      p.x = pd.x; p.y = pd.y; p.z = pd.z; p.yaw = pd.yaw;
      p.alive = pd.alive; p.left = pd.left; p.connected = pd.connected;
      p.buf = [{ t: d.serverTime - 200, x: pd.x, y: pd.y, z: pd.z, yaw: pd.yaw, pitch: 0, f: 4 | (pd.alive ? 8 : 0) }];
      this.setHeldFor(p, pd.held);
      if (pd.num === this.me) {
        this.body.x = pd.x; this.body.y = pd.y; this.body.z = pd.z;
        this.yaw = pd.yaw; this.pitch = 0;
        this.alive = pd.alive;
      } else if (p.avatar3d) {
        if (!pd.alive) { p.avatar3d.die(); p.avatar3d.deadT = 5; } else p.avatar3d.revive();
        p.avatar3d.root.visible = !pd.left && pd.alive;
      }
    }
    // doors
    for (const id of d.doors) this.setDoor(id, true, true);
    for (const id of d.doorsClosed || []) this.setDoor(id, false, true);
    // loot
    for (const [, l] of this.loot) this.scene.remove(l.mesh);
    this.loot.clear();
    for (const l of d.loot) this.addLoot(l);
    for (const id of d.containers) this.openContainer(id, true);
    for (const [id, left] of d.resources) this.setResource(id, left);
    this.setModeState(d.modeState);
    if (d.inv) this.setInv(d.inv);
    for (const k of d.killfeed || []) this.killfeedEntry(k, true);
    if (!this.alive) this.startSpectate();
    this.hud.center(`${MODES[this.mode].icon} ${MODES[this.mode].name}`, this.map.name, 2500);
    if (typeof d.tpSeq === 'number') this.tpSeq = d.tpSeq; // resync after a rejoin
    if (this.state === 'countdown') audio.play('beep');
    if (this.state === 'playing' && !audio.matchBus) audio.startMatchMusic(this.mode);
    this.input.lock();
  }

  onSnapshot(d) {
    const a = d.p;
    for (let i = 0; i < a.length; i += 7) {
      const p = this.players.get(a[i]);
      if (!p) continue;
      const f = a[i + 6];
      const e = { t: d.t, x: a[i + 1], y: a[i + 2], z: a[i + 3], yaw: a[i + 4], pitch: a[i + 5], f };
      p.buf.push(e);
      if (p.buf.length > 40) p.buf.splice(0, p.buf.length - 40);
      const alive = !!(f & 8);
      if (p.num !== this.me) {
        p.connected = !!(f & 32);
        if (p.avatar3d) { p.avatar3d.reloading = !!(f & 64); p.avatar3d.healing = !!(f & 128); }
        if (alive && !p.alive && p.avatar3d) p.avatar3d.revive();
      }
      p.alive = alive;
    }
  }

  setModeState(ms) {
    if (!ms) return;
    const prev = this.modeState || {};
    this.modeState = ms;
    if (ms.mode === 'hotpotato' && ms.popAt !== prev.popAt) ms.roundStart = this.net.serverNow();
    else if (ms.mode === 'hotpotato') ms.roundStart = prev.roundStart;
    for (const p of this.players.values()) {
      const av = p.avatar3d;
      let status = null, carry = null;
      if (ms.mode === 'tag' && ms.it === p.num) status = 'it';
      if (ms.mode === 'hotpotato' && ms.holder === p.num) carry = 'potato';
      if (ms.mode === 'grab' && ms.item && ms.item.carrier === p.num) carry = 'chicken';
      if (av) { av.setStatus(status); av.setCarry(carry); }
      if (p.num === this.me) this.myCarry = carry;
    }
    if (this.chicken && ms.item) {
      this.chicken.visible = ms.item.state !== 'carried';
      this.chicken.position.set(ms.item.x, ms.item.y + 0.3, ms.item.z);
    }
    this.speedMul = (ms.sp && ms.sp[this.me]) || 1;
    this.updateViewmodelHeld();
  }

  setInv(inv) {
    const prevHeld = this.inv ? this.inv.held : -1;
    this.inv = inv;
    if (inv.held !== prevHeld) this.vm.cancelReload();
    this.localMag = null;
    if (!this.alive && inv.hp > 0) { /* respawn not used */ }
    this.updateViewmodelHeld();
    if (this.invPanelRefresh) this.invPanelRefresh();
  }

  updateViewmodelHeld() {
    if (!this.vm) return;
    if (this.myCarry === 'potato') this.vm.setHeld('potato');
    else if (this.myCarry === 'chicken') this.vm.setHeld('chicken');
    else if (this.inv && this.inv.held > 0 && this.inv.slots[this.inv.held - 1]) {
      const t = this.inv.slots[this.inv.held - 1].t;
      this.vm.setHeld('weapon', t, this.mySkins[t] || null);
    } else this.vm.setHeld('fists');
  }

  setHeldFor(p, type) {
    p.held = type;
    if (p.avatar3d) p.avatar3d.setHeld(type, type ? p.skins[type] || null : null);
  }

  // ------------------------------------------------------------------ events
  onEvent(e) {
    const P = (n) => this.players.get(n);
    const posOf = (n) => { const p = P(n); return n === this.me ? { x: this.body.x, y: this.body.y + 1.2, z: this.body.z } : p ? { x: p.x, y: p.y + 1.2, z: p.z } : null; };
    switch (e.k) {
      case 'punch': {
        if (e.n !== this.me) { P(e.n)?.avatar3d?.punch(); audio.play('whoosh', { pos: posOf(e.n), vol: 0.6 }); }
        if (e.hit >= 0) {
          const tp = posOf(e.hit);
          audio.play('punch', { pos: tp });
          if (tp) this.effects.burst(tp.x, tp.y + 0.2, tp.z, 8, [0xffffff, 0xffd23f], 3, 0.14, 0.3, -5);
          if (e.n === this.me) this.hud.hitmarker(false, false);
        }
        break;
      }
      case 'tag': {
        const to = P(e.to), from = e.from >= 0 ? P(e.from) : null;
        audio.play('boing', { pos: posOf(e.to) });
        const tp = posOf(e.to);
        if (tp) this.effects.burst(tp.x, tp.y + 0.5, tp.z, 24, [0xff2040, 0xffffff], 5, 0.18, 0.7);
        if (e.to === this.me) { this.hud.center("YOU'RE IT!", from ? `${from.name} tagged you — tag someone else!` : 'Chase someone and punch them!', 2200); audio.play('tagged'); this.shake = 0.3; }
        else if (e.from === this.me) this.hud.center('TAGGED!', `${to?.name} is IT now — run!`, 1600);
        this.hud.feed(`🏃 ${from ? from.name + ' → ' : ''}${to?.name} is IT`);
        break;
      }
      case 'pass': {
        if (e.to < 0) break;
        const to = P(e.to);
        audio.play('pass', { pos: posOf(e.to) });
        if (e.to === this.me) { this.hud.center('YOU HAVE THE BOOB-TATO!', 'Get close and press E (or click) to pass it!', 2000); this.shake = 0.2; }
        else if (e.from === this.me) this.vm.use();
        if (e.from >= 0) this.hud.feed(`🔥 ${P(e.from)?.name} → ${to?.name}`, 3000);
        break;
      }
      case 'pop': {
        this.effects.pop(e.x, e.y, e.z);
        audio.play('pop', { pos: { x: e.x, y: e.y, z: e.z }, maxDist: 120 });
        if (e.n === this.me) { this.shake = 0.6; this.hud.center('💥 POP!', e.lives > 0 ? `You lost a life — ${e.lives} left` : 'You are out of lives!', 2500); }
        this.hud.feed(`💥 Popped on ${P(e.n)?.name}!`);
        break;
      }
      case 'item': {
        if (e.state === 'carried') { audio.play('squeak', { pos: posOf(e.n) }); if (e.n === this.me) this.hud.center('🐔 GOT IT!', 'Run to the glowing table!', 1600); }
        if (e.state === 'drop') { audio.play('squeak', { pos: { x: e.x, y: e.y, z: e.z } }); this.effects.burst(e.x, e.y + 0.5, e.z, 16, [0xffd23f, 0xffffff], 4, 0.15, 0.6); if (e.n === this.me) { this.hud.center('Dropped it!', 'Grab it back!', 1200); this.shake = 0.3; } }
        if (e.state === 'spawn') this.effects.burst(e.x, e.y + 0.5, e.z, 30, [0xffd23f, 0xffffff], 5, 0.2, 0.8);
        break;
      }
      case 'deliver': {
        const t = this.map.grab.table;
        this.effects.confetti(t.x, t.y + 1.5, t.z, 120);
        audio.play('win', { pos: t });
        break;
      }
      case 'shot': this.onShot(e); break;
      case 'hm': this.hud.hitmarker(e.head, e.kill); audio.play(e.kill ? 'kill' : e.head ? 'head' : 'hit'); break;
      case 'hurt': {
        this.hud.hurt();
        audio.play('hurt');
        const ap = e.from >= 0 && e.from !== this.me ? posOf(e.from) : null;
        if (ap) {
          // angle to the attacker relative to where we look (+ = to the right)
          const dx = ap.x - this.body.x, dz = ap.z - this.body.z;
          const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
          this.hud.damageFrom(Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz));
        }
        this.shake = Math.min(0.4, 0.1 + e.dmg / 120);
        if (this.inv) { this.inv.hp = e.hp; this.inv.armor = e.armor; }
        break;
      }
      case 'elim': this.killfeedEntry(e); break;
      case 'reload': {
        if (e.cancel) { if (e.n === this.me) { this.vm.cancelReload?.(); this.hud.stopProgress(); } break; }
        if (e.n === this.me) { this.vm.reload(e.ms); audio.play('reload', { ms: e.ms }); this.hud.startProgress('Reloading…', e.ms); }
        else audio.play('reload', { pos: posOf(e.n), ms: e.ms, vol: 0.5 });
        break;
      }
      case 'held': {
        const p = P(e.n);
        if (p) this.setHeldFor(p, e.w);
        break;
      }
      case 'door': this.setDoor(e.id, e.open); break;
      case 'loot+': this.addLoot(e.l); break;
      case 'loot-': {
        const l = this.loot.get(e.id);
        if (l) {
          this.scene.remove(l.mesh);
          this.loot.delete(e.id);
          if (e.n === this.me) audio.play('pickup');
          else audio.play('pickup', { pos: l.data, vol: 0.4 });
        }
        break;
      }
      case 'cont': {
        this.openContainer(e.id);
        const c = this.worldObjs.containers.get(e.id);
        if (c) audio.play('open', { pos: c.def });
        if (e.n === this.me) this.hud.stopProgress();
        break;
      }
      case 'res': {
        this.setResource(e.id, e.left);
        const r = this.worldObjs.resources.get(e.id);
        if (r) { audio.play('harvest', { pos: r.def }); this.effects.dust(r.def.x, r.def.y + 0.4, r.def.z, 8, 0xc8a070); }
        break;
      }
      case 'search': {
        if (e.cancel) { this.hud.stopProgress(); break; }
        this.hud.startProgress(e.label || 'Searching…', e.ms);
        audio.play('rustle');
        break;
      }
      case 'got': {
        if (e.empty) this.hud.pickup('Empty…', '#b9a9e6');
        for (const it of e.items || []) this.hud.pickup('+ ' + itemLabel(it), it.kind === 'weapon' ? '#3ddc97' : '#ffd23f');
        if ((e.items || []).length) audio.play('pickup');
        break;
      }
      case 'healing': {
        clearTimeout(this.healItemTimer);
        if (e.cancel) { this.hud.stopProgress(); this.vm.showHealItem(null); this.healUntil = 0; break; }
        this.hud.startProgress(`Using ${HEALS[e.t].name}…`, e.ms);
        this.vm.showHealItem(e.t);
        this.healUntil = performance.now() + e.ms;
        this.healItemTimer = setTimeout(() => this.vm.showHealItem(null), e.ms);
        break;
      }
      case 'healed': {
        if (e.n === this.me) { audio.play('heal'); this.hud.pickup(`+HP (${e.hp})`, '#3ddc97'); this.vm.showHealItem(null); }
        const pp = posOf(e.n);
        if (pp) this.effects.burst(pp.x, pp.y + 0.3, pp.z, 12, [0x3ddc97, 0xffffff], 2, 0.15, 0.8, 2);
        break;
      }
      case 'crafted': {
        const b = this.worldObjs.benches.get(e.bench);
        if (b) { audio.play('craft', { pos: b.def }); this.effects.burst(b.def.x, b.def.y + 1.2, b.def.z, 14, [0x4cc9f0, 0xffd23f, 0xffffff], 3, 0.14, 0.6); }
        if (e.n === this.me) { const r = RECIPES.find((x) => x.id === e.r); this.hud.pickup('🛠 Crafted ' + (r ? r.name : e.r), '#4cc9f0'); }
        break;
      }
      case 'toast': this.hud.pickup(e.text, '#ff8fa3'); audio.play('error'); break;
      case 'dry': audio.play('dry'); break;
      case 'left': { const p = P(e.n); if (p) { p.left = true; if (p.avatar3d) p.avatar3d.root.visible = false; } break; }
      case 'conn': { const p = P(e.n); if (p) { p.connected = e.on; this.hud.feed(`${p.name} ${e.on ? 'reconnected' : 'disconnected'}`, 3000); } break; }
      case 'fell': if (e.n === this.me) this.hud.center('Whoops!', 'You fell off the map.', 1500); break;
      case 'tagend': break;
      default:
    }
  }

  killfeedEntry(e, old = false) {
    const P = (n) => this.players.get(n);
    const v = P(e.victim), k = e.killer >= 0 ? P(e.killer) : null;
    const span = (p) => h('span', { class: p && p.num === this.me ? 'me' : '', text: p ? p.name : '?' });
    const w = e.w === 'pop' ? '💥' : e.w === 'fall' ? '🕳️' : e.w === 'fists' ? '👊' : e.w ? '🔫' : '💀';
    this.hud.feed(k ? [span(k), ` ${w}${e.head ? '🎯' : ''} `, span(v)] : [`${w} `, span(v)]);
    if (old) return;
    if (v && v.avatar3d) v.avatar3d.die();
    if (v) v.alive = false;
    const vp = v ? (e.victim === this.me ? this.body : v) : null;
    if (vp) this.effects.burst(vp.x, vp.y + 1, vp.z, 30, [0xff4d6d, 0xffd23f, 0xffffff], 5, 0.2, 0.9);
    audio.play('elim', { pos: vp ? { x: vp.x, y: vp.y, z: vp.z } : null });
    if (e.victim === this.me) {
      this.alive = false;
      this.streak = 0;
      this.hud.center('ELIMINATED', k ? `by ${k.name}` : '', 3000);
      const left = [...this.players.values()].filter((p) => p.alive && !p.left && p.num !== this.me).length;
      const total = [...this.players.values()].filter((p) => !p.left).length;
      if (left > 0) setTimeout(() => this.hud && this.hud.placement(`You placed #${left + 1} of ${total}`), 900);
      audio.play('lose');
      audio.setIntensity(0);
      setTimeout(() => this.startSpectate(), 1500);
    }
    if (e.killer === this.me && e.victim !== this.me) {
      this.streak = (this.streak || 0) + 1;
      this.hud.elimPopup(v?.name || '?', e.head, this.streak);
      if (this.streak >= 2) audio.play('streak', { n: this.streak });
    }
  }

  onShot(e) {
    if (e.n === this.me) return; // local shots are predicted immediately
    const p = this.players.get(e.n);
    if (p && p.avatar3d) p.avatar3d.shoot();
    const o = e.o;
    // start the tracer at the shooter's gun
    let sx = o[0], sy = o[1] - 0.3, sz = o[2];
    if (p) { const d = lookDir(p.yaw, p.pitch); sx = p.x + d.x * 0.7 + Math.cos(p.yaw) * 0.3; sy = p.y + 1.35 + d.y * 0.7; sz = p.z + d.z * 0.7 - Math.sin(p.yaw) * 0.3; }
    for (const hpt of e.h) {
      this.effects.tracer(sx, sy, sz, hpt[0], hpt[1], hpt[2], e.w === 'blaster' ? 0xc77dff : 0xfff2a0);
      this.effects.impact(hpt[0], hpt[1], hpt[2], 0, 0, 0, hpt[3] > 0);
    }
    audio.play('shot', { w: e.w, pos: { x: o[0], y: o[1], z: o[2] }, maxDist: 140 });
  }

  setDoor(id, open, instant = false) {
    this.doorOpen.set(id, open);
    this.world.setDisabled(id, open);
    const d = this.worldObjs.doors.get(id);
    if (d) {
      d.open = open;
      if (instant) d.cur = open ? 1 : 0;
      else audio.play('door', { pos: { x: d.pivot.position.x, y: d.pivot.position.y + 1, z: d.pivot.position.z } });
    }
  }

  addLoot(l) {
    if (this.loot.has(l.id)) return;
    const mesh = itemModel(l.kind, l.t);
    mesh.position.set(l.x, l.y + 0.05, l.z);
    // glow ring under the item
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.4, 16), new THREE.MeshBasicMaterial({ color: lootColor(l), transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
    mesh.add(ring);
    this.scene.add(mesh);
    this.loot.set(l.id, { data: l, mesh, phase: Math.random() * 6 });
  }

  openContainer(id, instant = false) {
    const c = this.worldObjs.containers.get(id);
    if (!c || c.opened) return;
    c.opened = true;
    if (instant) c.anim = 1;
    c.model.userData.body.material = c.model.userData.body.material.clone();
    c.model.userData.body.material.color.setScalar(0.6);
  }

  setResource(id, left) {
    const r = this.worldObjs.resources.get(id);
    if (!r) return;
    r.left = left;
    const s = left <= 0 ? 0.001 : 0.45 + 0.55 * Math.min(1, left / 4);
    r.model.scale.setScalar(s);
    r.model.visible = left > 0;
  }

  // ------------------------------------------------------------------ input handling
  onLockChange(locked) {
    if (!locked && !this.panel && !this.chatOpen && this.running && !this.ended) this.openPause();
    if (locked && this.panel && this.panel.kind === 'pause') this.closePanel();
  }

  onKey(e) {
    if (this.ended) return;
    const k = settings.keys;
    if (this.panel && this.panel.kind === 'inventory' && e.code === k.inventory) { this.closePanel(); this.input.lock(); return; }
    if (!this.input.locked) return;
    // T is a chat shortcut only while no action is bound to it
    if (e.code === k.chat || (e.code === 'KeyT' && !Object.values(k).includes('KeyT'))) { e.preventDefault(); this.openChat(); return; }
    if (e.code === k.inventory && this.combat) { this.openInventory(false); }
  }

  handleInput(dt) {
    const inp = this.input;
    const locked = inp.locked && !this.panel && !this.chatOpen;
    // look
    const m = inp.consumeMouse();
    if (locked) {
      const zoom = this.adsZoom || 1;
      const sens = settings.sensitivity * 0.0022 / zoom;
      this.yaw -= m.x * sens;
      this.pitch -= m.y * sens * (settings.invertY ? -1 : 1);
      this.pitch = Math.max(-1.54, Math.min(1.54, this.pitch));
      this.vm.mouse(m.x, m.y);
    }
    // scoreboard works while spectating and during the countdown; hides with menus/chat
    const sb = locked && inp.down('scoreboard');
    if (sb !== this._sb) { this._sb = sb; this.hud.showScoreboard(sb); }
    if (!locked || this.state !== 'playing' || !this.alive) {
      this.ads = false;
      if (locked && !this.alive && this.spectating >= 0) {
        if (inp.clicked.has(0)) this.cycleSpectate(1);
        if (inp.clicked.has(2)) this.cycleSpectate(-1);
      }
      return { fx: 0, fz: 0, sprint: false, jump: false };
    }
    let mx = 0, mz = 0;
    if (inp.down('forward')) mz += 1;
    if (inp.down('back')) mz -= 1;
    if (inp.down('right')) mx += 1;
    if (inp.down('left')) mx -= 1;
    const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
    const rX = Math.cos(this.yaw), rZ = -Math.sin(this.yaw);
    let fx = fwdX * mz + rX * mx, fz = fwdZ * mz + rZ * mx;
    const L = Math.hypot(fx, fz);
    if (L > 0) { fx /= L; fz /= L; }
    const healing = this.healUntil && performance.now() < this.healUntil;
    const w = this.heldWeapon();
    this.ads = !!(w && inp.buttons.has(2) && this.combat);
    const sprint = inp.down('sprint') && mz > 0 && !this.ads;
    const jump = inp.down('jump');

    // actions
    if (inp.hit('interact')) this.doInteract();
    if (inp.hit('reload')) this.reload();
    if (inp.hit('heal')) this.net.emit('act', { a: 'heal' });
    if (inp.hit('drop')) this.net.emit('act', { a: 'drop' });
    for (let s = 0; s < 4; s++) if (inp.hit('slot' + (s + 1))) this.selectSlot(s);
    if (inp.wheel && this.combat && this.inv) {
      const avail = [0, 1, 2, 3].filter((s) => s === 0 || this.inv.slots[s - 1]);
      const i = avail.indexOf(this.inv.held);
      const ni = (i + (inp.wheel > 0 ? 1 : -1) + avail.length) % avail.length;
      this.selectSlot(avail[ni]);
    }
    if (w && this.combat) {
      const def = WEAPONS[w.t];
      // a quick click (press + release inside one frame) still fires one shot
      const want = def.auto ? (inp.buttons.has(0) || inp.clicked.has(0)) : inp.clicked.has(0);
      if (want) this.tryShoot(w, def);
    } else if (inp.clicked.has(0) || (inp.buttons.has(0) && this.mode !== 'tag' && this.mode !== 'hotpotato' && performance.now() - this.lastPunch > FISTS.interval * 1000 + 50)) {
      this.tryPunch();
    }
    return { fx, fz, sprint, jump: jump && !healing };
  }

  heldWeapon() {
    if (!this.inv || !this.combat || this.myCarry) return null;
    return this.inv.held > 0 ? this.inv.slots[this.inv.held - 1] : null;
  }

  selectSlot(s) {
    if (!this.combat || !this.inv) return;
    if (s > 0 && !this.inv.slots[s - 1]) return;
    if (this.inv.held === s) return;
    this.inv.held = s;
    this.updateViewmodelHeld();
    this.hud.stopProgress();
    this.net.emit('act', { a: 'slot', s });
  }

  reload() {
    const w = this.heldWeapon();
    if (!w) return;
    const def = WEAPONS[w.t];
    if (w.mag >= def.mag || !(this.inv.ammo[def.ammo] > 0)) { if (!(this.inv.ammo[def.ammo] > 0)) this.hud.pickup(`No ${AMMO[def.ammo].name}!`, '#ff8fa3'); return; }
    this.net.emit('act', { a: 'reload' });
  }

  tryPunch() {
    const now = performance.now();
    if (now - this.lastPunch < FISTS.interval * 1000) return;
    this.lastPunch = now;
    this.vm.punch();
    audio.play('whoosh', { vol: 0.7 });
    this.net.emit('act', { a: 'punch', yaw: this.yaw, pitch: this.pitch });
  }

  tryShoot(w, def) {
    const now = performance.now();
    if (now - this.lastShot < def.interval * 1000) return;
    if (this.vm.reloadT > 0) return;
    if (w.mag <= 0) {
      if (now - this.lastShot > 300) { audio.play('dry'); this.lastShot = now; this.reload(); }
      return;
    }
    this.lastShot = now;
    w.mag--; // predicted; server sends the authoritative value
    const dir = lookDir(this.yaw, this.pitch);
    this.net.emit('act', { a: 'shoot', d: [dir.x, dir.y, dir.z], yaw: this.yaw, pitch: this.pitch, ads: this.ads });
    this.vm.shoot(def.recoil);
    this.pitch = Math.min(1.54, this.pitch + def.recoil * 0.35);
    this.yaw += (Math.random() - 0.5) * def.recoil * 0.2;
    audio.play('shot', { w: w.t });
    // local tracer + impact prediction
    const eye = this.camera.position;
    for (let k = 0; k < Math.min(def.pellets, 5); k++) {
      const s = def.spread * (this.ads ? 0.55 : 1);
      const dx = dir.x + (Math.random() - 0.5) * 2 * s, dy = dir.y + (Math.random() - 0.5) * 2 * s, dz = dir.z + (Math.random() - 0.5) * 2 * s;
      const L = Math.hypot(dx, dy, dz);
      const hit = this.world.raycast(eye.x, eye.y, eye.z, dx / L, dy / L, dz / L, def.range, (b) => !b.glass);
      const t = hit ? hit.t : def.range;
      const ex = eye.x + dx / L * t, ey = eye.y + dy / L * t, ez = eye.z + dz / L * t;
      // tracer starts at the gun muzzle (approx. in world space)
      const r = { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) };
      this.effects.tracer(eye.x + dir.x * 0.6 + r.x * 0.18, eye.y - 0.15 + dir.y * 0.6, eye.z + dir.z * 0.6 + r.z * 0.18, ex, ey, ez, w.t === 'blaster' ? 0xc77dff : 0xfff2a0);
      if (hit) this.effects.impact(ex, ey, ez, hit.nx, hit.ny, hit.nz, false);
    }
  }

  // ------------------------------------------------------------------ interaction
  findInteract() {
    const eye = this.camera.position;
    const fwd = _v.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const b = this.body;
    let best = null, bestScore = Infinity;
    const consider = (kind, id, x, y, z, range, label) => {
      const dx = x - eye.x, dy = y - eye.y, dz = z - eye.z;
      const hd = Math.hypot(x - b.x, z - b.z);
      if (hd > range || Math.abs(y - (b.y + 0.8)) > 2.4) return;
      const dist = Math.hypot(dx, dy, dz);
      const dot = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / (dist || 1);
      if (dot < 0.55 && hd > 1.1) return;
      const score = (1 - dot) * 4 + dist * 0.3;
      if (score < bestScore) {
        // line of sight check
        const hit = this.world.raycast(eye.x, eye.y, eye.z, dx / dist, dy / dist, dz / dist, dist, (bx) => !bx.glass && bx.m !== 'container' && bx.m !== 'bench' && bx.id !== id);
        if (hit && hit.t < dist - 0.6) return;
        bestScore = score; best = { kind, id, label };
      }
    };
    const ms = this.modeState;
    if (this.mode === 'hotpotato' && ms.holder === this.me) {
      for (const p of this.players.values()) {
        if (p.num === this.me || !p.alive || p.left) continue;
        consider('player', p.num, p.x, p.y + 1.2, p.z, 2.8, `Pass the Boob-tato to ${p.name}`);
      }
    }
    if (this.mode === 'grab' && ms.item && ms.item.state === 'ground') consider('chicken', 0, ms.item.x, ms.item.y + 0.4, ms.item.z, 2.4, 'Grab the Golden Rubber Chicken');
    for (const l of this.loot.values()) consider('loot', l.data.id, l.data.x, l.data.y + 0.3, l.data.z, 2.3, 'Pick up ' + itemLabel(l.data));
    if (this.combat) {
      for (const c of this.worldObjs.containers.values()) {
        if (c.opened) continue;
        const dims = CONTAINER_DIMS[c.def.kind];
        consider('container', c.def.id, c.def.x, c.def.y + dims.h * 0.6, c.def.z, 2.3, 'Search ' + dims.name);
      }
    }
    if (this.crafting) {
      for (const bn of this.worldObjs.benches.values()) consider('bench', bn.def.id, bn.def.x, bn.def.y + 1.0, bn.def.z, 2.9, 'Use crafting bench');
      for (const r of this.worldObjs.resources.values()) {
        if (r.left <= 0) continue;
        consider('res', r.def.id, r.def.x, r.def.y + 0.5, r.def.z, 2.6, `Harvest ${RESOURCE_NODES[r.def.kind].name}`);
      }
    }
    for (const d of this.worldObjs.doors.values()) {
      const def = d.def;
      consider('door', def.id, (def.x0 + def.x1) / 2, def.y0 + 1.2, (def.z0 + def.z1) / 2, 2.4, d.open ? 'Close door' : 'Open door');
    }
    return best;
  }

  doInteract() {
    const t = this.interactTarget;
    if (!t) return;
    if (t.kind === 'bench') { this.openInventory(true); return; }
    this.vm.use();
    this.net.emit('act', { a: 'use', k: t.kind, id: t.id, yaw: this.yaw, pitch: this.pitch });
  }

  // ------------------------------------------------------------------ spectating
  startSpectate() {
    const alive = [...this.players.values()].filter((p) => p.alive && !p.left && p.num !== this.me);
    if (!alive.length) { this.spectating = -1; this.hud.setSpectate(null); return; }
    this.spectating = alive[0].num;
    this.hud.setSpectate(alive[0].name);
    this.vm.visible = false;
  }
  cycleSpectate(dir) {
    const alive = [...this.players.values()].filter((p) => p.alive && !p.left && p.num !== this.me);
    if (!alive.length) return;
    let i = alive.findIndex((p) => p.num === this.spectating);
    i = (i + dir + alive.length) % alive.length;
    this.spectating = alive[i].num;
    this.hud.setSpectate(alive[i].name);
  }

  // ------------------------------------------------------------------ frame loop
  frame() {
    if (!this.running) return;
    const now = performance.now();
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > 0.1) dt = 0.1;
    const t = now / 1000;

    const inputState = this.handleInput(dt);
    // local physics
    if (this.alive && this.state !== 'loading') {
      const frozen = this.state !== 'playing';
      const steps = Math.ceil(dt / 0.02);
      const sdt = dt / steps;
      let landed = 0, stepped = 0, jumped = false;
      for (let i = 0; i < steps; i++) {
        const ev = stepBody(this.world, this.body, frozen ? { fx: 0, fz: 0, sprint: false, jump: false } : inputState, sdt, { speedMul: (this.speedMul || 1) * (this.ads ? 0.6 : 1) });
        landed = Math.max(landed, ev.landed); stepped += ev.stepped; jumped = jumped || ev.jumped;
      }
      if (stepped > 0 && this.body.onGround) this.camYOff -= stepped;
      if (landed > 4) { this.camYOff -= Math.min(0.25, landed * 0.015); this.vm.land(landed); audio.play('land', { impact: landed }); }
      if (jumped) audio.play('jump');
      const sp = Math.hypot(this.body.vx, this.body.vz);
      if (this.body.onGround && sp > 1) {
        this.stepAcc += sp * dt;
        if (this.stepAcc > (inputState.sprint ? 2.2 : 1.7)) { this.stepAcc = 0; audio.play('step', { surface: this.map.theme.ground.m }); }
      }
    }
    this.camYOff *= Math.pow(0.0001, dt);
    if (Math.abs(this.camYOff) < 0.001) this.camYOff = 0;

    // send state
    if (now - this.lastSend >= SEND_MS && this.alive && (this.state === 'playing' || this.state === 'countdown')) {
      this.lastSend = now;
      const moving = Math.hypot(this.body.vx, this.body.vz) > 0.5;
      const flags = (moving ? 1 : 0) | (inputState.sprint && moving ? 2 : 0) | (this.body.onGround ? 4 : 0);
      this.net.volatile('st', [++this.seq, r2(this.body.x), r2(this.body.y), r2(this.body.z), r3(this.yaw), r3(this.pitch), flags, this.tpSeq, Math.round(this.net.rtt)]);
    }

    // camera
    const cam = this.camera;
    if (this.alive || this.spectating < 0) {
      cam.position.set(this.body.x, this.body.y + PHYS.EYE_HEIGHT + this.camYOff, this.body.z);
      cam.rotation.set(this.pitch, this.yaw, 0);
    }
    this.updateRemotes(dt, t);
    if (!this.alive && this.spectating >= 0) {
      const p = this.players.get(this.spectating);
      if (!p || !p.alive || p.left) this.startSpectate();
      else {
        cam.position.set(p.x, p.y + PHYS.EYE_HEIGHT, p.z);
        cam.rotation.set(p.pitch, p.yaw, 0);
        if (p.avatar3d) p.avatar3d.root.visible = false;
      }
    }
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      cam.rotation.x += (Math.random() - 0.5) * this.shake * 0.05;
      cam.rotation.y += (Math.random() - 0.5) * this.shake * 0.05;
    }
    // fov: zoom follows the viewmodel's eased aim amount, so FOV, sensitivity and the sights move together
    const w = this.heldWeapon();
    if (w) this.adsMaxZoom = WEAPONS[w.t].zoom;
    const adsK = this.vm.ads > 0.001 ? this.vm.ads : 0;
    const zoom = 1 + ((this.adsMaxZoom || 1) - 1) * adsK;
    this.adsZoom = zoom;
    const sprinting = inputState.sprint && Math.hypot(this.body.vx, this.body.vz) > 6;
    const targetFov = settings.fov / zoom + (sprinting ? 5 : 0);
    if (Math.abs(cam.fov - targetFov) > 0.05) { cam.fov += (targetFov - cam.fov) * Math.min(1, dt * 12); cam.updateProjectionMatrix(); }
    this.hud.crosshair.classList.toggle('hidden', !!(this.ads && w && w.t === 'sniper' && adsK > 0.6));
    this.hud.crosshair.classList.toggle('dot', !!this.ads);
    audio.setListener(cam.position.x, cam.position.y, cam.position.z, cam.rotation.y); // follows the spectated view too

    // interaction prompt (10 Hz)
    this.interactCheckT -= dt;
    if (this.interactCheckT <= 0) {
      this.interactCheckT = 0.1;
      this.interactTarget = this.alive && this.state === 'playing' ? this.findInteract() : null;
      this.hud.prompt(this.interactTarget ? this.interactTarget.label : null, keyName(settings.keys.interact));
    }

    this.updateWorldObjects(dt, t);
    if (this.state === 'playing' && !this.ended) this.updateTension(dt);
    this.vm.update(dt, { speed: Math.hypot(this.body.vx, this.body.vz), grounded: this.body.onGround, sprint: sprinting, ads: this.ads });
    if (this.vm.state === 'weapon' && this.inv && this.inv.held > 0 && this.vm.reloadT <= 0 && this.hud.progress && this.hud.progress.label === 'Reloading…') { /* finishes on its own */ }
    this.effects.update(dt, cam.position);
    // shadow camera follows the player
    if (this.sun.castShadow) {
      const sx = Math.round(cam.position.x / 4) * 4, sz = Math.round(cam.position.z / 4) * 4;
      this.sun.position.set(sx + this.sunDir.x * 60, this.sunDir.y * 60, sz + this.sunDir.z * 60);
      this.sun.target.position.set(sx, 0, sz);
      this.sun.target.updateMatrixWorld();
    }
    this.sky.position.set(cam.position.x, 0, cam.position.z);
    this.hud.update(dt);

    const r = this.renderer;
    r.clear();
    r.render(this.scene, cam);
    if (this.alive && this.vm.visible) {
      r.clearDepth();
      r.render(this.vm.scene, this.vm.camera);
    }
    this.input.endFrame();
  }

  updateRemotes(dt, t) {
    const renderT = this.net.serverNow() - NET.INTERP_DELAY_MS;
    for (const p of this.players.values()) {
      if (p.num === this.me) { p.x = this.body.x; p.y = this.body.y; p.z = this.body.z; p.yaw = this.yaw; p.pitch = this.pitch; continue; }
      const b = p.buf;
      if (b.length) {
        let i = b.length - 1;
        while (i > 0 && b[i].t > renderT) i--;
        const a = b[i], c = b[Math.min(i + 1, b.length - 1)];
        let k = c.t > a.t ? (renderT - a.t) / (c.t - a.t) : 1;
        k = Math.max(0, Math.min(1.2, k));
        const nx = a.x + (c.x - a.x) * k, ny = a.y + (c.y - a.y) * k, nz = a.z + (c.z - a.z) * k;
        const sp = Math.hypot(nx - p.x, nz - p.z) / Math.max(dt, 0.001);
        p.speed = p.speed * 0.8 + Math.min(12, sp) * 0.2;
        p.x = nx; p.y = ny; p.z = nz;
        p.yaw = lerpAngle(a.yaw, c.yaw, Math.min(1, k));
        p.pitch = a.pitch + (c.pitch - a.pitch) * Math.min(1, k);
        p.flags = c.f;
      }
      if (p.avatar3d && !p.left) {
        const vis = p.alive || p.avatar3d.deadT >= 0;
        p.avatar3d.root.visible = vis && !(this.spectating === p.num && !this.alive);
        p.avatar3d.update({ x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, speed: p.speed, grounded: !!(p.flags & 4), sprint: !!(p.flags & 2) }, dt, t);
        // footsteps for nearby players
        if (p.alive && p.speed > 1.5 && (p.flags & 4)) {
          p.stepAcc = (p.stepAcc || 0) + p.speed * dt;
          if (p.stepAcc > 2) { p.stepAcc = 0; audio.play('step', { pos: { x: p.x, y: p.y, z: p.z }, soft: true, maxDist: 25, vol: 0.6 }); }
        }
      }
    }
  }

  updateWorldObjects(dt, t) {
    for (const d of this.worldObjs.doors.values()) {
      const target = d.open ? 1 : 0;
      if (d.cur !== target) {
        d.cur += Math.sign(target - d.cur) * Math.min(Math.abs(target - d.cur), dt * 4);
        d.pivot.rotation.y = d.base + d.openAngle * easeInOut(d.cur);
      } else d.pivot.rotation.y = d.base + d.openAngle * d.cur;
    }
    for (const c of this.worldObjs.containers.values()) {
      if (c.opened && c.anim < 1) c.anim = Math.min(1, c.anim + dt * 3);
      const lid = c.model.userData.lid;
      if (lid.userData.axis === 'x') lid.rotation.x = -c.anim * 1.6;
      else lid.rotation.y = c.anim * 1.8;
    }
    for (const l of this.loot.values()) {
      l.mesh.rotation.y += dt * 1.2;
      l.mesh.position.y = l.data.y + 0.08 + Math.sin(t * 2.5 + l.phase) * 0.06;
    }
    for (const bn of this.worldObjs.benches.values()) {
      const s = bn.model.userData.sign;
      s.visible = this.crafting;
      s.position.y = 2.2 + Math.sin(t * 2) * 0.08;
    }
    if (this.worldObjs.table) {
      this.worldObjs.table.visible = this.mode === 'grab';
      this.worldObjs.table.userData.ring.rotation.z += dt;
    }
    if (this.chicken && this.chicken.visible) {
      this.chicken.rotation.y += dt * 1.5;
      this.chicken.children[0].position.y = Math.sin(t * 3) * 0.1;
    }
    if (this.worldObjs.root.userData.water) {
      const wtr = this.worldObjs.root.userData.water;
      wtr.material.map.offset.x = (t * 0.01) % 1;
    }
    // potato glow as the fuse runs out
    const ms = this.modeState;
    if (this.mode === 'hotpotato' && ms.popAt) {
      const left = (ms.popAt - this.net.serverNow()) / 1000;
      const heat = Math.max(0, Math.min(1, 1 - left / 8));
      const apply = (obj) => { if (obj && obj.userData.mat) obj.userData.mat.emissive.setRGB(heat * 0.8 * (0.6 + 0.4 * Math.sin(t * (6 + heat * 20))), 0, 0); };
      for (const p of this.players.values()) if (p.avatar3d && p.avatar3d.carryObj && p.avatar3d.carry === 'potato') apply(p.avatar3d.carryObj);
      if (this.vm.item && this.vm.state === 'potato') apply(this.vm.item);
      if (heat > 0 && !ms.intermissionUntil) {
        this._fuseAcc = (this._fuseAcc || 0) + dt;
        const interval = 0.6 - heat * 0.5;
        if (this._fuseAcc > interval) { this._fuseAcc = 0; audio.play('fuse', { vol: ms.holder === this.me ? 1 : 0.5 }); }
      }
    }
  }

  // Danger warnings, heartbeat and music intensity from the current mode state.
  updateTension(dt) {
    const ms = this.modeState || {};
    const me = this.body;
    const now = this.net.serverNow();
    const distTo = (n) => { const p = this.players.get(n); return p && p.alive && !p.left ? Math.hypot(p.x - me.x, p.z - me.z) : Infinity; };
    let warn = null, beat = 0, hot = 0;
    const left = ms.endsAt ? (ms.endsAt - now) / 1000 : 999;
    if (this.mode === 'tag') {
      if (ms.it !== this.me && this.alive) {
        const d = distTo(ms.it);
        if (d < 12) { warn = d < 6 ? '⚠️ IT IS RIGHT BEHIND YOU!' : '⚠️ IT is close — run!'; beat = d < 6 ? 0.45 : 0.75; }
        hot = Math.max(0, 1 - d / 25);
      } else hot = 0.6;
      if (left < 20) hot = Math.max(hot, 0.85);
    } else if (this.mode === 'hotpotato') {
      if (ms.popAt && !ms.intermissionUntil) hot = Math.max(0, Math.min(1, 1 - (ms.popAt - now) / 12000));
      if (ms.holder >= 0 && ms.holder !== this.me && this.alive) {
        const d = distTo(ms.holder);
        if (d < 7) { warn = '🔥 The Boob-tato is coming for you!'; beat = 0.7; }
      }
    } else if (this.mode === 'grab') {
      const it = ms.item || {};
      if (it.carrier >= 0 && it.carrier !== this.me && ms.deliverStart) { warn = `⚠️ ${this.players.get(it.carrier)?.name || '?'} is delivering — stop them!`; hot = 1; }
      else if (it.carrier === this.me) hot = ms.deliverStart ? 1 : 0.7;
      else if (it.carrier >= 0) hot = 0.5;
    } else if (this.combat && this.alive) {
      const aliveN = [...this.players.values()].filter((p) => p.alive && !p.left).length;
      hot = aliveN <= 2 ? 1 : aliveN <= 3 ? 0.7 : 0.25;
      const hp = this.inv ? this.inv.hp : 100;
      if (hp > 0 && hp <= 25) { beat = 0.85; if (!warn && hp <= 15) warn = '🩹 Low health — heal up!'; }
    }
    if (!this.alive) { warn = null; beat = 0; }
    this.hud.warn(warn);
    audio.setIntensity(hot);
    if (beat) {
      this.beatT = (this.beatT || 0) - dt;
      if (this.beatT <= 0) { this.beatT = beat; audio.play('heartbeat', { v: 0.7 }); }
    } else this.beatT = 0;
  }

  // markers for objectives (used by the HUD)
  markerList() {
    const out = [];
    const ms = this.modeState || {};
    const me = this.body;
    const P = (n) => this.players.get(n);
    const add = (key, x, y, z, icon, label, color) => out.push({ key, x, y, z, icon, label, color, dist: Math.hypot(x - me.x, z - me.z) });
    if (this.state !== 'playing' && this.state !== 'countdown') return out;
    if (this.mode === 'tag') {
      if (ms.it === this.me) {
        let best = null, bd = Infinity;
        for (const p of this.players.values()) if (p.num !== this.me && p.alive && !p.left) { const d = Math.hypot(p.x - me.x, p.z - me.z); if (d < bd) { bd = d; best = p; } }
        if (best) add('t' + best.num, best.x, best.y + 2.6, best.z, '🎯', best.name, '#ffd23f');
      } else if (ms.it >= 0 && P(ms.it)) { const p = P(ms.it); add('it', p.x, p.y + 3.2, p.z, '🔴', 'IT', '#ff4d6d'); }
    } else if (this.mode === 'hotpotato') {
      if (ms.holder >= 0 && ms.holder !== this.me && P(ms.holder)) { const p = P(ms.holder); add('pot', p.x, p.y + 3.2, p.z, '🔥', '', '#ff9f1c'); }
    } else if (this.mode === 'grab') {
      const t = this.map.grab.table;
      add('table', t.x, t.y + 2.5, t.z, '🏁', 'TABLE', '#ffd23f');
      if (ms.item) {
        if (ms.item.carrier >= 0 && ms.item.carrier !== this.me && P(ms.item.carrier)) { const p = P(ms.item.carrier); add('chk', p.x, p.y + 3.2, p.z, '🐔', p.name, '#ffd23f'); }
        else if (ms.item.state !== 'carried') add('chk', ms.item.x, ms.item.y + 1.5, ms.item.z, '🐔', '', '#ffd23f');
      }
    } else if (this.mode === 'craft' && this.inv) {
      let best = null, bd = Infinity;
      for (const b of this.map.benches) { const d = Math.hypot(b.x - me.x, b.z - me.z); if (d < bd) { bd = d; best = b; } }
      if (best && bd > 4) add('bench', best.x, best.y + 2.5, best.z, '🛠️', 'Bench', '#4cc9f0');
    }
    return out;
  }

  project(x, y, z) {
    _v.set(x, y, z).project(this.camera);
    const behind = _v.z > 1;
    return { x: (_v.x * 0.5 + 0.5) * window.innerWidth, y: (-_v.y * 0.5 + 0.5) * window.innerHeight, behind };
  }

  // ------------------------------------------------------------------ panels
  closePanel() {
    if (!this.panel) return;
    this.panel.el.remove();
    this.panel = null;
    this.invPanelRefresh = null;
  }

  openPause() {
    this.closePanel();
    const el = h('div', { class: 'game-panel' },
      h('div', { class: 'card pause-menu' },
        h('h2', { text: 'Paused' }),
        h('div', { class: 'hint', text: 'The match keeps running while you are paused!' }),
        h('button', { class: 'btn green big', text: 'Resume', onClick: () => { this.closePanel(); this.input.lock(); } }),
        h('button', { class: 'btn cyan', text: 'Settings', onClick: () => this.app.openSettingsModal() }),
        h('button', { class: 'btn purple', text: 'Controls', onClick: () => this.app.showControls() }),
        h('button', { class: 'btn red', text: 'Leave match', onClick: () => this.app.leaveMatchConfirm() })));
    this.hudWrap.appendChild(el);
    this.panel = { kind: 'pause', el };
  }

  openInventory(atBench) {
    this.closePanel();
    this.input.unlock();
    const body = h('div', { class: 'inv-grid' });
    const el = h('div', { class: 'game-panel', onMousedown: (e) => { if (e.target === el) { this.closePanel(); this.input.lock(); } } },
      h('div', { class: 'card' },
        h('div', { class: 'row', style: { marginBottom: '12px' } },
          h('h2', { style: { margin: 0 }, text: atBench && this.crafting ? '🛠️ Crafting Bench' : '🎒 Inventory' }),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn small gray', text: `Close (${keyName(settings.keys.inventory)})`, onClick: () => { this.closePanel(); this.input.lock(); } })),
        body));
    this.hudWrap.appendChild(el);
    this.panel = { kind: 'inventory', el };
    let cat = 'weapon';
    const render = () => {
      const inv = this.inv;
      if (!inv) return;
      const nearBench = this.map.benches.some((b) => Math.hypot(b.x - this.body.x, b.z - this.body.z) < 3.4 && Math.abs(b.y - this.body.y) < 2);
      const left = h('div', { class: 'inv-col' },
        h('h3', { text: 'Weapons' }),
        inv.slots.map((s, i) => h('div', { class: 'mat-row' }, `Slot ${i + 1}: `, s ? `${WEAPONS[s.t].name} (${s.mag}/${WEAPONS[s.t].mag})` : '— empty —')),
        h('h3', { style: { marginTop: '14px' }, text: 'Ammo & supplies' }),
        Object.keys(AMMO).map((a) => h('div', { class: 'mat-row' }, h('span', { class: 'sw', style: { width: '12px', height: '12px', borderRadius: '3px', background: AMMO[a].color, display: 'inline-block' } }), AMMO[a].name, h('span', { class: 'n', text: String(inv.ammo[a] || 0) }))),
        h('div', { class: 'mat-row' }, '🩹 Bandages', h('span', { class: 'n', text: String(inv.heals.bandage || 0) })),
        h('div', { class: 'mat-row' }, '💊 Medkits', h('span', { class: 'n', text: String(inv.heals.medkit || 0) })),
        h('div', { class: 'mat-row' }, '🛡 Armor', h('span', { class: 'n', text: String(inv.armor || 0) })),
        this.crafting ? [h('h3', { style: { marginTop: '14px' }, text: 'Materials' }),
          MATERIAL_IDS.map((m) => h('div', { class: 'mat-row' }, h('span', { style: { width: '12px', height: '12px', borderRadius: '3px', background: MATERIALS[m].color, display: 'inline-block' } }), MATERIALS[m].name, h('span', { class: 'n', text: String(inv.mats[m] || 0) })))] : null);
      let right;
      if (this.crafting) {
        const cats = [['weapon', 'Weapons'], ['ammo', 'Ammo'], ['heal', 'Healing'], ['armor', 'Armor']];
        right = h('div', { class: 'inv-col' },
          h('h3', { text: 'Recipes' }),
          h('div', { class: nearBench ? 'hint' : 'err', text: nearBench ? 'You are at a crafting bench.' : 'Stand next to a crafting bench (🛠️ marker) to craft.' }),
          h('div', { class: 'cat-tabs' }, cats.map(([id, n]) => h('button', { class: 'opt-btn' + (cat === id ? ' sel' : ''), text: n, onClick: () => { cat = id; render(); } }))),
          h('div', { class: 'craft-list' }, RECIPES.filter((r) => r.cat === cat).map((r) => {
            const can = Object.entries(r.cost).every(([k, n]) => (inv.mats[k] || 0) >= n);
            return h('div', { class: 'recipe' + (can ? ' can' : '') },
              h('div', { class: 'grow' },
                h('div', { class: 'rname', text: r.name }),
                h('div', { class: 'cost' }, Object.entries(r.cost).map(([k, n]) => h('span', { class: (inv.mats[k] || 0) >= n ? 'have' : 'need', text: `${MATERIALS[k].name} ${inv.mats[k] || 0}/${n}` })))),
              h('button', { class: 'btn small green', text: 'Craft', disabled: !(can && nearBench), onClick: () => { this.net.emit('act', { a: 'craft', r: r.id }); } }));
          })));
      } else {
        right = h('div', { class: 'inv-col' },
          h('h3', { text: 'Tips' }),
          h('p', { class: 'hint', text: 'Search buildings and containers (E) for weapons, ammo, bandages, medkits and armor.' }),
          h('p', { class: 'hint', text: `${keyName(settings.keys.heal)}: heal · ${keyName(settings.keys.reload)}: reload · ${keyName(settings.keys.drop)}: drop weapon · Right mouse: aim` }));
      }
      mount(body, left, right);
    };
    this.invPanelRefresh = render;
    render();
  }

  // ------------------------------------------------------------------ teardown
  end() {
    this.ended = true;
    audio.stopMatchMusic();
    audio.setIntensity(0);
    this.hud.warn(null);
    this.input.unlock();
    this.closePanel();
    this.hud.prompt(null);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    audio.stopMatchMusic();
    audio.setIntensity(0);
    this.running = false;
    if (this.renderer) this.renderer.setAnimationLoop(null);
    for (const u of this.unsubs) u();
    window.removeEventListener('resize', this.onResize);
    if (this.input) this.input.dispose();
    if (this.hud) this.hud.dispose();
    // free GPU memory before the next match (three.js re-uploads anything reused later)
    if (this.scene) disposeTree(this.scene);
    if (this.vm && this.vm.scene) disposeTree(this.vm.scene);
    if (this.sun && this.sun.shadow && this.sun.shadow.map) this.sun.shadow.map.dispose();
    if (this.effects) this.effects.dispose();
    clear(this.root);
    this.root.classList.add('hidden');
    if (this.renderer) this.renderer.renderLists.dispose();
  }
}

function tick() { return new Promise((r) => setTimeout(r, 0)); }
function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose?.();
    }
  });
}
function cancelled() { const e = new Error('Loading was cancelled.'); e.cancelled = true; return e; }
function r2(v) { return Math.round(v * 100) / 100; }
function r3(v) { return Math.round(v * 1000) / 1000; }
function lerpAngle(a, b, k) { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return a + d * k; }
function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
function lootColor(l) {
  if (l.kind === 'weapon') return [0xb0bec5, 0x4cc9f0, 0xc77dff, 0xffb703][WEAPONS[l.t]?.rarity || 0];
  if (l.kind === 'ammo') return 0xffd166;
  if (l.kind === 'heal') return 0x3ddc97;
  if (l.kind === 'armor') return 0x4cc9f0;
  if (l.kind === 'mat') return l.t === 'rare' ? 0xc77dff : 0xffffff;
  return 0xffffff;
}

export { MUZZLE, potatoModel };
