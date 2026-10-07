import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Db } from '../db/db.service';
import { AccessService } from '../common/access.service';
import { AuthUser } from '../common/types';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { AgentQueue } from './agent-queue.service';
import { AgentRunner } from './agent-runner.service';
import { TOOL_DEFS } from './tools';
import { config } from '../config';

@Controller('api/agent')
export class AgentController {
  constructor(private db: Db, private access: AccessService, private queue: AgentQueue, private runner: AgentRunner) {}

  @Public()
  @Get('status')
  status() {
    return { ...this.runner.mode, demoResets: !!config.demoResetCron, tools: TOOL_DEFS.map((t) => ({ name: t.tool.name, access: t.access, runTypes: t.runTypes })) };
  }

  @Get('runs')
  @Roles('MANAGER')
  async runs(@CurrentUser() u: AuthUser, @Query('type') type?: string) {
    return this.db.many(
      `SELECT ar.id, ar.run_type AS "runType", ar.status, ar.attempts, ar.model, ar.tool_calls AS "toolCalls",
              ar.input_tokens AS "inputTokens", ar.output_tokens AS "outputTokens", ar.summary, ar.error,
              ar.created_at AS "createdAt", ar.started_at AS "startedAt", ar.finished_at AS "finishedAt",
              ar.trigger_ref AS "triggerRef", coalesce(r.title, p2.name) AS "subject", coalesce(p.name, p2.name) AS "propertyName"
         FROM agent_run ar
         LEFT JOIN maintenance_request r ON ar.run_type = 'TRIAGE' AND r.id = ar.trigger_ref
         LEFT JOIN property p ON p.id = r.property_id
         LEFT JOIN property p2 ON ar.run_type <> 'TRIAGE' AND p2.id = ar.trigger_ref
        WHERE coalesce(p.manager_id, p2.manager_id) = $1 AND ($2::text IS NULL OR ar.run_type = $2)
        ORDER BY ar.created_at DESC LIMIT 100`, [u.id, type ?? null]);
  }

  @Get('runs/:id')
  @Roles('MANAGER')
  async run(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const run = await this.db.one(
      `SELECT ar.id, ar.run_type AS "runType", ar.status, ar.attempts, ar.max_attempts AS "maxAttempts", ar.model, ar.tool_calls AS "toolCalls",
              ar.input_tokens AS "inputTokens", ar.output_tokens AS "outputTokens", ar.summary, ar.error, ar.trigger_ref AS "triggerRef",
              ar.created_at AS "createdAt", ar.started_at AS "startedAt", ar.finished_at AS "finishedAt",
              coalesce(r.title, p2.name) AS "subject", coalesce(p.manager_id, p2.manager_id) AS "managerId"
         FROM agent_run ar
         LEFT JOIN maintenance_request r ON ar.run_type = 'TRIAGE' AND r.id = ar.trigger_ref
         LEFT JOIN property p ON p.id = r.property_id
         LEFT JOIN property p2 ON ar.run_type <> 'TRIAGE' AND p2.id = ar.trigger_ref
        WHERE ar.id = $1`, [id]);
    if (!run || run.managerId !== u.id) throw new NotFoundException('Run not found');
    const steps = await this.db.many(
      `SELECT s.seq, s.step_type AS "stepType", s.tool_name AS "toolName", s.tool_use_id AS "toolUseId", s.tool_input AS "toolInput",
              s.tool_output AS "toolOutput", s.text, s.duration_ms AS "durationMs", s.created_at AS "createdAt"
         FROM agent_step s WHERE s.run_id = $1 ORDER BY s.seq`, [id]);
    const access = Object.fromEntries(TOOL_DEFS.map((t) => [t.tool.name, t.access]));
    const { managerId: _, ...rest } = run;
    return { ...rest, steps: steps.map((s) => ({ ...s, access: s.toolName ? access[s.toolName] : undefined })) };
  }

  @Post('nightly')
  @Roles('MANAGER')
  async runNightly(@CurrentUser() u: AuthUser, @Query('propertyId', new ParseUUIDPipe({ optional: true })) propertyId?: string) {
    const ids = propertyId ? [propertyId] : await this.access.managedPropertyIds(u);
    const runs = [];
    for (const pid of ids) {
      await this.access.assertManagesProperty(u, pid);
      const active = await this.db.one<{ id: string }>(
        `SELECT id FROM agent_run WHERE run_type = 'NIGHTLY_DIGEST' AND trigger_ref = $1 AND status IN ('QUEUED','RUNNING')`, [pid]);
      runs.push(active ? { id: active.id, propertyId: pid, existing: true } : { ...(await this.queue.enqueue(this.db.pool, 'NIGHTLY_DIGEST', pid)), propertyId: pid });
    }
    return { runs };
  }
}
