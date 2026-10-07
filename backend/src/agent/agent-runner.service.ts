import { Inject, Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { Db } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import { todayInAppTz } from '../common/time';
import { RunType } from './agent-queue.service';
import { ContentBlock, ImageBlock, LLM_CLIENT, LlmClient, LlmMessage, NonRetryableError, ToolUseBlock } from './llm/llm.types';
import { contextBlock, NIGHTLY_SYSTEM, TRIAGE_SYSTEM } from './prompts';
import { RunContext, ToolExecutor } from './tool-executor.service';
import { toolsForRun } from './tools';

export const MAX_TURNS = 12;
export const MAX_TOOL_CALLS = 30;

export interface AgentRunRow {
  id: string;
  runType: RunType;
  triggerRef: string;
  attempts: number;
  maxAttempts: number;
}

@Injectable()
export class AgentRunner {
  private readonly log = new Logger(AgentRunner.name);

  constructor(
    private db: Db,
    private executor: ToolExecutor,
    private notifications: NotificationsService,
    @Inject(LLM_CLIENT) private llm: LlmClient,
  ) {}

  get mode() {
    return { mode: this.llm.mode, model: this.llm.model };
  }

  /** Runs one agent conversation to completion. Throws on failure (the worker decides whether to retry). */
  async run(run: AgentRunRow): Promise<void> {
    const { ctx, system, firstMessage } = await this.prepare(run);
    let seq = (await this.db.one<{ max: number | null }>('SELECT max(seq) AS max FROM agent_step WHERE run_id = $1', [run.id]))!.max ?? 0;
    const step = async (s: { type: string; toolName?: string; toolUseId?: string; input?: unknown; output?: unknown; text?: string; durationMs?: number }) => {
      seq += 1;
      await this.db.exec(
        `INSERT INTO agent_step(run_id, seq, step_type, tool_name, tool_use_id, tool_input, tool_output, text, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [run.id, seq, s.type, s.toolName ?? null, s.toolUseId ?? null, s.input === undefined ? null : JSON.stringify(s.input),
          s.output === undefined ? null : JSON.stringify(s.output), s.text ?? null, s.durationMs ?? null]);
    };

    if (run.attempts > 1) await step({ type: 'MODEL_TEXT', text: `Retry attempt ${run.attempts} of ${run.maxAttempts}.` });
    await this.db.exec('UPDATE agent_run SET model = $2 WHERE id = $1', [run.id, this.llm.model]);

    const messages: LlmMessage[] = [{ role: 'user', content: firstMessage }];
    const tools = toolsForRun(run.runType);
    let toolCalls = 0;
    let finalText = '';

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const started = Date.now();
      const res = await this.llm.createMessage({ system, messages, tools, maxTokens: 2048 });
      await this.db.exec(
        `UPDATE agent_run SET input_tokens = input_tokens + $2, output_tokens = output_tokens + $3, locked_until = now() + interval '5 minutes' WHERE id = $1`,
        [run.id, res.usage.inputTokens, res.usage.outputTokens]);
      const texts = res.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text' && !!(b as any).text?.trim());
      const uses = res.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      for (const t of texts) await step({ type: 'MODEL_TEXT', text: t.text, durationMs: uses.length ? undefined : Date.now() - started });
      messages.push({ role: 'assistant', content: res.content });

      if (!uses.length) {
        finalText = texts.map((t) => t.text).join('\n').trim();
        if (res.stopReason === 'max_tokens') throw new NonRetryableError('The model hit its output limit before finishing');
        break;
      }

      const results: ContentBlock[] = [];
      for (const use of uses) {
        toolCalls += 1;
        await step({ type: 'TOOL_CALL', toolName: use.name, toolUseId: use.id, input: use.input });
        const t0 = Date.now();
        const outcome = toolCalls > MAX_TOOL_CALLS
          ? { ok: false, result: { error: `Tool call limit (${MAX_TOOL_CALLS}) reached for this run. Stop and summarize.` } }
          : await this.executor.execute(use.name, use.input, ctx);
        await step({ type: 'TOOL_RESULT', toolName: use.name, toolUseId: use.id, output: outcome.result, durationMs: Date.now() - t0 });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(outcome.result), ...(outcome.ok ? {} : { is_error: true }) });
      }
      await this.db.exec('UPDATE agent_run SET tool_calls = tool_calls + $2 WHERE id = $1', [run.id, uses.length]);
      messages.push({ role: 'user', content: results });

      if (turn === MAX_TURNS - 1) throw new NonRetryableError(`Stopped after ${MAX_TURNS} model turns without finishing`);
    }

    await this.afterRun(run, ctx, finalText);
    await this.db.exec(
      `UPDATE agent_run SET status = 'SUCCEEDED', summary = $2, finished_at = now(), locked_until = NULL, error = NULL WHERE id = $1`,
      [run.id, finalText || 'Done.']);
  }

  /** Called by the worker when a run has failed for good. Leaves the system in a state a human can pick up. */
  async onFinalFailure(run: AgentRunRow, error: string) {
    if (run.runType !== 'TRIAGE') return;
    const r = await this.db.one<{ status: string; propertyId: string; title: string }>(
      `UPDATE maintenance_request SET status = 'NEW', updated_at = now() WHERE id = $1 AND status = 'TRIAGING'
       RETURNING status, property_id AS "propertyId", title`, [run.triggerRef]);
    const req = r ?? (await this.db.one<{ propertyId: string; title: string }>('SELECT property_id AS "propertyId", title FROM maintenance_request WHERE id = $1', [run.triggerRef]));
    if (req) {
      await this.notifications.notifyManagerOfProperty(this.db.pool, req.propertyId, {
        kind: 'STATUS', title: `AI triage failed: ${req.title}`.slice(0, 200), body: `Please triage this request manually. Error: ${error}`.slice(0, 1000),
        linkPath: `/requests/${run.triggerRef}`, agentRunId: run.id,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────

  private async prepare(run: AgentRunRow): Promise<{ ctx: RunContext; system: string; firstMessage: ContentBlock[] }> {
    const now = new Date();
    if (run.runType === 'TRIAGE') {
      const r = await this.db.one<{ id: string; propertyId: string; propertyName: string; managerName: string; unitId: string | null; unitLabel: string | null; status: string }>(
        `SELECT r.id, r.property_id AS "propertyId", p.name AS "propertyName", m.full_name AS "managerName", r.unit_id AS "unitId", un.label AS "unitLabel", r.status
           FROM maintenance_request r JOIN property p ON p.id = r.property_id JOIN app_user m ON m.id = p.manager_id
           LEFT JOIN unit un ON un.id = r.unit_id WHERE r.id = $1`, [run.triggerRef]);
      if (!r) throw new NonRetryableError('Request no longer exists');
      // A retry may find the work order already created by the failed attempt; let it finish (e.g. assignment).
      const resumable = run.attempts > 1 && r.status === 'CONVERTED';
      if (!['NEW', 'TRIAGING', 'TRIAGED'].includes(r.status) && !resumable) throw new NonRetryableError(`Request is already ${r.status}; nothing to triage`);
      await this.db.exec(`UPDATE maintenance_request SET status = 'TRIAGING', updated_at = now() WHERE id = $1 AND status = 'NEW'`, [r.id]);
      const content: ContentBlock[] = [{
        type: 'text',
        text: `A new maintenance request needs triage.\n${contextBlock({
          run_type: 'TRIAGE', request_id: r.id, property_id: r.propertyId, property_name: r.propertyName, unit_id: r.unitId, unit_label: r.unitLabel,
          manager_name: r.managerName, now: now.toISOString(), today: todayInAppTz(now), timezone: config.timezone,
        })}`,
      }];
      if (this.llm.mode === 'claude') content.push(...(await this.photos(r.id)));
      return { ctx: { runId: run.id, runType: 'TRIAGE', propertyId: r.propertyId, requestId: r.id }, system: TRIAGE_SYSTEM, firstMessage: content };
    }
    const p = await this.db.one<{ id: string; name: string; managerName: string }>(
      `SELECT p.id, p.name, m.full_name AS "managerName" FROM property p JOIN app_user m ON m.id = p.manager_id WHERE p.id = $1`, [run.triggerRef]);
    if (!p) throw new NonRetryableError('Property no longer exists');
    return {
      ctx: { runId: run.id, runType: run.runType, propertyId: p.id },
      system: NIGHTLY_SYSTEM,
      firstMessage: [{ type: 'text', text: `Run the nightly check for ${p.name}.\n${contextBlock({
        run_type: 'NIGHTLY_DIGEST', property_id: p.id, property_name: p.name, manager_name: p.managerName,
        now: now.toISOString(), today: todayInAppTz(now), timezone: config.timezone,
      })}` }],
    };
  }

  private async photos(requestId: string): Promise<ContentBlock[]> {
    const rows = await this.db.many<{ storageKey: string; contentType: ImageBlock['source']['media_type'] }>(
      'SELECT storage_key AS "storageKey", content_type AS "contentType" FROM request_attachment WHERE request_id = $1 ORDER BY created_at LIMIT 4', [requestId]);
    const blocks: ContentBlock[] = [];
    for (const r of rows) {
      const file = path.join(config.uploadDir, path.basename(r.storageKey));
      if (!fs.existsSync(file)) continue;
      blocks.push({ type: 'image', source: { type: 'base64', media_type: r.contentType, data: fs.readFileSync(file).toString('base64') } });
    }
    if (blocks.length) blocks.unshift({ type: 'text', text: `The tenant attached ${blocks.length} photo(s):` });
    return blocks;
  }

  private async afterRun(run: AgentRunRow, ctx: RunContext, finalText: string) {
    if (run.runType !== 'TRIAGE') return;
    const r = await this.db.one<{ status: string; title: string }>('SELECT status, title FROM maintenance_request WHERE id = $1', [ctx.requestId]);
    if (r?.status === 'TRIAGING') {
      // The agent stopped without triaging. Put it back in the manual queue.
      await this.db.exec(`UPDATE maintenance_request SET status = 'NEW', updated_at = now() WHERE id = $1`, [ctx.requestId]);
      await this.notifications.notifyManagerOfProperty(this.db.pool, ctx.propertyId, {
        kind: 'STATUS', title: `Needs manual triage: ${r.title}`.slice(0, 200), body: finalText || 'The agent could not triage this request.',
        linkPath: `/requests/${ctx.requestId}`, agentRunId: run.id,
      });
    } else if (r?.status === 'TRIAGED') {
      await this.notifications.notifyManagerOfProperty(this.db.pool, ctx.propertyId, {
        kind: 'STATUS', title: `Triaged, no work order yet: ${r.title}`.slice(0, 200), body: finalText || 'Review and create a work order.',
        linkPath: `/requests/${ctx.requestId}`, agentRunId: run.id,
      });
    }
  }
}
