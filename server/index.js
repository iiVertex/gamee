// yoink! server: static client, REST auth, authenticated Socket.IO realtime.
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';
import compression from 'compression';
import { Server } from 'socket.io';
import { openDb, flush } from './db.js';
import db from './db.js';
import { mountAuthRoutes, purgeExpiredSessions } from './auth.js';
import { Hub } from './hub.js';
import { createServices } from './services.js';
import { attachRealtime } from './realtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export async function startServer(opts = {}) {
  const port = opts.port ?? (+process.env.PORT || 3000);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  const dbFile = opts.dbFile ?? process.env.YOINK_DB ?? path.join(ROOT, 'data', 'yoink.db');
  await openDb(dbFile);
  purgeExpiredSessions();

  const app = express();
  app.disable('x-powered-by');
  // TRUST_PROXY = number of proxy hops in front of the server (or an address/subnet list).
  // Never `true`: that would let clients pick their own IP via X-Forwarded-For.
  const tp = process.env.TRUST_PROXY;
  if (tp && tp !== '0') app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp);
  app.use(compression());
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  const server = http.createServer(app);
  const io = new Server(server, {
    pingInterval: 10000,
    pingTimeout: 20000,
    maxHttpBufferSize: 64 * 1024,
    cors: opts.cors ? { origin: opts.cors } : undefined,
  });
  const hub = new Hub(io);
  const services = createServices({ io, hub, db, opts });

  mountAuthRoutes(app, {
    onLogout: (userId, token) => {
      const c = hub.get(userId);
      if (c && c.token === token) {
        c.socket.emit('auth:logout', { reason: 'Logged out.' });
        c.socket.disconnect(true);
      }
    },
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, online: hub.clients.size, matches: services.matchmaking.matches.size }));

  // Static files
  const staticOpts = { maxAge: opts.dev ? 0 : '1h' };
  app.use('/vendor/three', express.static(path.join(ROOT, 'node_modules', 'three'), staticOpts));
  app.use('/shared', express.static(path.join(ROOT, 'shared'), { maxAge: 0 }));
  app.use('/', express.static(path.join(ROOT, 'client'), { maxAge: 0 }));

  attachRealtime({ io, hub, services });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const actualPort = server.address().port;
  if (!opts.quiet) printBanner(actualPort);

  const shutdown = () => {
    try { flush(); } catch (e) { console.error(e); }
    process.exit(0);
  };
  if (!opts.noSignals) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  return {
    app, server, io, hub, services, port: actualPort,
    close: () => new Promise((resolve) => {
      services.shutdown();
      io.close();
      server.close(() => { try { flush(); } catch { /* ignore */ } resolve(); });
    }),
  };
}

function printBanner(port) {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const list of Object.values(nets)) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) lan.push(n.address);
  console.log('\n  yoink! server is running');
  console.log(`  Local:   http://localhost:${port}`);
  for (const ip of lan) console.log(`  LAN:     http://${ip}:${port}`);
  console.log('  (Internet play needs port forwarding or a tunnel — see README.)\n');
}

// Used by start-yoink.bat / start-yoink.sh so players don't have to type the URL.
function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: true });
    child.on('error', () => console.log(`  Open ${url} in your browser to play.`));
    child.unref();
  } catch { console.log(`  Open ${url} in your browser to play.`); }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // Last line of defence: a bug in one handler must not take every match down.
  process.on('uncaughtException', (e) => {
    console.error('uncaught exception (server kept running):', e);
    try { flush(); } catch { /* ignore */ }
  });
  process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));
  startServer({ dev: process.env.NODE_ENV !== 'production' }).then(({ port }) => {
    if (process.env.YOINK_OPEN === '1') openBrowser(`http://localhost:${port}`);
  }).catch((e) => {
    if (e && e.code === 'EADDRINUSE') {
      const port = +process.env.PORT || 3000;
      console.error(`\n  Port ${port} is already in use - yoink! may already be running.`);
      console.error(`  Open http://localhost:${port} in your browser, or set the PORT environment variable to use another port.\n`);
      if (process.env.YOINK_OPEN === '1') openBrowser(`http://localhost:${port}`);
    } else console.error(e);
    process.exit(1);
  });
}
