import { Pool } from 'pg';
import { config } from '../config';
import { migrate } from './migrate';
import { DEMO_PASSWORD, seed } from './seed';

(async () => {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await migrate(pool, config.migrationsDir);
    await seed(pool, { queueAgentRuns: !process.argv.includes('--no-agent') });
    console.log(`Seeded demo data. Log in as manager@demo.fixflow.dev / ${DEMO_PASSWORD} (all demo accounts use the same password).`);
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
