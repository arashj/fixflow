import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { config } from '../config';
import { Db, Queryable } from '../db/db.service';

/**
 * Outbox pattern: emails are written in the same transaction as the action that caused them,
 * then a drain loop delivers them. This dev transport logs instead of sending; swap deliver()
 * for SMTP/SES in production. Nothing is ever lost if the process dies between commit and send.
 */
@Injectable()
export class MailerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger('Mailer');
  private timer?: NodeJS.Timeout;

  constructor(private db: Db) {}

  async queue(q: Queryable, m: { to: string; subject: string; body: string; workOrderId?: string; approvalId?: string }) {
    return (await this.db.one<{ id: string }>(
      `INSERT INTO outbox_email(to_address, subject, body, work_order_id, approval_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [m.to, m.subject, m.body, m.workOrderId ?? null, m.approvalId ?? null], q))!;
  }

  onApplicationBootstrap() {
    if (config.agentWorkerEnabled) this.timer = setInterval(() => void this.drain().catch((e) => this.log.error(e)), 5000);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async drain() {
    const rows = await this.db.many<{ id: string; to: string; subject: string }>(
      `UPDATE outbox_email SET status = 'SENT', sent_at = now()
        WHERE id IN (SELECT id FROM outbox_email WHERE status = 'PENDING' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 20)
        RETURNING id, to_address AS "to", subject`);
    for (const r of rows) this.log.log(`[dev transport] email to ${r.to}: "${r.subject}"`);
    return rows.length;
  }
}
