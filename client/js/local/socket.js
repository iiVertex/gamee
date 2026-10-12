// In-page stand-in for Socket.IO (static build): the game server runs in the same
// page, so "sockets" are paired objects that pass messages to each other. Messages
// are copied as JSON and delivered asynchronously, like they would be over the wire.
// Only the parts of the Socket.IO API that yoink! uses are implemented.

const wire = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function send(target, ev, args) {
  const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
  const payload = args.map(wire);
  queueMicrotask(() => {
    if (!target.connected) return;
    if (ack) {
      let used = false;
      payload.push((...resp) => {
        if (used) return;
        used = true;
        const r = resp.map(wire);
        queueMicrotask(() => ack(...r));
      });
    }
    target._incoming(ev, payload);
  });
}

class Emitter {
  constructor() { this._handlers = new Map(); }
  on(ev, fn) {
    if (!this._handlers.has(ev)) this._handlers.set(ev, new Set());
    this._handlers.get(ev).add(fn);
    return this;
  }
  off(ev, fn) {
    if (fn) this._handlers.get(ev)?.delete(fn); else this._handlers.delete(ev);
    return this;
  }
  removeAllListeners() { this._handlers.clear(); return this; }
  _fire(ev, args) {
    const set = this._handlers.get(ev);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (e) { console.error(`error in "${ev}" handler`, e); }
    }
  }
}

let socketSeq = 1;

class ServerSocket extends Emitter {
  constructor(server, client, auth) {
    super();
    this.server = server;
    this.client = client;
    this.id = 'local' + socketSeq++;
    this.handshake = { auth: auth || {} };
    this.data = {};
    this.rooms = new Set();
    this.connected = false;
    this.volatile = this;
  }
  emit(ev, ...args) { if (this.connected) send(this.client, ev, args); return true; }
  timeout(ms) {
    return {
      emit: (ev, ...args) => {
        const cb = args.pop();
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; cb(new Error('operation has timed out')); } }, ms);
        this.emit(ev, ...args, (...r) => { if (done) return; done = true; clearTimeout(t); cb(null, ...r); });
      },
    };
  }
  join(room) {
    this.rooms.add(room);
    if (!this.server.rooms.has(room)) this.server.rooms.set(room, new Set());
    this.server.rooms.get(room).add(this);
  }
  leave(room) {
    this.rooms.delete(room);
    const set = this.server.rooms.get(room);
    if (set) { set.delete(this); if (!set.size) this.server.rooms.delete(room); }
  }
  disconnect() { this._close('io server disconnect'); return this; }
  _incoming(ev, args) { this._fire(ev, args); }
  _close(reason) {
    if (!this.connected) return;
    this.connected = false;
    for (const room of [...this.rooms]) this.leave(room);
    this.client._closed(reason);
    this._fire('disconnect', [reason]);
  }
}

export class LocalServer extends Emitter {
  constructor() {
    super();
    this.middleware = [];
    this.rooms = new Map();
  }
  use(fn) { this.middleware.push(fn); }
  to(room) {
    const emit = (ev, ...args) => { for (const s of this.rooms.get(room) || []) s.emit(ev, ...args); };
    return { emit, volatile: { emit } };
  }
  _connect(client, auth) {
    const s = new ServerSocket(this, client, auth);
    let i = 0;
    const next = (err) => {
      if (err) { client._fire('connect_error', [err]); return; }
      if (i < this.middleware.length) { this.middleware[i++](s, next); return; }
      s.connected = true;
      client.peer = s;
      client.id = s.id;
      client.connected = true;
      client._fire('connect', []);
      this._fire('connection', [s]);
    };
    next();
  }
}

export class ClientSocket extends Emitter {
  constructor() {
    super();
    this.connected = false;
    this.peer = null;
    this.anyHandlers = [];
    this.volatile = { emit: (ev, ...args) => this.emit(ev, ...args) };
  }
  onAny(fn) { this.anyHandlers.push(fn); return this; }
  emit(ev, ...args) { if (this.connected) send(this.peer, ev, args); return this; }
  disconnect() {
    if (!this.connected) return this;
    this.connected = false;
    this.peer._close('client namespace disconnect');
    this._fire('disconnect', ['io client disconnect']);
    return this;
  }
  removeAllListeners() { super.removeAllListeners(); this.anyHandlers = []; return this; }
  _incoming(ev, args) {
    for (const fn of [...this.anyHandlers]) {
      try { fn(ev, ...args); } catch (e) { console.error(`error in "${ev}" handler`, e); }
    }
    this._fire(ev, args);
  }
  _closed(reason) {
    if (!this.connected) return;
    this.connected = false;
    queueMicrotask(() => this._fire('disconnect', [reason]));
  }
}
