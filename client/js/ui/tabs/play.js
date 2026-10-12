import { h, mount, toast, fmtTime } from '../../util/dom.js';
import { MODES, MODE_IDS } from '/shared/constants.js';
import { audio } from '../../audio.js';
import { avatarImg } from '../avatarIcon.js';
import { modeArt, modeLength, MODE_TAGLINE } from '../art.js';
import { Showcase } from '../showcase.js';
import { LOCAL } from '../../api.js';

export class PlayTab {
  constructor(app) {
    this.app = app;
    this.mode = app.lastMode || 'tag';
    this.wide = true;

    // left: mode list (built once, selection toggled in place)
    this.cards = h('div', { class: 'modes' }, MODE_IDS.map((id) => {
      const m = MODES[id];
      return h('div', {
        class: 'mode-card', style: { '--mc': m.color }, dataset: { mode: id }, role: 'button', tabindex: '0',
        onClick: () => this.pick(id),
        onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.pick(id); } },
        onMouseenter: () => audio.play('hover'),
      },
      h('div', { class: 'mart' }, modeArt(id)),
      h('div', { class: 'minfo' },
        h('h3', { text: m.name }),
        h('div', { class: 'mtag', text: MODE_TAGLINE[id] || '' }),
        h('div', { class: 'mmeta' },
          h('span', { class: 'mchip', text: `⏱ ${modeLength(m.duration)}` }),
          h('span', { class: 'mchip', text: `👥 ${m.minPlayers}–${m.maxPlayers}` }))),
      h('div', { class: 'mcheck', text: '✓' }));
    }));

    // right: stage with your character / party, and the launch panel
    this.view = h('div', { class: 'stage-view' });
    this.word = h('div', { class: 'stage-word' });
    this.partyStrip = h('div', { class: 'stage-party' });
    this.stats = h('div', { class: 'stage-stats' });
    this.infoArt = h('div', { class: 'li-art' });
    this.infoName = h('div', { class: 'li-name' });
    this.infoDesc = h('div', { class: 'li-desc' });
    this.findBtn = h('button', { class: 'btn big play-btn', id: 'btn-find', onClick: () => this.app.play(this.mode, false).then(() => this.render()) });
    this.practiceBtn = h('button', { class: 'btn big cyan', id: 'btn-practice', onClick: () => this.app.play(this.mode, true) });
    this.note = h('div', { class: 'launch-note' });
    this.launchBtns = h('div', { class: 'launch-btns' }, this.findBtn, this.practiceBtn);
    this.queueSlot = h('div', { class: 'queue-slot' });
    this.stage = h('section', { class: 'stage' },
      h('div', { class: 'stage-glow' }), this.word, this.view,
      h('div', { class: 'stage-top' }, this.partyStrip, this.stats),
      h('div', { class: 'launch' },
        h('div', { class: 'launch-info' }, this.infoArt, h('div', { class: 'grow' }, this.infoName, this.infoDesc)),
        this.launchBtns, this.queueSlot, this.note));

    this.el = h('div', { class: 'play' },
      h('section', { class: 'mode-col' },
        h('div', { class: 'col-head' },
          h('h1', { class: 'pane-title', text: 'Choose a mode' }),
          h('p', { class: 'pane-sub', text: LOCAL ? 'Play against bots. Every match starts with a map vote.' : 'Find a match or practice against bots. Every match starts with a map vote.' })),
        this.cards),
      this.stage);

    this.showcase = null;
    setTimeout(() => this.mountStage(), 0);
    this.render();
    this.timer = setInterval(() => this.renderQueue(), 500);
  }

  mountStage() {
    if (this.destroyed || this.showcase) return;
    this.stageTried = true;
    try {
      this.showcase = new Showcase(this.view, { accent: MODES[this.mode].color, onPoke: () => audio.play('boing') });
      this.view.classList.add('has-3d');
    } catch {
      this.showcase = null;
    }
    this.renderCast();
  }

  pick(id) {
    if (this.mode === id) return;
    this.mode = id;
    this.app.lastMode = id;
    audio.play('click');
    this.render();
  }

  render() {
    const m = MODES[this.mode];
    for (const c of this.cards.children) c.classList.toggle('sel', c.dataset.mode === this.mode);
    this.stage.style.setProperty('--mc', m.color);
    this.word.textContent = m.short || m.name;
    mount(this.infoArt, modeArt(this.mode));
    this.infoName.textContent = m.name;
    this.infoDesc.textContent = m.desc;
    if (this.showcase) this.showcase.setAccent(m.color);

    const s = this.app.social;
    const party = s.party;
    const isLeader = !party || party.leader === this.app.user.id;
    const queued = !!this.app.queue;
    this.findBtn.disabled = queued || !isLeader;
    this.practiceBtn.disabled = queued || !isLeader;
    mount(this.findBtn, h('span', { class: 'bi', text: '▶' }), h('span', { class: 'bl' }, LOCAL ? 'Play' : 'Find match', h('small', { text: LOCAL ? 'vs bots · full coins' : party ? `with your party (${party.members.length})` : 'vs real players' })));
    mount(this.practiceBtn, h('span', { class: 'bi', text: '🤖' }), h('span', { class: 'bl' }, 'Practice', h('small', { text: LOCAL ? 'vs bots · half coins' : party ? 'party vs bots' : 'vs bots' })));
    let note = '';
    if (party && !isLeader) note = 'Only your party leader can start matches. Mark yourself READY in the Party tab.';
    else if (party) note = 'Your whole party joins together. Everyone must be READY.';
    this.note.textContent = note;
    this.note.classList.toggle('hidden', !note);

    this.renderParty();
    this.renderCast();
    this.renderQueue();
  }

  renderParty() {
    const u = this.app.user;
    const party = this.app.social.party;
    const go = () => this.app.screen.setTab('party');
    if (party) {
      mount(this.partyStrip,
        h('div', { class: 'sp-avatars' }, party.members.map((mb) => avatarImg(mb.avatar, 'sm'))),
        h('div', { class: 'sp-text' }, h('b', { text: `Party ${party.members.length}/${party.max}` }), h('span', { text: party.allReady ? 'Everyone is ready' : 'Waiting for READY…' })),
        h('button', { class: 'btn small gray', text: 'Manage', onClick: go }));
    } else {
      mount(this.partyStrip,
        h('div', { class: 'sp-text' }, h('b', { text: 'Playing solo' }), h('span', { text: LOCAL ? 'Offline version: bots only' : 'Team up with up to 3 friends' })),
        LOCAL ? null : h('button', { class: 'btn small purple', text: '+ Invite', onClick: go }));
    }
    const wins = u.wins ?? 0, matches = u.matches ?? 0;
    mount(this.stats,
      h('div', { class: 'stat-chip', title: 'Wins' }, h('span', { text: '🏆' }), h('b', { text: String(wins) }), 'wins'),
      h('div', { class: 'stat-chip', title: 'Matches played' }, h('span', { text: '🎮' }), h('b', { text: String(matches) }), 'played'));
  }

  // 3D (or 2D fallback) line-up of you and your party, with name plates
  renderCast() {
    const u = this.app.user;
    const party = this.app.social.party;
    const members = party ? party.members : [{ id: u.id, username: u.username, avatar: u.avatar, leader: false, ready: false }];
    const plate = (mb) => h('div', { class: 'plate' + (mb.id === u.id ? ' me' : '') },
      h('span', { class: 'plate-name', text: mb.username }),
      party ? h('span', { class: 'plate-tag' + (mb.leader ? ' lead' : mb.ready ? ' ready' : ''), text: mb.leader ? '👑 Leader' : mb.ready ? 'Ready' : 'Not ready' }) : null);
    const avatarOf = (mb) => (mb.id === u.id ? u.avatar : mb.avatar) || {};
    if (this.showcase) {
      this.showcase.setCast(members.map((mb) => ({ key: mb.id, name: mb.username, avatar: avatarOf(mb), el: plate(mb) })), u.id);
      return;
    }
    if (!this.stageTried) return;
    mount(this.view, h('div', { class: 'stage-flat' }, members.map((mb) => h('div', { class: 'flat-slot' }, avatarImg(avatarOf(mb), 'lg'), plate(mb)))));
  }

  renderQueue() {
    const q = this.app.queue;
    if (!q) {
      if (this.q) {
        this.q.el.remove();
        this.q = null;
        this.stage.classList.remove('queued');
        this.render();
      }
      return;
    }
    if (!this.q) this.buildQueue();
    const now = this.app.net.serverNow();
    const n = q.players.length;
    const isHost = !!(q.host && q.host.userId === this.app.user.id);
    let status;
    if (q.countdownEndsAt) {
      const left = Math.max(0, Math.ceil((q.countdownEndsAt - now) / 1000));
      status = isHost ? `${n} real players — start now or wait ${left}s for more` : `Starting in ${left}s with ${n} players (or when ${q.host ? q.host.username : 'the host'} starts it)`;
    } else if (q.soloEndsAt) status = `Waiting for players… bots will fill in ${fmtTime((q.soloEndsAt - now) / 1000)}`;
    else status = 'Waiting for players…';
    // update text in place so clicks on Cancel / Start now are never lost
    const r = this.q;
    const title = `Searching · ${MODES[q.mode].name}`;
    if (r.title.textContent !== title) r.title.textContent = title;
    if (r.status.textContent !== status) r.status.textContent = status;
    const count = `${q.players.length}/${q.max}`;
    if (r.count.textContent !== count) r.count.textContent = count;
    r.el.style.setProperty('--qfill', String(Math.min(1, q.players.length / Math.max(1, q.max))));
    r.el.style.setProperty('--mc', MODES[q.mode].color);
    const names = q.players.map((p) => p.username).join('\n');
    if (names !== r.names) {
      r.names = names;
      mount(r.pills, q.players.map((p) => h('span', { class: 'pill', text: p.username })));
    }
    // the host can start at once: 2+ players play without bots, a lone player gets bots
    const label = n >= 2 ? `▶ Start now (${n} players)` : '▶ Start now with bots';
    if (r.startNow.textContent !== label) r.startNow.textContent = label;
    r.startNow.classList.toggle('hidden', !isHost);
  }

  buildQueue() {
    const startNow = h('button', { class: 'btn green', id: 'btn-start-now', text: '▶ Start now with bots', onClick: async () => {
      const res = await this.app.net.request('queue:startNow');
      if (res.error) toast(res.error, 'error');
    } });
    const cancel = h('button', { class: 'btn gray', id: 'btn-cancel-queue', text: 'Cancel', onClick: async () => {
      cancel.disabled = true;
      await this.app.net.request('queue:leave');
      this.app.queue = null;
      this.app.changed('queue');
    } });
    const r = { title: h('div', { class: 'q-title' }), status: h('div', { class: 'q-status' }), count: h('div', { class: 'q-count' }), pills: h('div', { class: 'pill-list' }), startNow, names: null };
    r.el = h('div', { class: 'queue-box', id: 'queue-box' },
      h('div', { class: 'q-ring' }, h('div', { class: 'q-spin' }), r.count),
      h('div', { class: 'q-main' }, r.title, r.status, r.pills),
      h('div', { class: 'q-actions' }, startNow, cancel));
    this.q = r;
    this.queueSlot.appendChild(r.el);
    this.stage.classList.add('queued');
  }

  onChange(what) { if (what === 'queue' || what === 'party' || what === 'user') this.render(); }

  destroy() {
    this.destroyed = true;
    clearInterval(this.timer);
    if (this.showcase) { this.showcase.destroy(); this.showcase = null; }
  }
}
