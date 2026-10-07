import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../db/db.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Category, DUE_HOURS, OPEN_WO_STATUSES, Urgency, WoStatus } from '../common/types';
import { config } from '../config';

/** A business-rule violation. The API maps it to HTTP 409; the agent receives it as a tool error. */
export class DomainError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

export type Actor = { type: 'USER'; userId: string } | { type: 'AGENT'; runId: string } | { type: 'SYSTEM' };

const TRANSITIONS: Record<WoStatus, WoStatus[]> = {
  OPEN: ['CANCELLED'], // OPEN -> ASSIGNED only through assignTechnician
  ASSIGNED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED', 'CANCELLED'],
  ON_HOLD: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};
const TECH_TRANSITIONS: Partial<Record<WoStatus, WoStatus[]>> = {
  ASSIGNED: ['IN_PROGRESS'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED'],
  ON_HOLD: ['IN_PROGRESS', 'COMPLETED'],
};

export interface WorkOrderRow {
  id: string;
  requestId: string | null;
  pmScheduleId: string | null;
  propertyId: string;
  unitId: string | null;
  assetId: string | null;
  title: string;
  category: Category;
  priority: Urgency;
  status: WoStatus;
  assignedTechnicianId: string | null;
  dueAt: Date | null;
}

const WO_COLS = `id, request_id AS "requestId", pm_schedule_id AS "pmScheduleId", property_id AS "propertyId", unit_id AS "unitId",
  asset_id AS "assetId", title, category, priority, status, assigned_technician_id AS "assignedTechnicianId", due_at AS "dueAt"`;

@Injectable()
export class WorkOrderOps {
  constructor(private db: Db, private notifications: NotificationsService) {}

  // ───────────────────────── helpers ─────────────────────────

  async addEvent(q: Queryable, workOrderId: string, actor: Actor, eventType: string, payload: Record<string, unknown> = {}) {
    await this.db.exec(
      `INSERT INTO work_order_event(work_order_id, actor_type, actor_user_id, agent_run_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [workOrderId, actor.type, actor.type === 'USER' ? actor.userId : null, actor.type === 'AGENT' ? actor.runId : null, eventType, JSON.stringify(payload)],
      q);
  }

  async getWorkOrder(q: Queryable, id: string, lock = false): Promise<WorkOrderRow> {
    const wo = await this.db.one<WorkOrderRow>(`SELECT ${WO_COLS} FROM work_order WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id], q);
    if (!wo) throw new DomainError('Work order not found', 404);
    return wo;
  }

  private agentRunId(actor: Actor) {
    return actor.type === 'AGENT' ? actor.runId : undefined;
  }

  // ───────────────────────── requests ─────────────────────────

  async triageRequest(q: Queryable, requestId: string, t: { category: Category; urgency: Urgency; assetId?: string | null; rationale: string }) {
    const r = await this.db.one<{ status: string; propertyId: string }>(
      'SELECT status, property_id AS "propertyId" FROM maintenance_request WHERE id = $1 FOR UPDATE', [requestId], q);
    if (!r) throw new DomainError('Request not found', 404);
    if (!['NEW', 'TRIAGING', 'TRIAGED'].includes(r.status)) throw new DomainError(`Request is ${r.status}; it can no longer be triaged`);
    if (t.assetId) {
      const a = await this.db.one('SELECT 1 FROM asset WHERE id = $1 AND property_id = $2', [t.assetId, r.propertyId], q);
      if (!a) throw new DomainError('Asset does not belong to this property', 422);
    }
    await this.db.exec(
      `UPDATE maintenance_request SET category = $2, urgency = $3, asset_id = $4, triage_rationale = $5, status = 'TRIAGED', updated_at = now()
       WHERE id = $1`, [requestId, t.category, t.urgency, t.assetId ?? null, t.rationale], q);
  }

  async markDuplicate(q: Queryable, requestId: string, duplicateOfId: string, rationale: string, actor: Actor) {
    if (requestId === duplicateOfId) throw new DomainError('A request cannot duplicate itself', 422);
    const r = await this.db.one<{ status: string; propertyId: string; title: string }>(
      'SELECT status, property_id AS "propertyId", title FROM maintenance_request WHERE id = $1 FOR UPDATE', [requestId], q);
    if (!r) throw new DomainError('Request not found', 404);
    if (!['NEW', 'TRIAGING', 'TRIAGED'].includes(r.status)) throw new DomainError(`Request is ${r.status}; it can't be marked duplicate`);
    const target = await this.db.one<{ status: string; propertyId: string; duplicateOfId: string | null }>(
      'SELECT status, property_id AS "propertyId", duplicate_of_id AS "duplicateOfId" FROM maintenance_request WHERE id = $1', [duplicateOfId], q);
    if (!target || target.propertyId !== r.propertyId) throw new DomainError('Original request not found in this property', 422);
    if (['DUPLICATE', 'REJECTED'].includes(target.status)) throw new DomainError(`Original request is ${target.status}; point to the request it duplicates instead`, 422);
    await this.db.exec(
      `UPDATE maintenance_request SET status = 'DUPLICATE', duplicate_of_id = $2, triage_rationale = $3, updated_at = now() WHERE id = $1`,
      [requestId, duplicateOfId, rationale], q);
    const wo = await this.db.one<{ id: string }>('SELECT id FROM work_order WHERE request_id = $1', [duplicateOfId], q);
    if (wo) await this.addEvent(q, wo.id, actor, 'DUPLICATE_LINKED', { requestId, title: r.title, rationale });
    await this.notifyTenant(q, requestId, 'Your request was linked to an existing one',
      `"${r.title}" is the same issue as a request already being handled, so it was merged with it.`);
  }

  async notifyTenant(q: Queryable, requestId: string, title: string, body: string, agentRunId?: string) {
    const r = await this.db.one<{ submittedBy: string; role: string }>(
      `SELECT r.submitted_by AS "submittedBy", u.role FROM maintenance_request r JOIN app_user u ON u.id = r.submitted_by WHERE r.id = $1`, [requestId], q);
    if (r && r.role === 'TENANT') {
      await this.notifications.notify(q, { recipientId: r.submittedBy, kind: 'STATUS', title, body, linkPath: `/requests/${requestId}`, agentRunId });
    }
  }

  // ───────────────────────── work orders ─────────────────────────

  async createFromRequest(q: Queryable, requestId: string, w: { title: string; description: string; priority: Urgency; dueAt?: string | null }, actor: Actor) {
    const r = await this.db.one<{ status: string; propertyId: string; unitId: string | null; assetId: string | null; category: Category | null }>(
      `SELECT status, property_id AS "propertyId", unit_id AS "unitId", asset_id AS "assetId", category
         FROM maintenance_request WHERE id = $1 FOR UPDATE`, [requestId], q);
    if (!r) throw new DomainError('Request not found', 404);
    const existing = await this.db.one<{ id: string }>('SELECT id FROM work_order WHERE request_id = $1', [requestId], q);
    if (existing) throw new DomainError(`Request already has work order ${existing.id}`);
    if (r.status !== 'TRIAGED' || !r.category) throw new DomainError('Request must be triaged (category and urgency set) before creating a work order', 422);
    const due = w.dueAt ? new Date(w.dueAt) : new Date(Date.now() + DUE_HOURS[w.priority] * 3600_000);
    if (isNaN(due.getTime())) throw new DomainError('due_at is not a valid date-time', 422);
    const wo = (await this.db.one<{ id: string }>(
      `INSERT INTO work_order(request_id, property_id, unit_id, asset_id, title, description, category, priority, due_at,
                              created_by_user_id, created_by_agent_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [requestId, r.propertyId, r.unitId, r.assetId, w.title, w.description, r.category, w.priority, due,
       actor.type === 'USER' ? actor.userId : null, this.agentRunId(actor) ?? null], q))!;
    await this.db.exec(`UPDATE maintenance_request SET status = 'CONVERTED', updated_at = now() WHERE id = $1`, [requestId], q);
    await this.addEvent(q, wo.id, actor, 'CREATED', { priority: w.priority, dueAt: due.toISOString() });
    await this.notifyTenant(q, requestId, 'Repair scheduled', `A work order was created for your request: ${w.title}.`, this.agentRunId(actor));
    return { id: wo.id, dueAt: due.toISOString() };
  }

  async listTechnicians(q: Queryable, propertyId: string, category: Category, neededBy?: string) {
    const until = neededBy ? new Date(neededBy) : new Date(Date.now() + 24 * 3600_000);
    if (isNaN(until.getTime())) throw new DomainError('needed_by is not a valid date-time', 422);
    return this.db.many(
      `SELECT t.user_id AS technician_id, u.full_name AS name, t.max_open_work_orders AS capacity,
              (SELECT count(*)::int FROM work_order w WHERE w.assigned_technician_id = t.user_id AND w.status IN ('ASSIGNED','IN_PROGRESS','ON_HOLD')) AS open_work_orders,
              EXISTS (SELECT 1 FROM technician_unavailability x WHERE x.technician_id = t.user_id AND x.starts_at <= now() AND x.ends_at > now()) AS unavailable_now,
              EXISTS (SELECT 1 FROM technician_unavailability x WHERE x.technician_id = t.user_id AND x.starts_at < $3 AND x.ends_at > now()) AS unavailable_before_needed_by,
              (SELECT max(x.ends_at) FROM technician_unavailability x WHERE x.technician_id = t.user_id AND x.ends_at > now() AND x.starts_at <= now()) AS available_again_at
         FROM technician t
         JOIN app_user u ON u.id = t.user_id
         JOIN technician_skill s ON s.technician_id = t.user_id AND s.category = $2
         JOIN technician_property tp ON tp.technician_id = t.user_id AND tp.property_id = $1
        WHERE t.active
        ORDER BY open_work_orders, u.full_name`,
      [propertyId, category, until], q);
  }

  async assign(q: Queryable, workOrderId: string, technicianId: string, actor: Actor, opts: { rationale?: string; allowInProgress?: boolean; ignoreCapacity?: boolean } = {}) {
    const wo = await this.getWorkOrder(q, workOrderId, true);
    const allowed: WoStatus[] = opts.allowInProgress ? ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'] : ['OPEN', 'ASSIGNED'];
    if (!allowed.includes(wo.status)) {
      throw new DomainError(wo.status === 'IN_PROGRESS' || wo.status === 'ON_HOLD'
        ? `Work order is ${wo.status}; reassigning work in progress needs manager approval`
        : `Work order is ${wo.status} and can't be assigned`);
    }
    if (wo.assignedTechnicianId === technicianId) throw new DomainError('Work order is already assigned to this technician');
    const t = await this.db.one<{ active: boolean; name: string; capacity: number; hasSkill: boolean; coversProperty: boolean; open: number }>(
      `SELECT t.active, u.full_name AS name, t.max_open_work_orders AS capacity,
              EXISTS (SELECT 1 FROM technician_skill s WHERE s.technician_id = t.user_id AND s.category = $2) AS "hasSkill",
              EXISTS (SELECT 1 FROM technician_property p WHERE p.technician_id = t.user_id AND p.property_id = $3) AS "coversProperty",
              (SELECT count(*)::int FROM work_order w WHERE w.assigned_technician_id = t.user_id AND w.status IN ('ASSIGNED','IN_PROGRESS','ON_HOLD')) AS open
         FROM technician t JOIN app_user u ON u.id = t.user_id WHERE t.user_id = $1 FOR UPDATE OF t`,
      [technicianId, wo.category, wo.propertyId], q);
    if (!t) throw new DomainError('Technician not found', 422);
    if (!t.active) throw new DomainError(`${t.name} is inactive`, 422);
    if (!t.coversProperty) throw new DomainError(`${t.name} does not cover this property`, 422);
    if (!t.hasSkill) throw new DomainError(`${t.name} is not qualified for ${wo.category}`, 422);
    if (!opts.ignoreCapacity && t.open >= t.capacity) throw new DomainError(`${t.name} is at capacity (${t.open}/${t.capacity} open work orders)`, 422);
    const newStatus: WoStatus = wo.status === 'OPEN' ? 'ASSIGNED' : wo.status;
    await this.db.exec(`UPDATE work_order SET assigned_technician_id = $2, status = $3, updated_at = now() WHERE id = $1`,
      [workOrderId, technicianId, newStatus], q);
    await this.addEvent(q, workOrderId, actor, wo.assignedTechnicianId ? 'REASSIGNED' : 'ASSIGNED',
      { technicianId, technicianName: t.name, previousTechnicianId: wo.assignedTechnicianId, rationale: opts.rationale ?? null });
    await this.notifications.notify(q, {
      recipientId: technicianId, kind: 'ASSIGNMENT', title: `New job: ${wo.title}`,
      body: `Priority ${wo.priority}${wo.dueAt ? `, due ${new Date(wo.dueAt).toISOString()}` : ''}.`,
      linkPath: `/work-orders/${workOrderId}`, agentRunId: this.agentRunId(actor),
    });
    return { workOrderId, technicianId, technicianName: t.name, status: newStatus };
  }

  async changeStatus(q: Queryable, workOrderId: string, to: WoStatus, actor: Actor, opts: { asTechnician?: boolean; note?: string; resolutionNotes?: string } = {}) {
    const wo = await this.getWorkOrder(q, workOrderId, true);
    const allowed = (opts.asTechnician ? TECH_TRANSITIONS[wo.status] : TRANSITIONS[wo.status]) ?? [];
    if (!allowed.includes(to)) throw new DomainError(`Can't move a work order from ${wo.status} to ${to}`);
    if (to === 'COMPLETED' && !opts.resolutionNotes?.trim()) throw new DomainError('Resolution notes are required to complete a work order', 422);
    await this.db.exec(
      `UPDATE work_order SET status = $2::varchar, updated_at = now(),
              resolution_notes = coalesce($3::text, resolution_notes),
              completed_at = CASE WHEN $2::varchar = 'COMPLETED' THEN now() ELSE completed_at END
        WHERE id = $1`, [workOrderId, to, opts.resolutionNotes?.trim() || null], q);
    await this.addEvent(q, workOrderId, actor, 'STATUS_CHANGED', { from: wo.status, to, note: opts.note ?? null, resolutionNotes: opts.resolutionNotes ?? null });
    if (wo.requestId && ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(to)) {
      const msg = { IN_PROGRESS: 'A technician has started on your repair.', COMPLETED: 'Your repair is done.', CANCELLED: 'Your repair was cancelled. Contact your property manager for details.' }[to as 'IN_PROGRESS'];
      await this.notifyTenant(q, wo.requestId, `Repair update: ${wo.title}`, msg, this.agentRunId(actor));
    }
    return { workOrderId, from: wo.status, to };
  }

  async createPmWorkOrder(q: Queryable, pmScheduleId: string, actor: Actor) {
    const pm = await this.db.one<{ id: string; assetId: string; title: string; description: string | null; intervalDays: number; nextDueOn: string; active: boolean;
      propertyId: string; unitId: string | null; category: Category; assetName: string }>(
      `SELECT pm.id, pm.asset_id AS "assetId", pm.title, pm.description, pm.interval_days AS "intervalDays", pm.next_due_on AS "nextDueOn", pm.active,
              a.property_id AS "propertyId", a.unit_id AS "unitId", a.category, a.name AS "assetName"
         FROM pm_schedule pm JOIN asset a ON a.id = pm.asset_id WHERE pm.id = $1 FOR UPDATE OF pm`, [pmScheduleId], q);
    if (!pm) throw new DomainError('Preventive maintenance schedule not found', 404);
    if (!pm.active) throw new DomainError('Schedule is inactive', 422);
    const open = await this.db.one<{ id: string }>(
      `SELECT id FROM work_order WHERE pm_schedule_id = $1 AND status NOT IN ('COMPLETED','CANCELLED')`, [pmScheduleId], q);
    if (open) return { workOrderId: open.id, created: false, note: 'An open work order already exists for this schedule' };
    // Due at the end of the scheduled day (app time zone), but never less than 24h from now,
    // so a task created late on its due date (or after missing it) doesn't start out overdue.
    const { due } = (await this.db.one<{ due: Date }>(
      `SELECT greatest((($1::date + 1)::timestamp AT TIME ZONE $2) - interval '1 minute', now() + interval '24 hours') AS due`,
      [pm.nextDueOn, config.timezone], q))!;
    const wo = (await this.db.one<{ id: string }>(
      `INSERT INTO work_order(pm_schedule_id, property_id, unit_id, asset_id, title, description, category, priority, due_at,
                              created_by_user_id, created_by_agent_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'NORMAL',$8,$9,$10) RETURNING id`,
      [pm.id, pm.propertyId, pm.unitId, pm.assetId, `${pm.title} (${pm.assetName})`, pm.description ?? `Preventive maintenance: ${pm.title}`,
       pm.category, due, actor.type === 'USER' ? actor.userId : null, this.agentRunId(actor) ?? null], q))!;
    await this.db.exec(`UPDATE pm_schedule SET next_due_on = next_due_on + interval_days WHERE id = $1`, [pm.id], q);
    await this.addEvent(q, wo.id, actor, 'CREATED', { source: 'PREVENTIVE', pmScheduleId: pm.id, dueOn: pm.nextDueOn });
    return { workOrderId: wo.id, created: true, dueOn: pm.nextDueOn };
  }

  isOpen(status: WoStatus) {
    return OPEN_WO_STATUSES.includes(status);
  }
}
