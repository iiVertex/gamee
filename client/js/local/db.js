// Browser version of server/db.js for the static build: the same sql.js database
// and API, saved to localStorage instead of a file. The import map in the built
// index.html points /server/db.js here, so every server module shares it.
/* global initSqlJs */
import { SCHEMA } from '/server/schema.js';

let db = null;
let storeKey = null;
let saveTimer = null;
let dirty = false;

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function openDb(key) {
  const SQL = await initSqlJs({ locateFile: (f) => '/vendor/sql.js/' + f });
  storeKey = key;
  let saved = null;
  try { saved = localStorage.getItem(key); } catch { /* storage unavailable: progress lasts until the tab closes */ }
  db = null;
  if (saved) {
    try { db = new SQL.Database(fromBase64(saved)); db.exec('SELECT 1 FROM users LIMIT 1'); } catch (e) { console.error('saved progress is unreadable, starting fresh', e); db = null; }
  }
  if (!db) db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(SCHEMA);
  addEventListener('pagehide', flush);
  flush();
  return api;
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 1000);
}

export function flush() {
  if (!db || !storeKey) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { localStorage.setItem(storeKey, toBase64(db.export())); } catch (e) { console.error('could not save progress', e); }
  dirty = false;
}

let inTx = 0;

function run(sql, params = []) {
  db.run(sql, params);
  const changes = db.getRowsModified();
  let lastId = 0;
  if (/^\s*insert/i.test(sql)) {
    const r = db.exec('SELECT last_insert_rowid() AS id');
    lastId = r.length ? r[0].values[0][0] : 0;
  }
  if (!inTx) scheduleSave();
  return { changes, lastId };
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

function get(sql, params = []) {
  return all(sql, params)[0];
}

function tx(fn) {
  if (inTx) return fn();
  db.exec('BEGIN');
  inTx++;
  try {
    const r = fn();
    db.exec('COMMIT');
    inTx--;
    scheduleSave();
    return r;
  } catch (e) {
    inTx--;
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export const api = { run, all, get, tx, flush, isDirty: () => dirty };
export default api;
