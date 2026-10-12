// Static build (e.g. Vercel): the yoink! server modules run inside the page, with
// bots instead of other players. Progress is saved in this browser and a guest
// account stands in for login. Loaded by the built index.html before main.js.
import db, { openDb } from '/server/db.js';
import { createSession, selfProfile, purgeExpiredSessions } from '/server/auth.js';
import { Hub } from '/server/hub.js';
import { createServices } from '/server/services.js';
import { attachRealtime } from '/server/realtime.js';
import { LocalServer, ClientSocket } from './socket.js';

let booting = null;
function boot() {
  booting ||= (async () => {
    await openDb('yoink_local_db');
    purgeExpiredSessions();
    const io = new LocalServer();
    const hub = new Hub(io);
    const services = createServices({ io, hub, db });
    attachRealtime({ io, hub, services });
    return io;
  })();
  return booting;
}

// The one account in this browser, created on first visit.
async function guestLogin() {
  await boot();
  let user = db.get('SELECT * FROM users ORDER BY id LIMIT 1');
  if (!user) {
    const now = Date.now();
    const name = 'Player' + String(Math.floor(1000 + Math.random() * 9000));
    const { lastId } = db.run('INSERT INTO users (username, pass_hash, created_at, last_seen) VALUES (?, ?, ?, ?)', [name, 'local', now, now]);
    user = db.get('SELECT * FROM users WHERE id = ?', [lastId]);
  }
  return { token: createSession(user.id), user: selfProfile(user) };
}

// Same call shape as the Socket.IO client's io().
function io(opts = {}) {
  const socket = new ClientSocket();
  boot().then((server) => server._connect(socket, opts.auth));
  return socket;
}

window.yoinkLocal = { guestLogin, io };
