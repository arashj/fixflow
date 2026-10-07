import { Controller, Get, Query } from '@nestjs/common';
import { Db } from '../db/db.service';
import { AuthUser } from '../common/types';
import { CurrentUser, Roles } from '../auth/decorators';

@Controller('api')
@Roles('MANAGER')
export class AdminController {
  constructor(private db: Db) {}

  @Get('dashboard')
  async dashboard(@CurrentUser() u: AuthUser) {
    const stats = await this.db.one(
      `WITH props AS (SELECT id FROM property WHERE manager_id = $1),
            wo AS (SELECT * FROM work_order WHERE property_id IN (SELECT id FROM props))
       SELECT
         (SELECT count(*)::int FROM maintenance_request WHERE property_id IN (SELECT id FROM props) AND status IN ('NEW','TRIAGING','TRIAGED')) AS "requestsWaiting",
         (SELECT count(*)::int FROM wo WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS','ON_HOLD')) AS "openWorkOrders",
         (SELECT count(*)::int FROM wo WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS','ON_HOLD') AND due_at < now()) AS "overdue",
         (SELECT count(*)::int FROM wo WHERE status = 'OPEN') AS "unassigned",
         (SELECT count(*)::int FROM wo WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS','ON_HOLD') AND priority = 'EMERGENCY') AS "openEmergencies",
         (SELECT count(*)::int FROM wo WHERE status = 'COMPLETED' AND completed_at > now() - interval '7 days') AS "completedThisWeek",
         (SELECT count(*)::int FROM approval WHERE property_id IN (SELECT id FROM props) AND status = 'PENDING' AND expires_at > now()) AS "pendingApprovals"`,
      [u.id]);
    const agent = await this.db.one(
      `WITH props AS (SELECT id FROM property WHERE manager_id = $1),
            runs AS (SELECT ar.* FROM agent_run ar
                      LEFT JOIN maintenance_request r ON ar.run_type = 'TRIAGE' AND r.id = ar.trigger_ref
                     WHERE coalesce(r.property_id, ar.trigger_ref) IN (SELECT id FROM props) AND ar.created_at > now() - interval '30 days'),
            agent_wo AS (SELECT * FROM work_order WHERE property_id IN (SELECT id FROM props) AND created_by_agent_run_id IS NOT NULL AND created_at > now() - interval '30 days')
       SELECT (SELECT count(*)::int FROM runs) AS "runs30d",
              (SELECT count(*)::int FROM runs WHERE status = 'SUCCEEDED') AS "succeeded30d",
              (SELECT count(*)::int FROM runs WHERE status = 'FAILED') AS "failed30d",
              (SELECT round(avg(extract(epoch FROM finished_at - started_at))::numeric, 1)::float FROM runs WHERE status = 'SUCCEEDED' AND run_type = 'TRIAGE') AS "avgTriageSeconds",
              (SELECT count(*)::int FROM agent_wo) AS "workOrdersCreated30d",
              (SELECT count(*)::int FROM agent_wo w WHERE EXISTS (SELECT 1 FROM work_order_event e WHERE e.work_order_id = w.id AND e.event_type = 'ASSIGNED' AND e.actor_type = 'AGENT')) AS "autoAssigned30d"`,
      [u.id]);
    const recentRuns = await this.db.many(
      `SELECT ar.id, ar.run_type AS "runType", ar.status, ar.summary, ar.created_at AS "createdAt", coalesce(r.title, p2.name) AS subject
         FROM agent_run ar
         LEFT JOIN maintenance_request r ON ar.run_type = 'TRIAGE' AND r.id = ar.trigger_ref
         LEFT JOIN property p ON p.id = r.property_id
         LEFT JOIN property p2 ON ar.run_type <> 'TRIAGE' AND p2.id = ar.trigger_ref
        WHERE coalesce(p.manager_id, p2.manager_id) = $1 ORDER BY ar.created_at DESC LIMIT 6`, [u.id]);
    const workload = await this.db.many(
      `SELECT u.id, u.full_name AS name, t.max_open_work_orders AS capacity,
              (SELECT count(*)::int FROM work_order w WHERE w.assigned_technician_id = t.user_id AND w.status IN ('ASSIGNED','IN_PROGRESS','ON_HOLD')) AS open
         FROM technician t JOIN app_user u ON u.id = t.user_id
        WHERE t.active AND EXISTS (SELECT 1 FROM technician_property tp JOIN property p ON p.id = tp.property_id WHERE tp.technician_id = t.user_id AND p.manager_id = $1)
        ORDER BY u.full_name`, [u.id]);
    return { stats, agent, recentRuns, workload };
  }

  @Get('properties')
  async properties(@CurrentUser() u: AuthUser) {
    return this.db.many(
      `SELECT p.id, p.name, p.address,
              coalesce((SELECT json_agg(json_build_object('id', un.id, 'label', un.label, 'tenantName', tu.full_name) ORDER BY un.label)
                          FROM unit un LEFT JOIN app_user tu ON tu.id = un.tenant_id WHERE un.property_id = p.id), '[]') AS units
         FROM property p WHERE p.manager_id = $1 ORDER BY p.name`, [u.id]);
  }

  @Get('assets')
  async assets(@CurrentUser() u: AuthUser, @Query('propertyId') propertyId?: string) {
    return this.db.many(
      `SELECT a.id, a.name, a.category, a.make, a.model, a.installed_on AS "installedOn", a.vendor_name AS "vendorName", a.vendor_email AS "vendorEmail",
              p.id AS "propertyId", p.name AS "propertyName", un.label AS "unitLabel",
              (SELECT count(*)::int FROM work_order w WHERE w.asset_id = a.id AND w.pm_schedule_id IS NULL AND w.status <> 'CANCELLED' AND w.created_at > now() - interval '90 days') AS "repairs90d",
              (SELECT count(*)::int FROM work_order w WHERE w.asset_id = a.id AND w.status IN ('OPEN','ASSIGNED','IN_PROGRESS','ON_HOLD')) AS "openWorkOrders",
              coalesce((SELECT json_agg(json_build_object('id', pm.id, 'title', pm.title, 'intervalDays', pm.interval_days, 'nextDueOn', pm.next_due_on, 'active', pm.active) ORDER BY pm.next_due_on)
                          FROM pm_schedule pm WHERE pm.asset_id = a.id), '[]') AS "pmSchedules"
         FROM asset a JOIN property p ON p.id = a.property_id LEFT JOIN unit un ON un.id = a.unit_id
        WHERE p.manager_id = $1 AND ($2::uuid IS NULL OR p.id = $2::uuid)
        ORDER BY p.name, un.label NULLS FIRST, a.name`, [u.id, propertyId || null]);
  }

  @Get('technicians')
  async technicians(@CurrentUser() u: AuthUser) {
    return this.db.many(
      `SELECT t.user_id AS id, u.full_name AS name, u.email, t.phone, t.active, t.max_open_work_orders AS capacity,
              (SELECT array_agg(s.category ORDER BY s.category) FROM technician_skill s WHERE s.technician_id = t.user_id) AS skills,
              (SELECT array_agg(p.name ORDER BY p.name) FROM technician_property tp JOIN property p ON p.id = tp.property_id WHERE tp.technician_id = t.user_id) AS properties,
              (SELECT count(*)::int FROM work_order w WHERE w.assigned_technician_id = t.user_id AND w.status IN ('ASSIGNED','IN_PROGRESS','ON_HOLD')) AS open,
              (SELECT json_build_object('startsAt', x.starts_at, 'endsAt', x.ends_at, 'reason', x.reason) FROM technician_unavailability x
                WHERE x.technician_id = t.user_id AND x.ends_at > now() ORDER BY x.starts_at LIMIT 1) AS "nextUnavailability"
         FROM technician t JOIN app_user u ON u.id = t.user_id
        WHERE EXISTS (SELECT 1 FROM technician_property tp JOIN property p ON p.id = tp.property_id WHERE tp.technician_id = t.user_id AND p.manager_id = $1)
        ORDER BY u.full_name`, [u.id]);
  }

  @Get('digests')
  async digests(@CurrentUser() u: AuthUser) {
    return this.db.many(
      `SELECT d.id, d.digest_date AS "digestDate", d.summary, d.items, d.created_at AS "createdAt", d.run_id AS "runId",
              p.id AS "propertyId", p.name AS "propertyName"
         FROM digest d JOIN property p ON p.id = d.property_id
        WHERE p.manager_id = $1 ORDER BY d.digest_date DESC, p.name LIMIT 30`, [u.id]);
  }
}
