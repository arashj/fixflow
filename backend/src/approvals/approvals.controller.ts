import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Db, Queryable } from '../db/db.service';
import { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, Roles } from '../auth/decorators';
import { DomainError, WorkOrderOps } from '../work-orders/work-order.ops';
import { MailerService } from './mailer.service';

const ApproveBody = z.object({
  note: z.string().trim().max(1000).optional(),
  // The manager may edit a drafted vendor email before it is sent.
  subject: z.string().trim().min(1).max(300).optional(),
  body: z.string().trim().min(1).max(10000).optional(),
});
const RejectBody = z.object({ note: z.string().trim().max(1000).optional() });

interface ApprovalRow {
  id: string;
  runId: string;
  propertyId: string;
  actionType: 'SEND_VENDOR_EMAIL' | 'CLOSE_WORK_ORDER' | 'CANCEL_WORK_ORDER' | 'REASSIGN_IN_PROGRESS';
  targetId: string;
  payload: any;
  status: string;
  expiresAt: Date;
}

@Controller('api/approvals')
@Roles('MANAGER')
export class ApprovalsController {
  constructor(private db: Db, private ops: WorkOrderOps, private mailer: MailerService) {}

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query('status') status = 'PENDING') {
    await this.expireOld();
    return this.db.many(
      `SELECT a.id, a.action_type AS "actionType", a.status, a.payload, a.rationale, a.created_at AS "createdAt", a.expires_at AS "expiresAt",
              a.decided_at AS "decidedAt", a.decision_note AS "decisionNote", d.full_name AS "decidedByName", a.run_id AS "runId",
              a.target_id AS "workOrderId", w.title AS "workOrderTitle", w.status AS "workOrderStatus", p.name AS "propertyName",
              tu.full_name AS "currentTechnicianName", nt.full_name AS "newTechnicianName"
         FROM approval a JOIN property p ON p.id = a.property_id
         LEFT JOIN work_order w ON w.id = a.target_id
         LEFT JOIN app_user tu ON tu.id = w.assigned_technician_id
         LEFT JOIN app_user nt ON nt.id::text = a.payload->>'new_technician_id'
         LEFT JOIN app_user d ON d.id = a.decided_by
        WHERE p.manager_id = $1 AND ($2::text = 'ALL' OR a.status = $2::text)
        ORDER BY a.created_at DESC LIMIT 100`, [u.id, status.toUpperCase()]);
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ApproveBody)) b: z.infer<typeof ApproveBody>) {
    try {
      return await this.db.tx(async (q) => {
        const a = await this.lockPending(q, u, id);
        const actor = { type: 'USER' as const, userId: u.id };
        let payload = a.payload;
        let result: Record<string, unknown> = {};
        switch (a.actionType) {
          case 'SEND_VENDOR_EMAIL': {
            payload = { ...payload, subject: b.subject ?? payload.subject, body: b.body ?? payload.body };
            const mail = await this.mailer.queue(q, { to: payload.vendor_email, subject: payload.subject, body: payload.body, workOrderId: a.targetId, approvalId: a.id });
            await this.ops.addEvent(q, a.targetId, actor, 'VENDOR_EMAIL_SENT', { to: payload.vendor_email, subject: payload.subject, approvalId: a.id });
            result = { emailId: mail.id };
            break;
          }
          case 'CLOSE_WORK_ORDER': {
            const wo = await this.ops.getWorkOrder(q, a.targetId);
            // Closing goes through the normal state machine; ASSIGNED/OPEN work has to be started first.
            if (wo.status === 'ASSIGNED') await this.ops.changeStatus(q, a.targetId, 'IN_PROGRESS', actor, { note: 'Started automatically to close via approval' });
            result = await this.ops.changeStatus(q, a.targetId, 'COMPLETED', actor, { resolutionNotes: payload.resolution_notes, note: `Approved agent proposal ${a.id}` });
            break;
          }
          case 'CANCEL_WORK_ORDER':
            result = await this.ops.changeStatus(q, a.targetId, 'CANCELLED', actor, { note: `Approved agent proposal ${a.id}` });
            break;
          case 'REASSIGN_IN_PROGRESS':
            result = await this.ops.assign(q, a.targetId, payload.new_technician_id, actor, { allowInProgress: true, ignoreCapacity: true, rationale: `Approved agent proposal ${a.id}` });
            break;
        }
        await this.db.exec(
          `UPDATE approval SET status = 'EXECUTED', decided_by = $2, decided_at = now(), decision_note = $3, payload = $4 WHERE id = $1`,
          [id, u.id, b.note ?? null, JSON.stringify(payload)], q);
        await this.ops.addEvent(q, a.targetId, actor, 'APPROVAL_DECIDED', { approvalId: id, decision: 'APPROVED', actionType: a.actionType, note: b.note ?? null });
        return { status: 'EXECUTED', result };
      });
    } catch (e) {
      // The action could not run (e.g. the work order changed since the proposal). Record that and report it.
      if (e instanceof DomainError && e.status !== 404 && e.message !== 'NOT_PENDING') {
        await this.db.exec(`UPDATE approval SET status = 'FAILED', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1 AND status = 'PENDING'`,
          [id, u.id, `Could not execute: ${e.message}`]);
        throw new DomainError(`Approval could not be executed: ${e.message}`, 409);
      }
      if (e instanceof DomainError && e.message === 'NOT_PENDING') throw new DomainError('This approval was already decided or has expired', 409);
      throw e;
    }
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RejectBody)) b: z.infer<typeof RejectBody>) {
    return this.db.tx(async (q) => {
      const a = await this.lockPending(q, u, id).catch((e) => {
        if (e instanceof DomainError && e.message === 'NOT_PENDING') throw new DomainError('This approval was already decided or has expired', 409);
        throw e;
      });
      await this.db.exec(`UPDATE approval SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [id, u.id, b.note ?? null], q);
      await this.ops.addEvent(q, a.targetId, { type: 'USER', userId: u.id }, 'APPROVAL_DECIDED', { approvalId: id, decision: 'REJECTED', actionType: a.actionType, note: b.note ?? null });
      return { status: 'REJECTED' };
    });
  }

  private async lockPending(q: Queryable, u: AuthUser, id: string): Promise<ApprovalRow> {
    const a = await this.db.one<ApprovalRow & { managerId: string }>(
      `SELECT a.id, a.run_id AS "runId", a.property_id AS "propertyId", a.action_type AS "actionType", a.target_id AS "targetId",
              a.payload, a.status, a.expires_at AS "expiresAt", p.manager_id AS "managerId"
         FROM approval a JOIN property p ON p.id = a.property_id WHERE a.id = $1 FOR UPDATE OF a`, [id], q);
    if (!a || a.managerId !== u.id) throw new DomainError('Approval not found', 404);
    if (a.status !== 'PENDING' || new Date(a.expiresAt) < new Date()) throw new DomainError('NOT_PENDING');
    return a;
  }

  private async expireOld() {
    await this.db.exec(`UPDATE approval SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at < now()`);
  }
}
