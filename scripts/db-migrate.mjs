// Applies pending SQL migrations to the configured database.
import { openAdapter, migrate, dbConfig } from '../platform/server/db/index.mjs';

const config = dbConfig();
const adapter = await openAdapter(config);
try {
  const applied = await migrate(adapter);
  const rows = await adapter.all('SELECT version, name, applied_at FROM schema_migrations ORDER BY version', []);
  console.log(`Database: ${config.backend}${config.file ? ` ${config.file}` : ''}`);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
  for (const r of rows) console.log(`  ${String(r.version).padStart(3, '0')}  ${r.name}  ${r.applied_at}`);
} finally {
  await adapter.close();
}
