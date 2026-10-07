import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Db } from '../db/db.service';
import { AuthUser } from './types';

/**
 * Row-level access rules:
 *  - MANAGER sees everything in the properties they manage.
 *  - TECHNICIAN sees work orders assigned to them (and the request behind each).
 *  - TENANT sees the requests they submitted (and the work order created from each).
 */
@Injectable()
export class AccessService {
  constructor(private db: Db) {}

  async managedPropertyIds(user: AuthUser): Promise<string[]> {
    if (user.role !== 'MANAGER') return [];
    return (await this.db.many<{ id: string }>('SELECT id FROM property WHERE manager_id = $1', [user.id])).map((r) => r.id);
  }

  async assertManagesProperty(user: AuthUser, propertyId: string) {
    const ok = user.role === 'MANAGER' && (await this.db.one('SELECT 1 FROM property WHERE id = $1 AND manager_id = $2', [propertyId, user.id]));
    if (!ok) throw new ForbiddenException('You do not manage this property');
  }

  async assertCanViewRequest(user: AuthUser, requestId: string) {
    const r = await this.db.one<{ submittedBy: string; managerId: string; technicianId: string | null }>(
      `SELECT r.submitted_by AS "submittedBy", p.manager_id AS "managerId", w.assigned_technician_id AS "technicianId"
         FROM maintenance_request r JOIN property p ON p.id = r.property_id
         LEFT JOIN work_order w ON w.request_id = r.id
        WHERE r.id = $1`, [requestId]);
    if (!r) throw new NotFoundException('Request not found');
    const ok = (user.role === 'MANAGER' && r.managerId === user.id)
      || (user.role === 'TENANT' && r.submittedBy === user.id)
      || (user.role === 'TECHNICIAN' && r.technicianId === user.id);
    if (!ok) throw new NotFoundException('Request not found');
  }

  async assertCanViewWorkOrder(user: AuthUser, workOrderId: string) {
    const w = await this.db.one<{ managerId: string; technicianId: string | null; submittedBy: string | null }>(
      `SELECT p.manager_id AS "managerId", w.assigned_technician_id AS "technicianId", r.submitted_by AS "submittedBy"
         FROM work_order w JOIN property p ON p.id = w.property_id
         LEFT JOIN maintenance_request r ON r.id = w.request_id
        WHERE w.id = $1`, [workOrderId]);
    if (!w) throw new NotFoundException('Work order not found');
    const ok = (user.role === 'MANAGER' && w.managerId === user.id)
      || (user.role === 'TECHNICIAN' && w.technicianId === user.id)
      || (user.role === 'TENANT' && w.submittedBy === user.id);
    if (!ok) throw new NotFoundException('Work order not found');
  }
}
