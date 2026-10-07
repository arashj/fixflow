import { Pool } from 'pg';
import { config } from '../config';
import { migrate } from './migrate';

(async () => {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const applied = await migrate(pool, config.migrationsDir);
    console.log(applied.length ? `Done (${applied.length} applied)` : 'Database is up to date');
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
