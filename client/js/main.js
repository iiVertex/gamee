// yoink! client entry: screen routing, session, realtime event wiring.
import { api, session, LOCAL } from './api.js';
import { Net } from './net.js';
import { audio } from './audio.js';
import { ChatStore } from './chat.js';
import { h, mount, toast, modal, confirmBox } from './util/dom.js';
import { AuthScreen } from './ui/auth.js';
import { MenuScreen } from './ui/menu.js';
import { VoteScreen } from './ui/vote.js';
import { LoadingScreen } from './ui/loading.js';
import { ResultsScreen } from './ui/results.js';
import { settingsPanel, controlsPanel } from './ui/settings.js';
import { Social } from './social.js';
import { Game } from './game/Game.js';

class App {
  constructor() {
    this.root = document.getElementById('app');
    this.screen = null;
    this.user = null;
    this.net = null;
    this.game = null;
    this.chat = new ChatStore(this);
    this.social = new Social(this);
    this.queue = null;
    this.lastMode = 'tag';
    this.listeners = new Set();
  }

  async boot() {
    const unlock = () => { audio.init(); if (!this.game) audio.startMusic(); };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
    document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.btn')) audio.play('click'); });
    if (LOCAL) {
      const { token, user } = await window.yoinkLocal.guestLogin();
      return this.onAuthed(token, user, false);
    }
    const token = session.token;
    if (token) {
      const me = await api.me();
      if (me.user) { session.adopt(token); return this.enter(me.user); }
      if (me.status === 401) session.clear();
      this.showAuth(me.status === 401 ? undefined : me.error);
      return;
    }
    this.showAuth();
  }

  // ---------------------------------------------------------------- state
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed(what) { for (const fn of this.listeners) { try { fn(what); } catch (e) { console.error(e); } } }

  setUser(u) { this.user = { ...this.user, ...u }; this.changed('user'); }

  setScreen(screen) {
    if (this.screen && this.screen.destroy) this.screen.destroy();
    this.screen = screen;
    this.root.classList.remove('hidden');
    mount(this.root, screen.el);
    if (screen.mounted) screen.mounted();
  }

  // ---------------------------------------------------------------- auth
  // Back to the login screen: drop everything that belonged to the previous session.
  showAuth(message) {
    clearTimeout(this.resultsTimer);
    this.disposeGame();
    if (this.net) { this.net.close(); this.net = null; }
    this.user = null;
    this.queue = null;
    this.matchId = null;
    this.social.reset();
    this.chat.reset();
    this.setScreen(new AuthScreen(this, message));
  }

  async onAuthed(token, user, remember) {
    session.save(token, remember);
    await this.enter(user);
  }

  async enter(user) {
    this.user = user;
    if (this.net) this.net.close();
    this.net = new Net(session.token);
    this.bindNet();
    try {
      await this.net.connect();
    } catch {
      session.clear();
      this.showAuth('Your session has expired. Please log in again.');
      return;
    }
    if (!this.game) this.showMenu();
  }

  async logout() {
    if (this.game) return toast('Leave the match first.', 'error');
    await api.logout();
    session.clear();
    this.showAuth('You have been logged out.');
  }

  bindNet() {
    const net = this.net;
    this.chat.bind(net);
    this.social.bind(net);
    net.on('hello', (d) => { this.setUser(d.user); });
    net.on('net:unauthorized', () => { session.clear(); this.showAuth('Your session is no longer valid. Please log in again.'); });
    // the session is still valid (another tab took over): only forget this tab's copy
    net.on('auth:kicked', (d) => { session.clearTab(); this.showAuth(d.reason || 'Disconnected.'); });
    net.on('auth:logout', () => { session.clear(); this.showAuth('You were logged out.'); });
    net.on('user:update', (u) => this.setUser(u));
    net.on('queue:update', (q) => { this.queue = q; this.changed('queue'); });
    net.on('queue:left', () => { this.queue = null; this.changed('queue'); });
    net.on('match:vote', (d) => this.onVote(d));
    net.on('match:load', (d) => this.onLoad(d));
    net.on('match:end', (d) => this.onEnd(d));
    // the server drops queues on disconnect without telling us
    net.on('net:disconnect', () => { this.queue = null; this.changed('queue'); this.changed('net'); });
    net.on('net:connect', () => { this.changed('net'); this.checkMatchAfterReconnect(); });
  }

  // ---------------------------------------------------------------- screens
  showMenu(tab) {
    if (this.keepScreenUntil && performance.now() < this.keepScreenUntil) return;
    if (this.screen instanceof MenuScreen) { if (tab) this.screen.setTab(tab); return; }
    this.setScreen(new MenuScreen(this, tab));
    audio.startMusic();
  }

  // A new match starts: forget the previous match's chat.
  enterMatch(matchId) {
    if (this.matchId !== matchId) this.chat.clearMatch();
    this.matchId = matchId;
    clearTimeout(this.resultsTimer);
  }

  onVote(d) {
    this.queue = null;
    this.lastMode = d.mode;
    this.lastPractice = d.practice;
    this.enterMatch(d.matchId);
    if (this.screen instanceof VoteScreen && this.screen.matchId === d.matchId) this.screen.update(d);
    else { this.disposeGame(); this.setScreen(new VoteScreen(this, d)); }
  }

  // After a reconnect the match we were showing may be gone (ended or timed out
  // while we were away): the server tells us which match, if any, we are still in.
  async checkMatchAfterReconnect() {
    if (!this.net || !(this.game || this.screen instanceof VoteScreen)) return;
    const r = await this.net.request('match:status', {});
    if (!r || r.error || !this.net) return;
    if (r.matchId && r.matchId === this.matchId) return;
    if (this.screen instanceof ResultsScreen) return;
    this.disposeGame();
    this.matchId = null;
    this.showMenu('play');
    toast('That match ended while you were disconnected.', 'info');
  }

  async onLoad(d) {
    this.queue = null;
    this.lastMode = d.mode;
    this.lastPractice = d.practice;
    this.enterMatch(d.matchId);
    if (this.game && this.game.matchId === d.matchId && !this.game.disposed) {
      // reconnected to the same match: ask for a fresh snapshot
      this.net.emit('match:ready');
      return;
    }
    this.disposeGame();
    audio.stopMusic();
    const loading = new LoadingScreen(this, d);
    this.setScreen(loading);
    const game = new Game(this);
    this.game = game;
    try {
      await game.load(d, (p, label) => loading.progress(p, label));
      if (this.game !== game) { game.dispose(); return; }
      this.root.classList.add('hidden');
    } catch (e) {
      if (e.cancelled || this.game !== game) return; // replaced or logged out while loading
      console.error(e);
      toast('Failed to load the match: ' + e.message, 'error');
      this.net?.emit('match:leave');
      this.disposeGame();
      this.showMenu();
    }
  }

  onEnd(d) {
    const g = this.game;
    const me = d.results.find((r) => r.num === d.you);
    const won = me && me.won;
    if (d.profile) this.setUser(d.profile);
    audio.play(won ? 'win' : 'lose');
    clearTimeout(this.resultsTimer);
    if (g && !g.disposed && g.running) {
      g.end();
      g.hud.center(won ? '🏆 VICTORY!' : 'DEFEAT', d.reason, 3000);
      if (won) g.effects.confetti(g.camera.position.x, g.camera.position.y + 1, g.camera.position.z, 150);
      // only if nothing else (a new vote, the login screen) took over meanwhile
      this.resultsTimer = setTimeout(() => {
        if (this.game !== g) return;
        this.disposeGame();
        this.setScreen(new ResultsScreen(this, d));
      }, 2600);
    } else {
      this.disposeGame(); // still loading (rejoin): skip straight to the results
      this.setScreen(new ResultsScreen(this, d));
    }
  }

  disposeGame() {
    if (this.game) { this.game.dispose(); this.game = null; }
    this.root.classList.remove('hidden');
  }

  async leaveMatchConfirm() {
    const ok = await confirmBox('Leave match?', 'You will forfeit this match and earn no rewards for it.', 'Leave', 'red');
    if (!ok) return;
    this.net?.emit('match:leave');
    this.disposeGame();
    this.matchId = null;
    this.showMenu();
  }

  // ---------------------------------------------------------------- shared actions
  async play(mode, practice) {
    this.lastMode = mode;
    this.lastPractice = practice;
    const r = await this.net.request('queue:join', { mode, practice });
    if (r.error) { toast(r.error, 'error'); audio.play('error'); return false; }
    // nobody else to wait for: start with bots straight away
    if (LOCAL && !practice) await this.net.request('queue:startNow');
    // practice matches start right away: their map vote arrives before this answer,
    // so a caller's "go back to the menu" must not replace the vote screen
    if (this.screen instanceof VoteScreen) this.keepScreenUntil = performance.now() + 800;
    return true;
  }

  openSettingsModal() {
    modal('Settings', settingsPanel(this, { compact: true }), [{ label: 'Done', class: 'green' }]);
  }

  showControls() { modal('Controls', controlsPanel(), [{ label: 'Close', class: 'green' }]); }

  showProfile(username) { this.social.showProfile(username); }
}

// every module loaded: hand over from the boot screen in index.html
window.__yoinkBooted = true;
document.getElementById('boot')?.remove();

const previewMap = new URLSearchParams(location.search).get('preview');
if (previewMap) {
  // tools/render-previews.mjs uses this to capture map thumbnails
  import('./game/previewRender.js').then(({ renderPreview }) => { renderPreview(previewMap); window.__previewReady = true; });
} else {
  const app = new App();
  window.__yoink = app; // handy for debugging in the console
  app.boot();
}

export { h };
