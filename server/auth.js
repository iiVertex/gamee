// Registration, login, logout and session validation.
// Passwords: scrypt with per-user random salt. Sessions: random 256-bit tokens,
// only a SHA-256 hash of the token is stored in the database.
import crypto from 'node:crypto';
import db from './db.js';
import { USERNAME_RE, PASSWORD_MIN, PASSWORD_MAX, AVATAR_COLORS } from '../shared/constants.js';

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, expected.length, { N: +parts[1], r: +parts[2], p: +parts[3], maxmem: 64 * 1024 * 1024 }, (err, k) => (err ? reject(err) : resolve(k)));
  });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function validateUsername(username) {
  if (typeof username !== 'string') return 'Username is required.';
  const u = username.trim();
  if (u.length < 3) return 'Username must be at least 3 characters.';
  if (u.length > 16) return 'Username must be at most 16 characters.';
  if (!USERNAME_RE.test(u)) return 'Username may only contain letters, numbers and underscores.';
  if (/^bot/i.test(u)) return 'Usernames starting with "bot" are reserved for bots.';
  return null;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length === 0) return 'Password is required.';
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  return null;
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [sha256(token), userId, now, now + SESSION_TTL_MS]);
  return token;
}

export function userFromToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const row = db.get('SELECT s.user_id, s.expires_at FROM sessions s WHERE s.token_hash = ?', [sha256(token)]);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
    return null;
  }
  return db.get('SELECT * FROM users WHERE id = ?', [row.user_id]) || null;
}

export function destroySession(token) {
  if (typeof token !== 'string') return;
  db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
}

export function selfProfile(u) {
  return {
    id: u.id,
    username: u.username,
    coins: u.coins,
    wins: u.wins,
    matches: u.matches,
    elims: u.elims,
    avatar: { color: u.avatar_color, hat: u.avatar_hat, face: u.avatar_face },
    createdAt: u.created_at,
  };
}

// Simple in-memory rate limiter: key -> timestamps
const buckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return true; }
  arr.push(now);
  buckets.set(key, arr);
  return false;
}
// same window check without counting this request (count later with hit())
function wouldLimit(key, max, windowMs) {
  const now = Date.now();
  return (buckets.get(key) || []).filter((t) => now - t < windowMs).length >= max;
}
function hit(key) {
  const arr = buckets.get(key) || [];
  arr.push(Date.now());
  buckets.set(key, arr);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) if (!arr.length || now - arr[arr.length - 1] > 3600_000) buckets.delete(k);
  purgeExpiredSessions();
}, 600_000).unref?.();

// Sessions whose token was never presented again (closed tabs) would otherwise stay forever.
export function purgeExpiredSessions() {
  try { db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]); } catch (e) { console.error('session purge failed', e); }
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export function mountAuthRoutes(app, hooks = {}) {
  app.post('/api/register', async (req, res) => {
    try {
      const ip = req.ip || 'x';
      // attempts are limited loosely (typos and taken names are normal); created accounts strictly
      if (rateLimited('regtry:' + ip, 120, 3600_000) || wouldLimit('reg:' + ip, 20, 3600_000)) return res.status(429).json({ error: 'Too many accounts created from this address. Try again later.' });
      const { username, password } = req.body || {};
      const uErr = validateUsername(username);
      if (uErr) return res.status(400).json({ error: uErr, field: 'username' });
      const pErr = validatePassword(password);
      if (pErr) return res.status(400).json({ error: pErr, field: 'password' });
      const name = username.trim();
      if (db.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [name])) {
        return res.status(409).json({ error: 'That username is already taken.', field: 'username' });
      }
      const hash = await hashPassword(password);
      // re-check after the async hash to avoid a race between two registrations
      if (db.get('SELECT id FROM users WHERE username = ? COLLATE NOCASE', [name])) {
        return res.status(409).json({ error: 'That username is already taken.', field: 'username' });
      }
      const color = AVATAR_COLORS[Math.floor(Math.random() * 7)];
      const now = Date.now();
      const { lastId } = db.run('INSERT INTO users (username, pass_hash, created_at, last_seen, avatar_color) VALUES (?, ?, ?, ?, ?)', [name, hash, now, now, color]);
      hit('reg:' + ip);
      const token = createSession(lastId);
      const user = db.get('SELECT * FROM users WHERE id = ?', [lastId]);
      hooks.onRegister?.(user);
      res.json({ token, user: selfProfile(user) });
    } catch (e) {
      console.error('register error', e);
      res.status(500).json({ error: 'Server error while creating the account.' });
    }
  });

  app.post('/api/login', async (req, res) => {
    try {
      const ip = req.ip || 'x';
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || !username.trim()) return res.status(400).json({ error: 'Enter your username.', field: 'username' });
      if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Enter your password.', field: 'password' });
      const name = username.trim();
      // the per-account bucket uses the same normalized name as the lookup
      if (rateLimited('login:' + ip, 30, 300_000) || rateLimited('loginu:' + name.toLowerCase(), 10, 300_000)) {
        return res.status(429).json({ error: 'Too many login attempts. Wait a few minutes and try again.' });
      }
      const user = db.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', [name]);
      // Always run a hash to keep timing similar for unknown users
      const ok = user ? await verifyPassword(password, user.pass_hash) : (await hashPassword(password), false);
      if (!ok) return res.status(401).json({ error: 'Wrong username or password.' });
      const token = createSession(user.id);
      res.json({ token, user: selfProfile(user) });
    } catch (e) {
      console.error('login error', e);
      res.status(500).json({ error: 'Server error while logging in.' });
    }
  });

  app.post('/api/logout', (req, res) => {
    const token = bearer(req);
    const user = token ? userFromToken(token) : null;
    if (token) destroySession(token);
    if (user) hooks.onLogout?.(user.id, token);
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    const token = bearer(req);
    const user = token ? userFromToken(token) : null;
    if (!user) return res.status(401).json({ error: 'Not logged in.' });
    res.json({ user: selfProfile(user) });
  });
}
