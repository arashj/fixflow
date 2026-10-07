import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DomainError, WorkOrderOps } from '../work-orders/work-order.ops';
import { Category } from '../common/types';
import { todayInAppTz } from '../common/time';
import { isToolAllowed, TOOLS_BY_NAME, validateInput } from './tools';
import type { RunType } from './agent-queue.service';

export interface RunContext {
  runId: string;
  runType: RunType;
  propertyId: string;
  /** TRIAGE runs may only change the request that triggered them. */
  requestId?: string;
}

export interface ToolOutcome {
  ok: boolean;
  result: Record<string, unknown>;
}

type Handler = (q: Queryable, input: any, ctx: RunContext) => Promise<Record<string, unknown>>;

const GATED_ACTION: Record<string, string> = {
  draft_vendor_email: 'SEND_VENDOR_EMAIL',
  propose_close_work_order: 'CLOSE_WORK_ORDER',
  propose_cancel_work_order: 'CANCEL_WORK_ORDER',
  reassign_in_progress: 'REASSIGN_IN_PROGRESS',
};

/**
 * Executes agent tool calls. Every guarantee lives here, not in the prompt:
 *  - the tool must exist and be offered to this run type
 *  - input must match the tool's JSON schema
 *  - every id must belong to the run's property (and TRIAGE writes only touch the triggering request)
 *  - READ tools only query; WRITE tools run in a transaction through the same domain rules as the API;
 *    GATED tools never act: they create an approval for the manager.
 */
@Injectable()
export class ToolExecutor {
  private handlers: Record<string, Handler>;

  constructor(private db: Db, private ops: WorkOrderOps, private notifications: NotificationsService) {
    this.handlers = {
      get_request: (q, i, c) => this.getRequest(q, i, c),
      search_assets: (q, i, c) => this.searchAssets(q, i, c),
      find_similar_requests: (q, i, c) => this.findSimilar(q, i, c),
      get_asset_history: (q, i, c) => this.assetHistory(q, i, c),
      list_technicians: (q, i, c) => this.listTechnicians(q, i, c),
      list_overdue_work_orders: (q, i, c) => this.listOverdue(q, i, c),
      list_due_pm_tasks: (q, i, c) => this.listDuePm(q, i, c),
      find_repeat_failures: (q, i, c) => this.repeatFailures(q, i, c),
      set_triage: (q, i, c) => this.setTriage(q, i, c),
      mark_duplicate: (q, i, c) => this.markDuplicate(q, i, c),
      create_work_order: (q, i, c) => this.createWorkOrder(q, i, c),
      create_pm_work_order: (q, i, c) => this.createPm(q, i, c),
      assign_technician: (q, i, c) => this.assign(q, i, c),
      notify_manager: (q, i, c) => this.notifyManager(q, i, c),
      publish_digest: (q, i, c) => this.publishDigest(q, i, c),
      draft_vendor_email: (q, i, c) => this.gated(q, 'draft_vendor_email', i, c),
      propose_close_work_order: (q, i, c) => this.gated(q, 'propose_close_work_order', i, c),
      propose_cancel_work_order: (q, i, c) => this.gated(q, 'propose_cancel_work_order', i, c),
      reassign_in_progress: (q, i, c) => this.gated(q, 'reassign_in_progress', i, c),
    };
  }

  async execute(name: string, rawInput: unknown, ctx: RunContext): Promise<ToolOutcome> {
    const def = TOOLS_BY_NAME.get(name);
    if (!def || !this.handlers[name]) return fail(`Unknown tool "${name}"`);
    if (!isToolAllowed(name, ctx.runType)) return fail(`Tool "${name}" is not available in a ${ctx.runType} run`);
    const v = validateInput(def.tool.input_schema, rawInput ?? {});
    if (!v.ok) return fail(`Invalid input: ${v.errors.join('; ')}`);
    try {
      const result = def.access === 'READ'
        ? await this.handlers[name](this.db.pool, v.value, ctx)
        : await this.db.tx((q) => this.handlers[name](q, v.value, ctx));
      return { ok: true, result };
    } catch (e) {
      if (e instanceof DomainError || e instanceof ScopeError) return fail(e.message);
      throw e;
    }
  }

  // ───────────────────────── scope checks ─────────────────────────

  private checkProperty(id: string, ctx: RunContext) {
    if (id !== ctx.propertyId) throw new ScopeError('property_id is outside the scope of this run');
  }

  private checkTriageRequest(id: string, ctx: RunContext) {
    if (ctx.runType === 'TRIAGE' && id !== ctx.requestId) throw new ScopeError('This run may only change the request it was started for');
  }

  private async inProperty(q: Queryable, table: 'asset' | 'work_order' | 'maintenance_request' | 'unit', id: string, ctx: RunContext, label: string) {
    const row = await this.db.one(`SELECT 1 FROM ${table} WHERE id = $1 AND property_id = $2`, [id, ctx.propertyId], q);
    if (!row) throw new ScopeError(`${label} ${id} was not found in this property`);
  }

  private async pmInProperty(q: Queryable, pmId: string, ctx: RunContext) {
    const row = await this.db.one(`SELECT 1 FROM pm_schedule pm JOIN asset a ON a.id = pm.asset_id WHERE pm.id = $1 AND a.property_id = $2`, [pmId, ctx.propertyId], q);
    if (!row) throw new ScopeError(`Preventive schedule ${pmId} was not found in this property`);
  }

  // ───────────────────────── READ ─────────────────────────

  private async getRequest(q: Queryable, i: { request_id: string }, ctx: RunContext) {
    await this.inProperty(q, 'maintenance_request', i.request_id, ctx, 'Request');
    const r = await this.db.one(
      `SELECT r.id, r.title, r.description, r.status, r.category, r.urgency, r.property_id, p.name AS property_name,
              r.unit_id, un.label AS unit_label, u.full_name AS submitted_by, u.role AS submitted_by_role, r.created_at,
              (SELECT count(*)::int FROM request_attachment a WHERE a.request_id = r.id) AS photo_count,
              (SELECT w.id FROM work_order w WHERE w.request_id = r.id) AS work_order_id
         FROM maintenance_request r JOIN property p ON p.id = r.property_id JOIN app_user u ON u.id = r.submitted_by
         LEFT JOIN unit un ON un.id = r.unit_id WHERE r.id = $1`, [i.request_id], q);
    return r!;
  }

  private async searchAssets(q: Queryable, i: { property_id: string; unit_id?: string; category?: Category; query?: string }, ctx: RunContext) {
    this.checkProperty(i.property_id, ctx);
    const params: unknown[] = [i.property_id];
    const where = ['a.property_id = $1'];
    if (i.unit_id) {
      params.push(i.unit_id);
      where.push(`(a.unit_id = $${params.length} OR a.unit_id IS NULL)`);
    }
    if (i.category) {
      params.push(i.category);
      where.push(`a.category = $${params.length}`);
    }
    if (i.query) {
      params.push(`%${i.query}%`);
      where.push(`(a.name ILIKE $${params.length} OR a.make ILIKE $${params.length} OR a.model ILIKE $${params.length})`);
    }
    const assets = await this.db.many(
      `SELECT a.id, a.name, a.category, a.make, a.model, a.installed_on, a.unit_id, un.label AS unit_label
         FROM asset a LEFT JOIN unit un ON un.id = a.unit_id WHERE ${where.join(' AND ')}
        ORDER BY a.unit_id NULLS LAST, a.name LIMIT 50`, params, q);
    return { assets, note: i.unit_id ? 'Includes the unit\'s assets and building-level (common area) assets.' : undefined };
  }

  private async findSimilar(q: Queryable, i: { property_id: string; unit_id?: string; asset_id?: string; category?: Category; days_back: number; exclude_request_id?: string }, ctx: RunContext) {
    this.checkProperty(i.property_id, ctx);
    const params: unknown[] = [i.property_id, i.days_back];
    const where = ['r.property_id = $1', `r.created_at > now() - make_interval(days => $2::int)`];
    if (i.unit_id) { params.push(i.unit_id); where.push(`r.unit_id = $${params.length}`); }
    if (i.asset_id) { params.push(i.asset_id); where.push(`r.asset_id = $${params.length}`); }
    if (i.category) { params.push(i.category); where.push(`(r.category = $${params.length} OR r.category IS NULL)`); }
    if (i.exclude_request_id) { params.push(i.exclude_request_id); where.push(`r.id <> $${params.length}`); }
    const requests = await this.db.many(
      `SELECT r.id, r.title, left(r.description, 300) AS description, r.status, r.category, r.urgency, r.unit_id, un.label AS unit_label,
              r.asset_id, r.created_at, w.id AS work_order_id, w.status AS work_order_status
         FROM maintenance_request r LEFT JOIN unit un ON un.id = r.unit_id LEFT JOIN work_order w ON w.request_id = r.id
        WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT 20`, params, q);
    return { requests };
  }

  private async assetHistory(q: Queryable, i: { asset_id: string; limit: number }, ctx: RunContext) {
    await this.inProperty(q, 'asset', i.asset_id, ctx, 'Asset');
    const asset = await this.db.one(
      `SELECT a.id, a.name, a.category, a.make, a.model, a.serial_number, a.installed_on, a.notes, a.vendor_name, a.vendor_email, un.label AS unit_label
         FROM asset a LEFT JOIN unit un ON un.id = a.unit_id WHERE a.id = $1`, [i.asset_id], q);
    const work_orders = await this.db.many(
      `SELECT id, title, category, priority, status, resolution_notes, created_at, completed_at,
              CASE WHEN pm_schedule_id IS NULL THEN 'CORRECTIVE' ELSE 'PREVENTIVE' END AS kind
         FROM work_order WHERE asset_id = $1 ORDER BY created_at DESC LIMIT $2`, [i.asset_id, i.limit], q);
    return { asset, work_orders };
  }

  private async listTechnicians(q: Queryable, i: { property_id: string; category: Category; needed_by?: string }, ctx: RunContext) {
    this.checkProperty(i.property_id, ctx);
    return { technicians: await this.ops.listTechnicians(q, i.property_id, i.category, i.needed_by) };
  }

  private async listOverdue(q: Queryable, i: { property_id: string }, ctx: RunContext) {
    this.checkProperty(i.property_id, ctx);
    const work_orders = await this.db.many(
      `SELECT w.id, w.title, w.status, w.priority, w.category, w.due_at,
              floor(extract(epoch FROM now() - w.due_at) / 86400)::int AS days_overdue,
              w.assigned_technician_id AS technician_id, tu.full_name AS technician_name,
              (w.resolution_notes IS NOT NULL AND w.resolution_notes <> '') AS has_resolution_notes, w.resolution_notes,
              un.label AS unit_label, a.name AS asset_name,
              (SELECT e.event_type || ' at ' || to_char(e.created_at, 'YYYY-MM-DD HH24:MI') FROM work_order_event e
                WHERE e.work_order_id = w.id ORDER BY e.created_at DESC LIMIT 1) AS last_event
         FROM work_order w LEFT JOIN app_user tu ON tu.id = w.assigned_technician_id
         LEFT JOIN unit un ON un.id = w.unit_id LEFT JOIN asset a ON a.id = w.asset_id
        WHERE w.property_id = $1 AND w.due_at < now() AND w.status IN ('OPEN','ASSIGNED','IN_PROGRESS','ON_HOLD')
        ORDER BY w.due_at`, [i.property_id], q);
    return { work_orders };
  }

  private async listDuePm(q: Queryable, i: { property_id: string; within_days: number }, ctx: RunContext) {
    this.checkProperty(i.property_id, ctx);
    const tasks = await this.db.many(
      `SELECT pm.id AS pm_schedule_id, pm.title, pm.interval_days, pm.next_due_on, a.id AS asset_id, a.name AS asset_name, a.category,
              (SELECT w.id FROM work_order w WHERE w.pm_schedule_id = pm.id AND w.status NOT IN ('COMPLETED','CANCELLED') LIMIT 1) AS open_work_order_id
         FROM pm_schedule pm JOIN asset a ON a.id = pm.asset_id
        WHERE a.property_id = $1 AND pm.active AND pm.next_due_on <= $2::date + $3::int
        ORDER BY pm.next_due_on`, [i.property_id, todayInAppTz(), i.within_days], q);
    return { today: todayInAppTz(), tasks };
  }

  private async repeatFailures(q: Queryable, i: { property_id: string; days_back: number; min_count: number }, ctx: RunContext) {
    this.checkProperty(i.property_id, ctx);
    const assets = await this.db.many(
      `SELECT a.id AS asset_id, a.name AS asset_name, a.category, un.label AS unit_label, a.vendor_name, a.vendor_email,
              count(*)::int AS count, array_agg(w.title ORDER BY w.created_at DESC) AS work_order_titles,
              (array_agg(w.id ORDER BY w.created_at DESC))[1] AS latest_work_order_id
         FROM work_order w JOIN asset a ON a.id = w.asset_id LEFT JOIN unit un ON un.id = a.unit_id
        WHERE w.property_id = $1 AND w.pm_schedule_id IS NULL AND w.status <> 'CANCELLED'
          AND w.created_at > now() - make_interval(days => $2::int)
        GROUP BY a.id, un.label HAVING count(*) >= $3
        ORDER BY count(*) DESC`, [i.property_id, i.days_back, i.min_count], q);
    return { assets };
  }

  // ───────────────────────── WRITE ─────────────────────────

  private async setTriage(q: Queryable, i: { request_id: string; category: Category; urgency: any; asset_id?: string; rationale: string }, ctx: RunContext) {
    this.checkTriageRequest(i.request_id, ctx);
    await this.inProperty(q, 'maintenance_request', i.request_id, ctx, 'Request');
    if (i.asset_id) await this.inProperty(q, 'asset', i.asset_id, ctx, 'Asset');
    await this.ops.triageRequest(q, i.request_id, { category: i.category, urgency: i.urgency, assetId: i.asset_id, rationale: i.rationale });
    return { request_id: i.request_id, status: 'TRIAGED', category: i.category, urgency: i.urgency };
  }

  private async markDuplicate(q: Queryable, i: { request_id: string; duplicate_of_id: string; rationale: string }, ctx: RunContext) {
    this.checkTriageRequest(i.request_id, ctx);
    await this.inProperty(q, 'maintenance_request', i.duplicate_of_id, ctx, 'Request');
    await this.ops.markDuplicate(q, i.request_id, i.duplicate_of_id, i.rationale, { type: 'AGENT', runId: ctx.runId });
    return { request_id: i.request_id, status: 'DUPLICATE', duplicate_of_id: i.duplicate_of_id };
  }

  private async createWorkOrder(q: Queryable, i: { request_id: string; title: string; description: string; priority: any; due_at?: string }, ctx: RunContext) {
    this.checkTriageRequest(i.request_id, ctx);
    await this.inProperty(q, 'maintenance_request', i.request_id, ctx, 'Request');
    const wo = await this.ops.createFromRequest(q, i.request_id, { title: i.title, description: i.description, priority: i.priority, dueAt: i.due_at },
      { type: 'AGENT', runId: ctx.runId });
    return { work_order_id: wo.id, status: 'OPEN', due_at: wo.dueAt };
  }

  private async createPm(q: Queryable, i: { pm_schedule_id: string }, ctx: RunContext) {
    await this.pmInProperty(q, i.pm_schedule_id, ctx);
    const r = await this.ops.createPmWorkOrder(q, i.pm_schedule_id, { type: 'AGENT', runId: ctx.runId });
    const wo = await this.ops.getWorkOrder(q, r.workOrderId);
    return { work_order_id: r.workOrderId, created: r.created, title: wo.title, category: wo.category, due_on: r.dueOn ?? null, note: r.note };
  }

  private async assign(q: Queryable, i: { work_order_id: string; technician_id: string; rationale: string }, ctx: RunContext) {
    await this.inProperty(q, 'work_order', i.work_order_id, ctx, 'Work order');
    const r = await this.ops.assign(q, i.work_order_id, i.technician_id, { type: 'AGENT', runId: ctx.runId }, { rationale: i.rationale });
    return { work_order_id: r.workOrderId, technician_id: r.technicianId, technician_name: r.technicianName, status: r.status };
  }

  private async notifyManager(q: Queryable, i: { property_id: string; kind: 'EMERGENCY' | 'STATUS'; title: string; body: string; work_order_id?: string }, ctx: RunContext) {
    this.checkProperty(i.property_id, ctx);
    if (i.work_order_id) await this.inProperty(q, 'work_order', i.work_order_id, ctx, 'Work order');
    await this.notifications.notifyManagerOfProperty(q, i.property_id, {
      kind: i.kind, title: i.title, body: i.body, agentRunId: ctx.runId,
      linkPath: i.work_order_id ? `/work-orders/${i.work_order_id}` : ctx.requestId ? `/requests/${ctx.requestId}` : undefined,
    });
    return { sent: true };
  }

  private async publishDigest(q: Queryable, i: { property_id: string; summary: string; items: any[] }, ctx: RunContext) {
    this.checkProperty(i.property_id, ctx);
    const today = todayInAppTz();
    const d = await this.db.one<{ id: string }>(
      `INSERT INTO digest(property_id, run_id, digest_date, summary, items) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (property_id, digest_date) DO UPDATE SET run_id = EXCLUDED.run_id, summary = EXCLUDED.summary, items = EXCLUDED.items, created_at = now()
       RETURNING id`, [i.property_id, ctx.runId, today, i.summary, JSON.stringify(i.items)], q);
    const critical = i.items.filter((x) => x.severity === 'CRITICAL').length;
    await this.notifications.notifyManagerOfProperty(q, i.property_id, {
      kind: 'DIGEST', title: `Daily digest${critical ? ` (${critical} critical)` : ''}`, body: i.summary, linkPath: '/digest', agentRunId: ctx.runId,
    });
    return { digest_id: d!.id, digest_date: today, items: i.items.length };
  }

  // ───────────────────────── GATED ─────────────────────────

  private async gated(q: Queryable, tool: string, i: any, ctx: RunContext) {
    const actionType = GATED_ACTION[tool];
    await this.inProperty(q, 'work_order', i.work_order_id, ctx, 'Work order');
    const wo = await this.ops.getWorkOrder(q, i.work_order_id);
    if (tool !== 'draft_vendor_email' && !this.ops.isOpen(wo.status)) throw new DomainError(`Work order is already ${wo.status}`);
    if (tool === 'reassign_in_progress') {
      if (wo.assignedTechnicianId === i.new_technician_id) throw new DomainError('That technician already has this work order');
      const ok = await this.db.one(
        `SELECT 1 FROM technician t JOIN technician_property tp ON tp.technician_id = t.user_id AND tp.property_id = $2
           JOIN technician_skill s ON s.technician_id = t.user_id AND s.category = $3 WHERE t.user_id = $1 AND t.active`,
        [i.new_technician_id, ctx.propertyId, wo.category], q);
      if (!ok) throw new DomainError('That technician is not qualified for this work or does not cover this property', 422);
    }
    const existing = await this.db.one<{ id: string }>(
      `SELECT id FROM approval WHERE action_type = $1 AND target_id = $2 AND status = 'PENDING'`, [actionType, i.work_order_id], q);
    if (existing) return { status: 'PENDING_APPROVAL', approval_id: existing.id, note: 'An identical proposal is already waiting for the manager.' };
    const { rationale, ...payload } = i;
    const a = (await this.db.one<{ id: string }>(
      `INSERT INTO approval(run_id, property_id, action_type, target_id, payload, rationale) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ctx.runId, ctx.propertyId, actionType, i.work_order_id, JSON.stringify(payload), rationale], q))!;
    await this.ops.addEvent(q, i.work_order_id, { type: 'AGENT', runId: ctx.runId }, 'APPROVAL_REQUESTED', { approvalId: a.id, actionType, rationale });
    const label: Record<string, string> = {
      SEND_VENDOR_EMAIL: `Send email to ${i.vendor_email}`, CLOSE_WORK_ORDER: `Close "${wo.title}"`,
      CANCEL_WORK_ORDER: `Cancel "${wo.title}"`, REASSIGN_IN_PROGRESS: `Reassign "${wo.title}"`,
    };
    await this.notifications.notifyManagerOfProperty(q, ctx.propertyId, {
      kind: 'APPROVAL_NEEDED', title: `Approval needed: ${label[actionType]}`.slice(0, 200), body: rationale, linkPath: '/approvals', agentRunId: ctx.runId,
    });
    return { status: 'PENDING_APPROVAL', approval_id: a.id, message: 'Not executed. Waiting for manager approval.' };
  }
}

class ScopeError extends Error {}

function fail(message: string): ToolOutcome {
  return { ok: false, result: { error: message } };
}
