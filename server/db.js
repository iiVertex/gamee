// SQLite database (sql.js / WebAssembly — no native build tools required).
// The whole DB lives in memory and is flushed to disk atomically after writes.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { SCHEMA } from './schema.js';

const require = createRequire(import.meta.url);

let SQL = null;
let db = null;
let filePath = null;
let saveTimer = null;
let dirty = false;

export async function openDb(file) {
  if (!SQL) {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    SQL = await initSqlJs({ locateFile: () => wasmPath });
  }
  filePath = file;
  if (file && file !== ':memory:' && fs.existsSync(file)) {
    db = new SQL.Database(fs.readFileSync(file));
  } else {
    db = new SQL.Database();
  }
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(SCHEMA);
  if (file && file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    flush();
  }
  return api;
}

function scheduleSave() {
  dirty = true;
  if (!filePath || filePath === ':memory:') return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 250);
}

export function flush() {
  if (!db || !filePath || filePath === ':memory:') return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const data = db.export();
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, filePath);
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

// Runs fn inside a transaction. Throwing rolls everything back.
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
