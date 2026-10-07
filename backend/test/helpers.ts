import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { config } from '../src/config';
import { Db } from '../src/db/db.service';
import { migrate } from '../src/db/migrate';
import { DEMO_PASSWORD, seed } from '../src/db/seed';
import { LLM_CLIENT, LlmClient, LlmRequest, LlmResponse } from '../src/agent/llm/llm.types';
import { LocalRulesLlmClient } from '../src/agent/llm/local.client';
import { AgentWorker } from '../src/agent/agent-worker.service';

/** LLM stand-in: the local rules engine by default, or a scripted sequence of replies for guardrail tests. */
export class SwitchableLlm implements LlmClient {
  mode: 'local' | 'claude' = 'local';
  readonly model = 'test-llm';
  private local = new LocalRulesLlmClient();
  script: ((req: LlmRequest) => LlmResponse | Promise<LlmResponse>)[] | null = null;
  requests: LlmRequest[] = [];

  async createMessage(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(JSON.parse(JSON.stringify(req)));
    if (this.script) {
      const next = this.script.shift();
      if (!next) return reply([], 'Done.');
      return next(req);
    }
    return this.local.createMessage(req);
  }
}

let n = 0;
export function reply(tools: { name: string; input: Record<string, unknown> }[], text?: string): LlmResponse {
  return {
    content: [...(text ? [{ type: 'text', text }] : []), ...tools.map((t) => ({ type: 'tool_use', id: `toolu_test_${++n}`, name: t.name, input: t.input }))],
    stopReason: tools.length ? 'tool_use' : 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    model: 'test-llm',
  };
}

export interface TestCtx {
  app: INestApplication;
  db: Db;
  llm: SwitchableLlm;
  worker: AgentWorker;
  ids: Record<string, string>;
}

export async function createApp(): Promise<TestCtx> {
  const llm = new SwitchableLlm();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LLM_CLIENT).useValue(llm).compile();
  const app = mod.createNestApplication({ logger: ['error'] });
  await app.init();
  const db = app.get(Db);
  return { app, db, llm, worker: app.get(AgentWorker), ids: {} };
}

export async function resetDb(ctx: TestCtx) {
  await ctx.db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(ctx.db.pool, config.migrationsDir, () => undefined);
  ctx.ids = await seed(ctx.db.pool, { queueAgentRuns: false });
  ctx.llm.script = null;
  ctx.llm.requests = [];
  ctx.llm.mode = 'local';
}

const tokens = new Map<string, string>();
export async function login(ctx: TestCtx, who: string): Promise<string> {
  const email = `${who}@demo.fixflow.dev`;
  const res = await request(ctx.app.getHttpServer()).post('/api/auth/login').send({ email, password: DEMO_PASSWORD }).expect(200);
  tokens.set(who, res.body.token);
  return res.body.token;
}

export function api(ctx: TestCtx, token?: string) {
  const s = request(ctx.app.getHttpServer());
  const auth = (r: request.Test) => (token ? r.set('Authorization', `Bearer ${token}`) : r);
  return {
    get: (url: string) => auth(s.get(url)),
    post: (url: string) => auth(s.post(url)),
  };
}

/** Runs queued agent jobs until the queue is empty. */
export async function drainAgent(ctx: TestCtx, max = 20) {
  for (let i = 0; i < max; i++) if (!(await ctx.worker.processNext())) return;
  throw new Error('Agent queue did not drain');
}

export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
