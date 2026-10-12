// Socket.IO wrapper: authenticated connection, request/ack helper, clock sync.
/* global io */
export class Net {
  constructor(token) {
    this.token = token;
    this.socket = null;
    this.offset = 0; // serverTime - localTime
    this.rtt = 80;
    this.bestRtt = Infinity;
    this.handlers = new Map();
    this.connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = (window.yoinkLocal ? window.yoinkLocal.io : io)({ auth: { token: this.token }, transports: ['websocket', 'polling'], reconnectionDelay: 800, reconnectionDelayMax: 4000 });
      this.socket = s;
      let first = true;
      s.on('connect', () => {
        this.connected = true;
        this.syncClock();
        this.emitLocal('net:connect');
        if (first) { first = false; resolve(); }
      });
      s.on('disconnect', (reason) => { this.connected = false; this.emitLocal('net:disconnect', reason); });
      s.on('connect_error', (err) => {
        if (err && err.message === 'unauthorized') {
          this.emitLocal('net:unauthorized');
          if (first) { first = false; reject(new Error('unauthorized')); }
          s.disconnect();
        } else if (first) {
          this.emitLocal('net:error', err);
        }
      });
      s.on('png', (ack) => { if (typeof ack === 'function') ack(); }); // server-side latency probe
      s.onAny((ev, ...args) => this.emitLocal(ev, ...args));
      this.clockTimer = setInterval(() => this.syncClock(), 4000);
    });
  }

  syncClock() {
    if (!this.socket || !this.socket.connected) return;
    const t0 = performance.now();
    const local0 = Date.now();
    this.socket.emit('time:ping', local0, (r) => {
      const rtt = performance.now() - t0;
      this.rtt = this.rtt * 0.7 + rtt * 0.3;
      if (rtt < this.bestRtt * 1.3 || rtt < 40) {
        this.bestRtt = Math.min(this.bestRtt, rtt);
        const est = r.s - (local0 + rtt / 2);
        this.offset = this.offset === 0 ? est : this.offset * 0.6 + est * 0.4;
      }
    });
  }

  serverNow() { return Date.now() + this.offset; }

  on(ev, fn) {
    if (!this.handlers.has(ev)) this.handlers.set(ev, new Set());
    this.handlers.get(ev).add(fn);
    return () => this.handlers.get(ev)?.delete(fn);
  }

  emitLocal(ev, ...args) {
    const set = this.handlers.get(ev);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (e) { console.error('handler error', ev, e); }
    }
  }

  emit(ev, data) { if (this.socket) this.socket.emit(ev, data); }
  volatile(ev, data) { if (this.socket) this.socket.volatile.emit(ev, data); }

  request(ev, data, timeout = 8000) {
    return new Promise((resolve) => {
      if (!this.socket || !this.socket.connected) { resolve({ error: 'Not connected to the server.' }); return; }
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve({ error: 'The server did not respond.' }); } }, timeout);
      this.socket.emit(ev, data, (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r || {}); });
    });
  }

  close() {
    clearInterval(this.clockTimer);
    if (this.socket) { this.socket.removeAllListeners(); this.socket.disconnect(); }
    this.socket = null;
    this.handlers.clear();
  }
}
