// Main menu / lobby hub.
import { h, mount } from '../util/dom.js';
import { avatarImg } from './avatarIcon.js';
import { navIcon, uiIcon, logo } from './art.js';
import { ChatPanel } from './chatPanel.js';
import { PlayTab } from './tabs/play.js';
import { SettingsTab } from './tabs/settingsTab.js';
import { ProfileTab } from './tabs/profile.js';
import { FriendsTab } from './tabs/friends.js';
import { PartyTab } from './tabs/party.js';
import { ArmoryTab } from './tabs/armory.js';
import { CratesTab } from './tabs/crates.js';
import { LOCAL } from '../api.js';

const TABS = [
  { id: 'play', label: 'Play', C: PlayTab },
  { id: 'friends', label: 'Friends', C: FriendsTab },
  { id: 'party', label: 'Party', C: PartyTab },
  { id: 'armory', label: 'Armory', C: ArmoryTab },
  { id: 'crates', label: 'Crates', C: CratesTab },
  { id: 'profile', label: 'Profile', C: ProfileTab },
  { id: 'settings', label: 'Settings', C: SettingsTab },
].filter((t) => !(LOCAL && (t.id === 'friends' || t.id === 'party'))); // bots only: nobody to befriend

export class MenuScreen {
  constructor(app, tab = 'play') {
    this.app = app;
    this.coinsEl = h('span', { class: 'coin-num' });
    this.meName = h('span', { class: 'me-name' });
    this.meSub = h('span', { class: 'me-sub' });
    this.meAvatar = h('span', { class: 'me-av' });
    this.pane = h('main', { class: 'main-pane' });
    this.chat = new ChatPanel(app, LOCAL ? ['lobby'] : ['lobby', 'party']);
    this.connEl = h('span', { class: 'conn-chip hidden', text: 'Reconnecting…' });
    // nav buttons are built once; active state and badges update in place
    this.navBtns = new Map();
    this.nav = h('nav', { class: 'sidenav' }, TABS.map((t) => {
      const badge = h('span', { class: 'badge hidden' });
      const b = h('button', { class: 'navbtn', id: 'nav-' + t.id, dataset: { tab: t.id }, onClick: () => this.setTab(t.id) },
        h('span', { class: 'ico' }, navIcon(t.id)), h('span', { class: 'lbl', text: t.label }), badge);
      this.navBtns.set(t.id, { b, badge });
      return b;
    }));
    this.el = h('div', { class: 'menu' },
      h('header', { class: 'topbar' },
        logo('small'),
        h('div', { class: 'spacer' }),
        this.connEl,
        h('div', { class: 'coins', title: 'Coins — earn them by playing', id: 'coin-balance' }, h('span', { class: 'coin-ico' }), this.coinsEl),
        h('button', { class: 'me-chip', type: 'button', title: 'Your profile', onClick: () => this.setTab('profile') },
          this.meAvatar, h('span', { class: 'me-text' }, this.meName, this.meSub)),
        LOCAL ? null : h('button', { class: 'icon-btn logout', id: 'btn-logout', type: 'button', title: 'Log out', onClick: () => this.app.logout() },
          uiIcon('logout', 'lo-ico'), h('span', { class: 'lo-txt', text: 'Log out' }))),
      this.nav,
      this.pane,
      h('aside', { class: 'side-pane' }, this.chat.el));
    this.unsub = app.on((what) => this.onChange(what));
    this.renderTop();
    this.setTab(tab || 'play');
  }

  onChange(what) {
    if (what === 'user') this.renderTop();
    if (what === 'net') this.connEl.classList.toggle('hidden', !!(this.app.net && this.app.net.connected));
    this.renderNav();
    if (this.current && this.current.onChange) this.current.onChange(what);
  }

  renderTop() {
    const u = this.app.user;
    if (!u) return;
    const coins = String(u.coins ?? 0);
    if (this.coinsEl.textContent !== coins) {
      if (this.coinsEl.textContent) { this.coinsEl.classList.remove('bump'); void this.coinsEl.offsetWidth; this.coinsEl.classList.add('bump'); }
      this.coinsEl.textContent = coins;
    }
    this.meName.textContent = u.username;
    this.meSub.textContent = `${u.wins ?? 0} wins`;
    const key = JSON.stringify(u.avatar || {});
    if (key !== this.avKey) { this.avKey = key; mount(this.meAvatar, avatarImg(u.avatar, 'sm')); }
  }

  renderNav() {
    const s = this.app.social;
    for (const t of TABS) {
      const { b, badge } = this.navBtns.get(t.id);
      b.classList.toggle('active', this.tab === t.id);
      let n = 0;
      if (t.id === 'friends') n = s.incomingCount();
      if (t.id === 'party' && s.party) n = s.party.members.length;
      badge.textContent = String(n);
      badge.classList.toggle('hidden', !n);
    }
  }

  setTab(id) {
    const t = TABS.find((x) => x.id === id) || TABS[0];
    if (this.current && this.current.destroy) this.current.destroy();
    this.tab = t.id;
    this.current = new t.C(this.app, this);
    this.pane.className = 'main-pane tab-' + t.id;
    mount(this.pane, this.current.el);
    this.pane.scrollTop = 0;
    this.renderNav();
  }

  destroy() {
    this.unsub();
    this.chat.destroy();
    if (this.current && this.current.destroy) this.current.destroy();
  }
}
