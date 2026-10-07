import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../db/db.service';

export type RunType = 'TRIAGE' | 'NIGHTLY_DIGEST' | 'MANUAL';

@Injectable()
export class AgentQueue {
  constructor(private db: Db) {}

  /** Queue a run. Returns the existing active run instead of failing if one is already queued for the same request. */
  async enqueue(q: Queryable, runType: RunType, triggerRef: string): Promise<{ id: string; existing: boolean }> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO agent_run(run_type, trigger_ref) VALUES ($1, $2)
       ON CONFLICT (trigger_ref) WHERE run_type = 'TRIAGE' AND status IN ('QUEUED','RUNNING') DO NOTHING
       RETURNING id`, [runType, triggerRef], q);
    if (row) return { id: row.id, existing: false };
    const active = await this.db.one<{ id: string }>(
      `SELECT id FROM agent_run WHERE run_type = $1 AND trigger_ref = $2 AND status IN ('QUEUED','RUNNING') ORDER BY created_at DESC LIMIT 1`,
      [runType, triggerRef], q);
    return { id: active!.id, existing: true };
  }
}
