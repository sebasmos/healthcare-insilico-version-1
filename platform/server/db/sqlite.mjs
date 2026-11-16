// SQLite adapter on Node's built-in node:sqlite. Zero native dependencies.
// All top-level calls are serialised through one lock so that an open
// transaction never interleaves with another caller on the same connection.
import fs from 'node:fs';
import path from 'node:path';

const originalEmit = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning?.message ?? warning).includes('SQLite is an experimental feature')) return;
  return originalEmit.call(process, warning, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = originalEmit;

const bind = (params = []) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));

export class SqliteAdapter {
  dialect = 'sqlite';

  constructor(file) {
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this._tail = Promise.resolve();
    const db = this.db;
    this._raw = {
      dialect: 'sqlite',
      run: async (sql, params) => { db.prepare(sql).run(...bind(params)); },
      all: async (sql, params) => db.prepare(sql).all(...bind(params)),
      get: async (sql, params) => db.prepare(sql).get(...bind(params)) ?? null,
      exec: async (sql) => { db.exec(sql); },
      transaction: (fn) => fn(this._raw),
    };
  }

  async _withLock(fn) {
    const previous = this._tail;
    let release;
    this._tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }

  run(sql, params) { return this._withLock(() => this._raw.run(sql, params)); }
  all(sql, params) { return this._withLock(() => this._raw.all(sql, params)); }
  get(sql, params) { return this._withLock(() => this._raw.get(sql, params)); }
  exec(sql) { return this._withLock(() => this._raw.exec(sql)); }

  // fn receives a transaction-bound executor. Use only that executor inside fn.
  transaction(fn) {
    return this._withLock(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this._raw);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
    });
  }

  backup(destination) {
    fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
    return this._withLock(async () => {
      this.db.exec(`VACUUM INTO '${String(destination).replaceAll("'", "''")}'`);
      return destination;
    });
  }

  async close() {
    await this._tail;
    this.db.close();
  }
}
