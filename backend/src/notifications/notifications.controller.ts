import { Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Db } from '../db/db.service';
import { AuthUser } from '../common/types';
import { CurrentUser } from '../auth/decorators';

@Controller('api/notifications')
export class NotificationsController {
  constructor(private db: Db) {}

  @Get()
  async list(@CurrentUser() u: AuthUser) {
    const items = await this.db.many(
      `SELECT id, kind, title, body, link_path AS "linkPath", read_at AS "readAt", created_at AS "createdAt"
         FROM notification WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT 50`, [u.id]);
    const { count } = (await this.db.one<{ count: number }>(
      'SELECT count(*)::int AS count FROM notification WHERE recipient_id = $1 AND read_at IS NULL', [u.id]))!;
    return { items, unread: count };
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const n = await this.db.exec('UPDATE notification SET read_at = coalesce(read_at, now()) WHERE id = $1 AND recipient_id = $2', [id, u.id]);
    if (!n) throw new NotFoundException();
  }

  @Post('read-all')
  @HttpCode(204)
  async readAll(@CurrentUser() u: AuthUser) {
    await this.db.exec('UPDATE notification SET read_at = now() WHERE recipient_id = $1 AND read_at IS NULL', [u.id]);
  }
}
