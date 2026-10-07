import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { config } from '../config';
import { Db } from '../db/db.service';
import { AgentQueue } from './agent-queue.service';
import { AgentRunner, AgentRunRow } from './agent-runner.service';
import { NonRetryableError } from './llm/llm.types';

const RUN_COLS = `id, run_type AS "runType", trigger_ref AS "triggerRef", attempts, max_attempts AS "maxAttempts"`;

/**
 * Polls agent_run as a job queue. Postgres does the locking:
 *  - FOR UPDATE SKIP LOCKED lets several app instances poll without taking the same job
 *  - a lease (locked_until) lets another worker pick up a job if this process dies mid-run
 *  - failed runs are retried with exponential backoff (run_after), up to max_attempts
 */
@Injectable()
export class AgentWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(AgentWorker.name);
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private busy: Promise<void> | null = null;

  constructor(private db: Db, private runner: AgentRunner, private queue: AgentQueue, private scheduler: SchedulerRegistry) {}

  onApplicationBootstrap() {
    if (!config.agentWorkerEnabled) return;
    this.log.log(`Agent worker started (${this.runner.mode.mode} mode, model ${this.runner.mode.model})`);
    this.schedule(500);
    const job = new CronJob(config.nightlyCron, () => void this.enqueueNightly().catch((e) => this.log.error(e)), null, true, config.timezone);
    this.scheduler.addCronJob('nightly-digest', job as any);
  }

  async onApplicationShutdown() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.busy;
  }

  private schedule(ms: number) {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.busy = this.tick().finally(() => (this.busy = null));
    }, ms);
  }

  private async tick() {
    let worked = false;
    try {
      worked = await this.processNext();
    } catch (e) {
      this.log.error(`Worker tick failed: ${(e as Error).message}`);
    }
    this.schedule(worked ? 50 : config.agentPollMs);
  }

  /** Claims and runs one job. Returns false when the queue is empty. */
  async processNext(): Promise<boolean> {
    const run = await this.claim();
    if (!run) return false;
    if (run.attempts > run.maxAttempts) {
      await this.fail(run, 'Gave up after the worker running it stopped responding');
      return true;
    }
    this.log.log(`Running ${run.runType} ${run.id} (attempt ${run.attempts}/${run.maxAttempts})`);
    try {
      await this.runner.run(run);
      this.log.log(`Run ${run.id} succeeded`);
    } catch (e) {
      const msg = (e as Error).message || String(e);
      await this.db.exec(
        `INSERT INTO agent_step(run_id, seq, step_type, text) VALUES ($1, coalesce((SELECT max(seq) FROM agent_step WHERE run_id = $1), 0) + 1, 'ERROR', $2)`,
        [run.id, msg.slice(0, 4000)]).catch(() => undefined);
      if (e instanceof NonRetryableError || run.attempts >= run.maxAttempts) {
        this.log.warn(`Run ${run.id} failed: ${msg}`);
        await this.fail(run, msg);
      } else {
        const delay = 5 * 2 ** (run.attempts - 1);
        this.log.warn(`Run ${run.id} attempt ${run.attempts} failed, retrying in ${delay}s: ${msg}`);
        await this.db.exec(
          `UPDATE agent_run SET status = 'QUEUED', locked_until = NULL, error = $2, run_after = now() + make_interval(secs => $3) WHERE id = $1`,
          [run.id, msg.slice(0, 4000), delay]);
      }
    }
    return true;
  }

  async claim(): Promise<AgentRunRow | null> {
    return this.db.one<AgentRunRow>(
      `UPDATE agent_run SET status = 'RUNNING', attempts = attempts + 1, locked_until = now() + interval '5 minutes',
              started_at = coalesce(started_at, now())
        WHERE id = (SELECT id FROM agent_run
                     WHERE (status = 'QUEUED' AND run_after <= now()) OR (status = 'RUNNING' AND locked_until < now())
                     ORDER BY run_after, created_at
                     FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING ${RUN_COLS}`);
  }

  private async fail(run: AgentRunRow, error: string) {
    await this.db.exec(`UPDATE agent_run SET status = 'FAILED', error = $2, finished_at = now(), locked_until = NULL WHERE id = $1`, [run.id, error.slice(0, 4000)]);
    await this.runner.onFinalFailure(run, error).catch((e) => this.log.error(e));
  }

  /** Queues a nightly digest run for every property (skips properties that already have one waiting). */
  async enqueueNightly(): Promise<string[]> {
    const props = await this.db.many<{ id: string }>(
      `SELECT p.id FROM property p WHERE NOT EXISTS (
         SELECT 1 FROM agent_run r WHERE r.run_type = 'NIGHTLY_DIGEST' AND r.trigger_ref = p.id AND r.status IN ('QUEUED','RUNNING'))`);
    const ids: string[] = [];
    for (const p of props) ids.push((await this.queue.enqueue(this.db.pool, 'NIGHTLY_DIGEST', p.id)).id);
    if (ids.length) this.log.log(`Queued nightly digest for ${ids.length} propert${ids.length === 1 ? 'y' : 'ies'}`);
    return ids;
  }
}
