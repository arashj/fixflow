import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../db/db.service';

export type NotificationKind = 'EMERGENCY' | 'ASSIGNMENT' | 'APPROVAL_NEEDED' | 'DIGEST' | 'STATUS';

@Injectable()
export class NotificationsService {
  constructor(private db: Db) {}

  async notify(q: Queryable, n: { recipientId: string; kind: NotificationKind; title: string; body: string; linkPath?: string; agentRunId?: string }) {
    await this.db.exec(
      `INSERT INTO notification(recipient_id, kind, title, body, link_path, agent_run_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [n.recipientId, n.kind, n.title, n.body, n.linkPath ?? null, n.agentRunId ?? null], q);
  }

  async notifyManagerOfProperty(q: Queryable, propertyId: string, n: Omit<Parameters<NotificationsService['notify']>[1], 'recipientId'>) {
    const p = await this.db.one<{ managerId: string }>('SELECT manager_id AS "managerId" FROM property WHERE id = $1', [propertyId], q);
    if (p) await this.notify(q, { ...n, recipientId: p.managerId });
  }
}
