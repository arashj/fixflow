import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

/** Minimal Flyway-style runner: applies migrations/V<n>__*.sql in order, once each. */
export async function migrate(pool: Pool, dir: string, log = console.log): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727272)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    const files = fs.readdirSync(dir)
      .map((f) => ({ f, m: /^V(\d+)__(.+)\.sql$/.exec(f) }))
      .filter((x) => x.m)
      .map((x) => ({ file: x.f, version: Number(x.m![1]), name: x.m![2] }))
      .sort((a, b) => a.version - b.version);
    for (const m of files) {
      if (done.has(m.version)) continue;
      const sql = fs.readFileSync(path.join(dir, m.file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version, name) VALUES ($1, $2)', [m.version, m.name]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.file} failed: ${(e as Error).message}`);
      }
      applied.push(m.file);
      log(`applied ${m.file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727272)').catch(() => undefined);
    client.release();
  }
  return applied;
}
