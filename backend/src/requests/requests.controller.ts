import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res,
  UploadedFiles, UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { diskStorage } from 'multer';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { config } from '../config';
import { Db } from '../db/db.service';
import { AccessService } from '../common/access.service';
import { AuthUser, CATEGORIES, URGENCIES } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, Roles } from '../auth/decorators';
import { AgentQueue } from '../agent/agent-queue.service';
import { DomainError, WorkOrderOps } from '../work-orders/work-order.ops';

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const CreateBody = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(5).max(4000),
  unitId: z.string().uuid().optional(),
  propertyId: z.string().uuid().optional(),
});
const TriageBody = z.object({
  category: z.enum(CATEGORIES),
  urgency: z.enum(URGENCIES),
  assetId: z.string().uuid().nullable().optional(),
});
const RejectBody = z.object({ reason: z.string().trim().min(3).max(1000) });

/** Checks the file really is the image type it claims (magic bytes), not just its mimetype. */
function looksLikeImage(file: string, type: string): boolean {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(12);
  fs.readSync(fd, b, 0, 12, 0);
  fs.closeSync(fd);
  if (type === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/webp') return b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
  return false;
}

@Controller('api')
export class RequestsController {
  constructor(
    private db: Db,
    private access: AccessService,
    private queue: AgentQueue,
    private ops: WorkOrderOps,
  ) {}

  @Get('requests')
  async list(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    const where: string[] = [];
    const params: unknown[] = [u.id];
    if (u.role === 'TENANT') where.push('r.submitted_by = $1');
    else if (u.role === 'MANAGER') where.push('p.manager_id = $1');
    else where.push('w.assigned_technician_id = $1');
    if (status) {
      params.push(status.split(','));
      where.push(`r.status = ANY($${params.length})`);
    }
    return this.db.many(
      `SELECT r.id, r.title, r.status, r.category, r.urgency, r.created_at AS "createdAt",
              p.id AS "propertyId", p.name AS "propertyName", un.label AS "unitLabel", sub.full_name AS "submittedByName",
              w.id AS "workOrderId", w.status AS "workOrderStatus",
              (SELECT count(*)::int FROM request_attachment a WHERE a.request_id = r.id) AS "photoCount",
              (SELECT ar.status FROM agent_run ar WHERE ar.run_type = 'TRIAGE' AND ar.trigger_ref = r.id ORDER BY ar.created_at DESC LIMIT 1) AS "agentStatus"
         FROM maintenance_request r
         JOIN property p ON p.id = r.property_id
         JOIN app_user sub ON sub.id = r.submitted_by
         LEFT JOIN unit un ON un.id = r.unit_id
         LEFT JOIN work_order w ON w.request_id = r.id
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC
        LIMIT 200`, params);
  }

  @Post('requests')
  @Roles('TENANT', 'MANAGER')
  @UseInterceptors(FilesInterceptor('photos', 4, {
    storage: diskStorage({
      destination: (_req, _file, cb) => { fs.mkdirSync(config.uploadDir, { recursive: true }); cb(null, config.uploadDir); },
      filename: (_req, file, cb) => cb(null, crypto.randomUUID() + (IMAGE_TYPES[file.mimetype] ?? '')),
    }),
    limits: { fileSize: MAX_PHOTO_BYTES, files: 4 },
    fileFilter: (_req, file, cb) => {
      if (IMAGE_TYPES[file.mimetype]) cb(null, true);
      else cb(new BadRequestException('Photos must be JPEG, PNG or WebP'), false);
    },
  }))
  async create(@CurrentUser() u: AuthUser, @Body() rawBody: unknown, @UploadedFiles() files: Express.Multer.File[] = []) {
    const cleanup = () => files.forEach((f) => fs.rmSync(f.path, { force: true }));
    try {
      const body = new ZodPipe(CreateBody).transform(rawBody);
      for (const f of files) if (!looksLikeImage(f.path, f.mimetype)) throw new BadRequestException(`${f.originalname} is not a valid image`);

      let propertyId: string;
      let unitId: string | null;
      if (u.role === 'TENANT') {
        const unit = await this.db.one<{ id: string; propertyId: string }>(
          `SELECT id, property_id AS "propertyId" FROM unit WHERE tenant_id = $1 ${body.unitId ? 'AND id = $2' : ''} ORDER BY label LIMIT 1`,
          body.unitId ? [u.id, body.unitId] : [u.id]);
        if (!unit) throw new BadRequestException('Your account is not linked to a unit. Contact your property manager.');
        propertyId = unit.propertyId;
        unitId = unit.id;
      } else {
        if (body.unitId) {
          const unit = await this.db.one<{ propertyId: string }>('SELECT property_id AS "propertyId" FROM unit WHERE id = $1', [body.unitId]);
          if (!unit) throw new BadRequestException('Unit not found');
          propertyId = unit.propertyId;
          unitId = body.unitId;
        } else if (body.propertyId) {
          propertyId = body.propertyId;
          unitId = null;
        } else throw new BadRequestException('unitId or propertyId is required');
        await this.access.assertManagesProperty(u, propertyId);
      }

      return await this.db.tx(async (q) => {
        const r = (await this.db.one<{ id: string }>(
          `INSERT INTO maintenance_request(property_id, unit_id, submitted_by, title, description) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [propertyId, unitId, u.id, body.title, body.description], q))!;
        for (const f of files) {
          await this.db.exec(`INSERT INTO request_attachment(request_id, storage_key, content_type, size_bytes) VALUES ($1,$2,$3,$4)`,
            [r.id, f.filename, f.mimetype, f.size], q);
        }
        const run = await this.queue.enqueue(q, 'TRIAGE', r.id);
        return { id: r.id, agentRunId: run.id };
      });
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  @Get('requests/:id')
  async get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.access.assertCanViewRequest(u, id);
    const r = await this.db.one(
      `SELECT r.id, r.title, r.description, r.status, r.category, r.urgency, r.triage_rationale AS "triageRationale",
              r.created_at AS "createdAt", r.updated_at AS "updatedAt",
              p.id AS "propertyId", p.name AS "propertyName", un.id AS "unitId", un.label AS "unitLabel",
              sub.full_name AS "submittedByName",
              a.id AS "assetId", a.name AS "assetName",
              d.id AS "duplicateOfId", d.title AS "duplicateOfTitle",
              w.id AS "workOrderId", w.status AS "workOrderStatus", w.due_at AS "workOrderDueAt", tu.full_name AS "technicianName"
         FROM maintenance_request r
         JOIN property p ON p.id = r.property_id
         JOIN app_user sub ON sub.id = r.submitted_by
         LEFT JOIN unit un ON un.id = r.unit_id
         LEFT JOIN asset a ON a.id = r.asset_id
         LEFT JOIN maintenance_request d ON d.id = r.duplicate_of_id
         LEFT JOIN work_order w ON w.request_id = r.id
         LEFT JOIN app_user tu ON tu.id = w.assigned_technician_id
        WHERE r.id = $1`, [id]);
    const photos = await this.db.many(
      `SELECT id, content_type AS "contentType", size_bytes AS "sizeBytes" FROM request_attachment WHERE request_id = $1 ORDER BY created_at`, [id]);
    const agentRuns = await this.db.many(
      `SELECT id, status, summary, error, created_at AS "createdAt", finished_at AS "finishedAt"
         FROM agent_run WHERE run_type = 'TRIAGE' AND trigger_ref = $1 ORDER BY created_at DESC`, [id]);
    return { ...r, photos, agentRuns: u.role === 'MANAGER' ? agentRuns : agentRuns.map(({ id: runId, status: s, createdAt }) => ({ id: runId, status: s, createdAt })) };
  }

  @Post('requests/:id/retriage')
  @Roles('MANAGER')
  async retriage(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.access.assertCanViewRequest(u, id);
    return this.db.tx(async (q) => {
      const r = await this.db.one<{ status: string }>('SELECT status FROM maintenance_request WHERE id = $1 FOR UPDATE', [id], q);
      if (!['NEW', 'TRIAGED'].includes(r!.status)) throw new DomainError(`Request is ${r!.status}; only new or triaged requests can be re-run`);
      return this.queue.enqueue(q, 'TRIAGE', id);
    });
  }

  @Post('requests/:id/triage')
  @Roles('MANAGER')
  @HttpCode(200)
  async triage(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(TriageBody)) body: z.infer<typeof TriageBody>) {
    await this.access.assertCanViewRequest(u, id);
    await this.db.tx((q) => this.ops.triageRequest(q, id, { ...body, rationale: `Triaged manually by ${u.fullName}` }));
    return { ok: true };
  }

  @Post('requests/:id/reject')
  @Roles('MANAGER')
  @HttpCode(200)
  async reject(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(RejectBody)) body: z.infer<typeof RejectBody>) {
    await this.access.assertCanViewRequest(u, id);
    await this.db.tx(async (q) => {
      const r = await this.db.one<{ status: string }>('SELECT status FROM maintenance_request WHERE id = $1 FOR UPDATE', [id], q);
      if (!['NEW', 'TRIAGING', 'TRIAGED'].includes(r!.status)) throw new DomainError(`Request is ${r!.status} and can't be rejected`);
      await this.db.exec(`UPDATE maintenance_request SET status = 'REJECTED', triage_rationale = $2, updated_at = now() WHERE id = $1`,
        [id, `Rejected by ${u.fullName}: ${body.reason}`], q);
      await this.ops.notifyTenant(q, id, 'Request closed', `Your property manager closed this request: ${body.reason}`);
    });
    return { ok: true };
  }

  @Get('attachments/:id')
  async attachment(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const a = await this.db.one<{ requestId: string; storageKey: string; contentType: string }>(
      'SELECT request_id AS "requestId", storage_key AS "storageKey", content_type AS "contentType" FROM request_attachment WHERE id = $1', [id]);
    if (!a) throw new NotFoundException();
    await this.access.assertCanViewRequest(u, a.requestId);
    const file = path.join(config.uploadDir, path.basename(a.storageKey));
    if (!fs.existsSync(file)) throw new NotFoundException('File is missing from storage');
    res.setHeader('Content-Type', a.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(file).pipe(res);
  }
}
