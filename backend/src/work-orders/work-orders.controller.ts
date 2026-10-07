import { Body, Controller, ForbiddenException, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Db } from '../db/db.service';
import { AccessService } from '../common/access.service';
import { AuthUser, URGENCIES, WO_STATUSES } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, Roles } from '../auth/decorators';
import { WorkOrderOps } from './work-order.ops';

const StatusBody = z.object({
  status: z.enum(WO_STATUSES),
  note: z.string().trim().max(2000).optional(),
  resolutionNotes: z.string().trim().max(4000).optional(),
});
const CommentBody = z.object({ text: z.string().trim().min(1).max(2000) });
const AssignBody = z.object({ technicianId: z.string().uuid() });
const CreateBody = z.object({
  requestId: z.string().uuid(),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).max(4000),
  priority: z.enum(URGENCIES),
  dueAt: z.string().datetime({ offset: true }).optional(),
});

const LIST_COLS = `w.id, w.title, w.status, w.priority, w.category, w.due_at AS "dueAt", w.created_at AS "createdAt", w.completed_at AS "completedAt",
  w.request_id AS "requestId", w.pm_schedule_id AS "pmScheduleId",
  CASE WHEN w.pm_schedule_id IS NOT NULL THEN 'PREVENTIVE' ELSE 'REQUEST' END AS source,
  (w.created_by_agent_run_id IS NOT NULL) AS "createdByAgent",
  (w.due_at < now() AND w.status IN ('OPEN','ASSIGNED','IN_PROGRESS','ON_HOLD')) AS overdue,
  p.id AS "propertyId", p.name AS "propertyName", un.label AS "unitLabel", a.name AS "assetName",
  w.assigned_technician_id AS "technicianId", tu.full_name AS "technicianName"`;
const LIST_FROM = `FROM work_order w JOIN property p ON p.id = w.property_id
  LEFT JOIN unit un ON un.id = w.unit_id LEFT JOIN asset a ON a.id = w.asset_id
  LEFT JOIN app_user tu ON tu.id = w.assigned_technician_id
  LEFT JOIN maintenance_request r ON r.id = w.request_id`;

@Controller('api/work-orders')
export class WorkOrdersController {
  constructor(private db: Db, private access: AccessService, private ops: WorkOrderOps) {}

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query('status') status?: string, @Query('overdue') overdue?: string) {
    const params: unknown[] = [u.id];
    const where = [u.role === 'MANAGER' ? 'p.manager_id = $1' : u.role === 'TECHNICIAN' ? 'w.assigned_technician_id = $1' : 'r.submitted_by = $1'];
    if (status) {
      params.push(status.split(','));
      where.push(`w.status = ANY($${params.length})`);
    }
    if (overdue === 'true') where.push(`w.due_at < now() AND w.status IN ('OPEN','ASSIGNED','IN_PROGRESS','ON_HOLD')`);
    return this.db.many(
      `SELECT ${LIST_COLS} ${LIST_FROM} WHERE ${where.join(' AND ')}
        ORDER BY CASE w.status WHEN 'COMPLETED' THEN 2 WHEN 'CANCELLED' THEN 3 ELSE 1 END,
                 CASE w.priority WHEN 'EMERGENCY' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, w.due_at NULLS LAST
        LIMIT 300`, params);
  }

  @Post()
  @Roles('MANAGER')
  async create(@CurrentUser() u: AuthUser, @Body(new ZodPipe(CreateBody)) b: z.infer<typeof CreateBody>) {
    await this.access.assertCanViewRequest(u, b.requestId);
    return this.db.tx((q) => this.ops.createFromRequest(q, b.requestId, b, { type: 'USER', userId: u.id }));
  }

  @Get(':id')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.access.assertCanViewWorkOrder(u, id);
    const wo = await this.db.one(
      `SELECT ${LIST_COLS}, w.description, w.resolution_notes AS "resolutionNotes", w.asset_id AS "assetId", w.unit_id AS "unitId",
              w.created_by_agent_run_id AS "createdByAgentRunId", r.title AS "requestTitle", r.description AS "requestDescription",
              r.triage_rationale AS "triageRationale", r.urgency AS "requestUrgency", sub.full_name AS "submittedByName",
              a.make AS "assetMake", a.model AS "assetModel", a.vendor_name AS "vendorName", a.vendor_email AS "vendorEmail"
         ${LIST_FROM} LEFT JOIN app_user sub ON sub.id = r.submitted_by
        WHERE w.id = $1`, [id]);
    const events = await this.db.many(
      `SELECT e.id, e.actor_type AS "actorType", e.event_type AS "eventType", e.payload, e.created_at AS "createdAt",
              e.agent_run_id AS "agentRunId", u.full_name AS "actorName"
         FROM work_order_event e LEFT JOIN app_user u ON u.id = e.actor_user_id
        WHERE e.work_order_id = $1 ORDER BY e.created_at, e.id`, [id]);
    const photos = wo.requestId
      ? await this.db.many('SELECT id FROM request_attachment WHERE request_id = $1 ORDER BY created_at', [wo.requestId]) : [];
    const approvals = u.role === 'MANAGER'
      ? await this.db.many(
        `SELECT id, action_type AS "actionType", status, rationale, created_at AS "createdAt" FROM approval
          WHERE target_id = $1 ORDER BY created_at DESC`, [id]) : [];
    return { ...wo, events, photos, approvals };
  }

  @Get(':id/technicians')
  @Roles('MANAGER')
  async candidates(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.access.assertCanViewWorkOrder(u, id);
    const wo = await this.ops.getWorkOrder(this.db.pool, id);
    return this.ops.listTechnicians(this.db.pool, wo.propertyId, wo.category);
  }

  @Post(':id/assign')
  @Roles('MANAGER')
  @HttpCode(200)
  async assign(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(AssignBody)) b: z.infer<typeof AssignBody>) {
    await this.access.assertCanViewWorkOrder(u, id);
    return this.db.tx((q) => this.ops.assign(q, id, b.technicianId, { type: 'USER', userId: u.id }, { allowInProgress: true, ignoreCapacity: true }));
  }

  @Post(':id/status')
  @Roles('MANAGER', 'TECHNICIAN')
  @HttpCode(200)
  async status(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(StatusBody)) b: z.infer<typeof StatusBody>) {
    await this.access.assertCanViewWorkOrder(u, id);
    return this.db.tx((q) => this.ops.changeStatus(q, id, b.status, { type: 'USER', userId: u.id },
      { asTechnician: u.role === 'TECHNICIAN', note: b.note, resolutionNotes: b.resolutionNotes }));
  }

  @Post(':id/comments')
  @HttpCode(201)
  async comment(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(CommentBody)) b: z.infer<typeof CommentBody>) {
    await this.access.assertCanViewWorkOrder(u, id);
    if (u.role === 'TENANT') throw new ForbiddenException('Tenants comment through their request');
    await this.ops.addEvent(this.db.pool, id, { type: 'USER', userId: u.id }, 'COMMENT', { text: b.text });
    return { ok: true };
  }
}
