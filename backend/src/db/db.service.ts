import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { config } from '../config';

// Return DATE columns as 'YYYY-MM-DD' strings instead of JS Dates (avoids timezone shifts)
types.setTypeParser(1082, (v) => v);
// BIGINT counts as numbers (our counts never exceed 2^53)
types.setTypeParser(20, (v) => Number(v));

export interface Queryable {
  query<T extends QueryResultRow = any>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

@Injectable()
export class Db implements OnModuleDestroy {
  readonly pool: Pool;

  constructor() {
    this.pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  }

  async many<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], q: Queryable = this.pool): Promise<T[]> {
    return (await q.query<T>(sql, params)).rows;
  }

  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = [], q: Queryable = this.pool): Promise<T | null> {
    return (await q.query<T>(sql, params)).rows[0] ?? null;
  }

  async exec(sql: string, params: unknown[] = [], q: Queryable = this.pool): Promise<number> {
    return (await q.query(sql, params)).rowCount ?? 0;
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
