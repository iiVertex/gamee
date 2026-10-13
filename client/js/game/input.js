// Keyboard + mouse input with pointer lock.
import { settings } from '../settings.js';

export class Input {
  constructor(el) {
    this.el = el;
    this.keys = new Set();
    this.pressed = new Set(); // edge-triggered this frame
    this.mouseDX = 0; this.mouseDY = 0;
    this.buttons = new Set();
    this.clicked = new Set();
    this.wheel = 0;
    this.locked = false;
    this.enabled = true;
    this.handlers = {};
    // elements that make up the 3D view: right-clicking them never opens the browser menu
    this.surfaces = new Set([el]);
    this._rmbGame = false; // right button went down during gameplay (its context menu must not show)
    this._menuBlockUntil = 0;
    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      if (isTyping(e)) return;
      if (e.code === 'Tab') e.preventDefault();
      if (this.locked && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      this.handlers.key && this.handlers.key(e);
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); };
    this._onMouseMove = (e) => {
      if (!this.locked || (window.__YOINK_TEST__ && !document.pointerLockElement)) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
      this._syncButtons(e);
    };
    this._onMouseDown = (e) => {
      // with real pointer lock all mouse events go to the canvas; automated tests click the game area instead
      if (!this.locked || (window.__YOINK_TEST__ && !(e.target && e.target.closest && e.target.closest('#game-root')))) return;
      this.buttons.add(e.button);
      this.clicked.add(e.button);
      if (e.button === 2) this._rmbGame = true;
      e.preventDefault();
      this._syncButtons(e);
    };
    this._onMouseUp = (e) => {
      this.buttons.delete(e.button);
      if (e.button === 2 && this._rmbGame) { this._rmbGame = false; this._menuBlockUntil = performance.now() + 500; }
      this._syncButtons(e);
    };
    this._onWheel = (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); };
    this._onLockChange = () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === this.el || !!window.__YOINK_TEST__;
      if (!this.locked) this.release();
      if (was !== this.locked) this.handlers.lock && this.handlers.lock(this.locked);
    };
    this._onBlur = () => this.release();
    this._onVisibility = () => { if (document.hidden) this.release(); };
    // no browser menu while playing, on the 3D view, or for a right press that began in-game
    // (Windows fires contextmenu on release, which can land after pausing); menus/chat keep it
    this._onContext = (e) => {
      const fromGame = this._rmbGame || performance.now() < this._menuBlockUntil;
      if (this.locked || fromGame || this.surfaces.has(e.target)) e.preventDefault();
      this._rmbGame = false; this._menuBlockUntil = 0;
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('wheel', this._onWheel, { passive: true });
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('contextmenu', this._onContext);
    document.addEventListener('pointerlockchange', this._onLockChange);
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  // drop every held key/button (focus loss, pause, pointer unlock) so nothing stays stuck
  release() {
    this.keys.clear(); this.buttons.clear(); this.clicked.clear();
    this.mouseDX = 0; this.mouseDY = 0;
  }

  // e.buttons is the true button state: it repairs a lost mouseup (stuck aim/fire) and picks up
  // a right button that was already held when the game took the pointer back
  _syncButtons(e) {
    if (typeof e.buttons !== 'number') return;
    for (const b of this.buttons) if (!(e.buttons & BUTTON_BIT[b])) this.buttons.delete(b);
    if (this.locked && (e.buttons & 2)) this.buttons.add(2);
  }

  lock() {
    if (window.__YOINK_TEST__) { this.locked = true; return; } // automated tests can't grab the pointer
    if (this.locked) return;
    try {
      const p = this.el.requestPointerLock({ unadjustedMovement: false });
      if (p && p.catch) p.catch(() => { try { this.el.requestPointerLock(); } catch { /* ignore */ } });
    } catch { /* ignore */ }
  }
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); }

  down(action) { return this.keys.has(settings.keys[action]); }
  hit(action) { return this.pressed.has(settings.keys[action]); }

  consumeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0; this.mouseDY = 0;
    return d;
  }

  endFrame() { this.pressed.clear(); this.clicked.clear(); this.wheel = 0; }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('contextmenu', this._onContext);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.unlock();
  }
}

// MouseEvent.button -> MouseEvent.buttons bit
const BUTTON_BIT = [1, 4, 2, 8, 16];

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
