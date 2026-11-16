// PostgreSQL adapter. Requires the optional "pg" package and DATABASE_URL.
// Same interface as the SQLite adapter; SQL is written with "?" placeholders
// and converted to $1..$n here.
const toDollar = (sql) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };
const bind = (params = []) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));

function executor(client) {
  const self = {
    dialect: 'postgres',
    run: async (sql, params) => { await client.query(toDollar(sql), bind(params)); },
    all: async (sql, params) => (await client.query(toDollar(sql), bind(params))).rows,
    get: async (sql, params) => (await client.query(toDollar(sql), bind(params))).rows[0] ?? null,
    exec: async (sql) => { await client.query(sql); },
    transaction: (fn) => fn(self),
  };
  return self;
}

export class PostgresAdapter {
  dialect = 'postgres';

  static async connect(url, { max = 10 } = {}) {
    let pg;
    try {
      pg = (await import('pg')).default;
    } catch {
      throw new Error('DB_BACKEND=postgres needs the "pg" package. Run: npm install pg');
    }
    const adapter = new PostgresAdapter();
    adapter.pool = new pg.Pool({ connectionString: url, max });
    Object.assign(adapter, executor(adapter.pool), { dialect: 'postgres' });
    adapter.transaction = async (fn) => {
      const client = await adapter.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result = await fn(executor(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* connection lost */ }
        throw err;
      } finally {
        client.release();
      }
    };
    return adapter;
  }

  backup() {
    throw new Error('Use pg_dump for PostgreSQL backups. See docs/DEPLOY.md.');
  }

  async close() { await this.pool.end(); }
}
