// Socket.IO wiring shared by the Node server (index.js) and the browser-only build
// (client/js/local/), whose in-page socket implements the same API.
import db from './db.js';
import { userFromToken, selfProfile } from './auth.js';

export function attachRealtime({ io, hub, services }) {
  // Socket authentication: the client sends its session token in the handshake.
  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const user = userFromToken(token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.userId = user.id;
    socket.data.username = user.username;
    socket.data.token = token;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    const user = db.get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) { socket.disconnect(true); return; }
    // Only one live connection per account: newest wins.
    const prev = hub.get(userId);
    if (prev) {
      prev.replaced = true;
      prev.socket.emit('auth:kicked', { reason: 'You logged in from another window or device.' });
      prev.socket.disconnect(true);
      services.onDisconnect(prev, true);
    }
    const client = {
      userId,
      username: user.username,
      token: socket.data.token,
      socket,
      partyId: null,
      matchId: null,
      queue: null,
      connectedAt: Date.now(),
    };
    hub.add(client);
    db.run('UPDATE users SET last_seen = ? WHERE id = ?', [Date.now(), userId]);
    socket.emit('hello', { user: selfProfile(user), serverTime: Date.now() });
    // measure latency on the server (used for lag compensation; clients can't inflate it)
    const probe = () => {
      const t = Date.now();
      socket.timeout(4000).emit('png', (err) => {
        if (err) return;
        const r = Date.now() - t;
        client.rtt = client.rtt === undefined ? r : client.rtt * 0.7 + r * 0.3;
      });
    };
    probe();
    const probeTimer = setInterval(probe, 5000);
    socket.on('disconnect', () => clearInterval(probeTimer));
    services.onConnect(client);
    hub.presenceChanged(userId);

    socket.on('time:ping', (t, ack) => { if (typeof ack === 'function') ack({ t, s: Date.now() }); });

    socket.on('disconnect', () => {
      if (client.replaced) return;
      hub.remove(client);
      db.run('UPDATE users SET last_seen = ? WHERE id = ?', [Date.now(), userId]);
      services.onDisconnect(client, false);
      hub.presenceChanged(userId);
    });
  });
}
