// Database schema, shared by the Node server (db.js) and the browser-only build (client/js/local/db.js).
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0,
  coins INTEGER NOT NULL DEFAULT 300,
  wins INTEGER NOT NULL DEFAULT 0,
  matches INTEGER NOT NULL DEFAULT 0,
  elims INTEGER NOT NULL DEFAULT 0,
  avatar_color TEXT NOT NULL DEFAULT '#4cc9f0',
  avatar_hat TEXT NOT NULL DEFAULT 'none',
  avatar_face TEXT NOT NULL DEFAULT 'happy'
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS friendships (
  requester_id INTEGER NOT NULL,
  addressee_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_addr ON friendships(addressee_id);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL,
  blocked_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS mutes (
  user_id INTEGER NOT NULL,
  muted_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, muted_id)
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id INTEGER NOT NULL,
  reported_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  message TEXT,
  channel TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skins_owned (
  user_id INTEGER NOT NULL,
  skin_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, skin_id)
);
CREATE TABLE IF NOT EXISTS skins_equipped (
  user_id INTEGER NOT NULL,
  weapon TEXT NOT NULL,
  skin_id TEXT NOT NULL,
  PRIMARY KEY (user_id, weapon)
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, request_id)
);
CREATE TABLE IF NOT EXISTS match_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  match_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  map TEXT NOT NULL,
  placement INTEGER NOT NULL,
  won INTEGER NOT NULL,
  elims INTEGER NOT NULL,
  coins INTEGER NOT NULL,
  practice INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, match_id)
);
CREATE INDEX IF NOT EXISTS idx_history_user ON match_history(user_id, created_at);
CREATE TABLE IF NOT EXISTS mode_stats (
  user_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  wins INTEGER NOT NULL DEFAULT 0,
  matches INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, mode)
);
`;
