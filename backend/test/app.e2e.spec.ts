import { api, createApp, drainAgent, login, PNG, reply, resetDb, TestCtx } from './helpers';
import { NonRetryableError } from '../src/agent/llm/llm.types';

let ctx: TestCtx;
let manager: string;

beforeAll(async () => {
  ctx = await createApp();
});
afterAll(async () => {
  await ctx.app.close();
});
beforeEach(async () => {
  await resetDb(ctx);
  manager = await login(ctx, 'manager');
});

async function submit(who: string, title: string, description: string, photos: Buffer[] = []) {
  const token = await login(ctx, who);
  let r = api(ctx, token).post('/api/requests').field('title', title).field('description', description);
  photos.forEach((p, i) => (r = r.attach('photos', p, { filename: `photo${i}.png`, contentType: 'image/png' })));
  const res = await r.expect(201);
  return { token, id: res.body.id as string, runId: res.body.agentRunId as string };
}

async function workOrderFor(requestId: string) {
  return ctx.db.one('SELECT * FROM work_order WHERE request_id = $1', [requestId]);
}

// ───────────────────────────── auth & access ─────────────────────────────

describe('auth and access control', () => {
  it('rejects a wrong password and lists public demo accounts', async () => {
    await api(ctx).post('/api/auth/login').send({ email: 'manager@demo.fixflow.dev', password: 'nope' }).expect(401);
    const res = await api(ctx).get('/api/auth/demo-accounts').expect(200);
    expect(res.body).toHaveLength(11);
    expect(res.body[0].role).toBe('MANAGER');
  });

  it('requires a token and enforces roles', async () => {
    await api(ctx).get('/api/requests').expect(401);
    await api(ctx, 'garbage').get('/api/requests').expect(401);
    const tenant = await login(ctx, 'emma');
    await api(ctx, tenant).get('/api/approvals').expect(403);
    await api(ctx, tenant).get('/api/dashboard').expect(403);
    const tech = await login(ctx, 'luis');
    await api(ctx, tech).post('/api/requests').field('title', 'x').expect(403);
  });

  it('tenants only see their own requests', async () => {
    const emma = await login(ctx, 'emma');
    const list = await api(ctx, emma).get('/api/requests').expect(200);
    expect(list.body.every((r: any) => r.unitLabel === '1A')).toBe(true);
    await api(ctx, emma).get(`/api/requests/${ctx.ids.r2bSink}`).expect(404);
    await api(ctx, emma).get(`/api/work-orders/${ctx.ids.wo2bSink}`).expect(404);
  });
});

// ───────────────────────────── triage agent ─────────────────────────────

describe('triage agent (local rules engine)', () => {
  it('turns a tenant request into an assigned work order, with a full audit trail', async () => {
    const { id, runId, token } = await submit('olivia', 'Toilet clogged', 'My toilet is clogged and overflowing onto the bathroom floor.', [PNG]);
    expect((await ctx.db.one('SELECT status FROM agent_run WHERE id = $1', [runId])).status).toBe('QUEUED');
    await drainAgent(ctx);

    const run = await ctx.db.one('SELECT * FROM agent_run WHERE id = $1', [runId]);
    expect(run.status).toBe('SUCCEEDED');
    const req = await ctx.db.one('SELECT * FROM maintenance_request WHERE id = $1', [id]);
    expect(req).toMatchObject({ status: 'CONVERTED', category: 'PLUMBING', urgency: 'HIGH', asset_id: ctx.ids.toilet2A });
    const wo = await workOrderFor(id);
    expect(wo.status).toBe('ASSIGNED');
    expect([ctx.ids.luis, ctx.ids.sam]).toContain(wo.assigned_technician_id);
    expect(wo.created_by_agent_run_id).toBe(runId);

    const steps = await ctx.db.many('SELECT step_type, tool_name FROM agent_step WHERE run_id = $1 ORDER BY seq', [runId]);
    const tools = steps.filter((s) => s.step_type === 'TOOL_CALL').map((s) => s.tool_name);
    expect(tools).toEqual(['get_request', 'search_assets', 'find_similar_requests', 'set_triage', 'create_work_order', 'list_technicians', 'assign_technician']);
    expect(steps.filter((s) => s.step_type === 'TOOL_RESULT')).toHaveLength(tools.length);

    // Tenant sees progress, technician got a notification, manager can read the trace
    const mine = await api(ctx, token).get(`/api/requests/${id}`).expect(200);
    expect(mine.body.workOrderStatus).toBe('ASSIGNED');
    expect(mine.body.agentRuns[0].summary).toBeUndefined();
    const techNotes = await ctx.db.many('SELECT kind FROM notification WHERE recipient_id = $1', [wo.assigned_technician_id]);
    expect(techNotes.map((n) => n.kind)).toContain('ASSIGNMENT');
    const trace = await api(ctx, manager).get(`/api/agent/runs/${runId}`).expect(200);
    expect(trace.body.steps.find((s: any) => s.toolName === 'assign_technician').access).toBe('WRITE');
  });

  it('flags emergencies to the manager', async () => {
    const { id } = await submit('emma', 'Gas smell in kitchen', 'There is a strong gas smell near the stove.');
    await drainAgent(ctx);
    const req = await ctx.db.one('SELECT urgency FROM maintenance_request WHERE id = $1', [id]);
    expect(req.urgency).toBe('EMERGENCY');
    const wo = await workOrderFor(id);
    expect(new Date(wo.due_at).getTime() - Date.now()).toBeLessThan(4.1 * 3600_000);
    const n = await ctx.db.many(`SELECT title FROM notification WHERE recipient_id = $1 AND kind = 'EMERGENCY'`, [ctx.ids.manager]);
    expect(n).toHaveLength(1);
  });

  it('marks a repeat report of an open problem as a duplicate', async () => {
    const { id } = await submit('liam', 'Kitchen sink still leaking', 'The pipe under my kitchen sink is still dripping into the cabinet.');
    await drainAgent(ctx);
    const req = await ctx.db.one('SELECT status, duplicate_of_id FROM maintenance_request WHERE id = $1', [id]);
    expect(req).toEqual({ status: 'DUPLICATE', duplicate_of_id: ctx.ids.r2bSink });
    expect(await workOrderFor(id)).toBeNull();
    const ev = await ctx.db.many(`SELECT event_type FROM work_order_event WHERE work_order_id = $1`, [ctx.ids.wo2bSink]);
    expect(ev.map((e) => e.event_type)).toContain('DUPLICATE_LINKED');
  });

  it('asks the manager to step in when no technician is qualified', async () => {
    // Ethan's seeded "Mice in the kitchen" request (Harbor Lofts: no pest-control technician covers it)
    const id = ctx.ids.rEthanMice;
    await ctx.db.exec(`INSERT INTO agent_run(run_type, trigger_ref) VALUES ('TRIAGE', $1)`, [id]);
    await drainAgent(ctx);
    const req = await ctx.db.one('SELECT category FROM maintenance_request WHERE id = $1', [id]);
    expect(req.category).toBe('PEST');
    const wo = await workOrderFor(id);
    expect(wo.status).toBe('OPEN');
    const n = await ctx.db.many(`SELECT title FROM notification WHERE recipient_id = $1 AND title LIKE '%no technician%'`, [ctx.ids.manager]);
    expect(n).toHaveLength(1);
  });

  it('in Claude mode, sends the tenant photos to the model as image blocks', async () => {
    ctx.llm.mode = 'claude';
    ctx.llm.script = [() => reply([], 'Looked at it.')];
    await submit('emma', 'Dripping faucet', 'The kitchen faucet drips all night.', [PNG, PNG]);
    await drainAgent(ctx);
    const first = ctx.llm.requests[0].messages[0].content as any[];
    expect(first.filter((b) => b.type === 'image')).toHaveLength(2);
    expect(first[2].source).toMatchObject({ type: 'base64', media_type: 'image/png', data: PNG.toString('base64') });
    expect(ctx.llm.requests[0].system).toMatch(/triage ONE new maintenance request/);
  });

  it('rejects files that are not real images and keeps nothing', async () => {
    const emma = await login(ctx, 'emma');
    const count = async () => (await ctx.db.one('SELECT count(*)::int AS n FROM maintenance_request WHERE submitted_by = $1', [ctx.ids.emma])).n;
    const before = await count();
    require('fs').mkdirSync(process.env.UPLOAD_DIR!, { recursive: true });
    const uploadsBefore = require('fs').readdirSync(process.env.UPLOAD_DIR!).filter((f: string) => f.endsWith('.png')).length;
    await api(ctx, emma).post('/api/requests').field('title', 'Broken thing').field('description', 'Something is broken here.')
      .attach('photos', Buffer.from('not an image at all'), { filename: 'x.png', contentType: 'image/png' }).expect(400);
    expect(await count()).toBe(before);
    expect(require('fs').readdirSync(process.env.UPLOAD_DIR!).filter((f: string) => f.endsWith('.png')).length).toBe(uploadsBefore);
  });

  it('serves photos only to people who can see the request', async () => {
    const { id, token } = await submit('emma', 'Dripping faucet', 'The kitchen faucet drips all night.', [PNG]);
    const detail = await api(ctx, token).get(`/api/requests/${id}`).expect(200);
    const photoId = detail.body.photos[0].id;
    const img = await api(ctx, token).get(`/api/attachments/${photoId}`).expect(200);
    await api(ctx).get(`/api/attachments/${photoId}?token=${token}`).expect(401);
    expect(img.headers['content-type']).toBe('image/png');
    const noah = await login(ctx, 'noah');
    await api(ctx, noah).get(`/api/attachments/${photoId}`).expect(404);
  });
});

// ───────────────────────────── nightly + approvals ─────────────────────────────

describe('nightly digest and approvals', () => {
  async function runNightly() {
    await api(ctx, manager).post('/api/agent/nightly').expect(201);
    await drainAgent(ctx);
  }

  it('schedules preventive work, proposes actions and publishes a digest, idempotently', async () => {
    await runNightly();
    const pm = await ctx.db.many(`SELECT title, status FROM work_order WHERE pm_schedule_id IS NOT NULL ORDER BY title`);
    expect(pm.map((w) => w.title)).toEqual(['Annual boiler inspection (Boiler)', 'Flush water heater (Water heater)', 'Replace rooftop HVAC filters (Rooftop HVAC unit)']);
    expect(pm.every((w) => w.status === 'ASSIGNED')).toBe(true);
    const approvals = await ctx.db.many(`SELECT action_type, target_id FROM approval ORDER BY action_type`);
    expect(approvals.map((a) => a.action_type)).toEqual(['CLOSE_WORK_ORDER', 'SEND_VENDOR_EMAIL']);
    expect(approvals[0].target_id).toBe(ctx.ids.wo2bSink);
    // Gated tools never act on their own
    expect((await ctx.db.one('SELECT status FROM work_order WHERE id = $1', [ctx.ids.wo2bSink])).status).toBe('IN_PROGRESS');
    expect((await ctx.db.one('SELECT count(*)::int AS n FROM outbox_email')).n).toBe(0);
    const digests = await api(ctx, manager).get('/api/digests').expect(200);
    expect(digests.body).toHaveLength(2);
    const linden = digests.body.find((d: any) => d.propertyName === 'Linden Court');
    expect(linden.items.map((i: any) => i.type)).toEqual(expect.arrayContaining(['OVERDUE', 'REPEAT_FAILURE', 'PM_CREATED', 'APPROVAL_PENDING']));
    expect(linden.items[0].severity).toBe('CRITICAL');

    await runNightly();
    expect((await ctx.db.one('SELECT count(*)::int AS n FROM work_order WHERE pm_schedule_id IS NOT NULL')).n).toBe(3);
    expect((await ctx.db.one(`SELECT count(*)::int AS n FROM approval WHERE status = 'PENDING'`)).n).toBe(2);
    expect((await api(ctx, manager).get('/api/digests').expect(200)).body).toHaveLength(2);
  });

  it('executes an approved proposal exactly once', async () => {
    await runNightly();
    const list = (await api(ctx, manager).get('/api/approvals').expect(200)).body;
    const close = list.find((a: any) => a.actionType === 'CLOSE_WORK_ORDER');
    const mail = list.find((a: any) => a.actionType === 'SEND_VENDOR_EMAIL');
    await api(ctx, manager).post(`/api/approvals/${close.id}/approve`).send({ note: 'ok' }).expect(200);
    await api(ctx, manager).post(`/api/approvals/${close.id}/approve`).send({}).expect(409);
    const wo = await ctx.db.one('SELECT status, resolution_notes FROM work_order WHERE id = $1', [ctx.ids.wo2bSink]);
    expect(wo.status).toBe('COMPLETED');
    expect(wo.resolution_notes).toMatch(/P-trap/);

    await api(ctx, manager).post(`/api/approvals/${mail.id}/approve`).send({ subject: 'Edited subject' }).expect(200);
    const email = await ctx.db.one('SELECT to_address, subject FROM outbox_email');
    expect(email).toEqual({ to_address: 'quotes@aquapro.example', subject: 'Edited subject' });
  });

  it('rejects, and fails safely when the work order changed after the proposal', async () => {
    await runNightly();
    const list = (await api(ctx, manager).get('/api/approvals').expect(200)).body;
    const close = list.find((a: any) => a.actionType === 'CLOSE_WORK_ORDER');
    const mail = list.find((a: any) => a.actionType === 'SEND_VENDOR_EMAIL');
    await api(ctx, manager).post(`/api/approvals/${mail.id}/reject`).send({ note: 'Not yet' }).expect(200);
    expect((await ctx.db.one('SELECT count(*)::int AS n FROM outbox_email')).n).toBe(0);

    await api(ctx, manager).post(`/api/work-orders/${ctx.ids.wo2bSink}/status`).send({ status: 'CANCELLED' }).expect(200);
    const res = await api(ctx, manager).post(`/api/approvals/${close.id}/approve`).send({}).expect(409);
    expect(res.body.message).toMatch(/could not be executed/);
    expect((await ctx.db.one('SELECT status FROM approval WHERE id = $1', [close.id])).status).toBe('FAILED');
  });

  it('other managers cannot see or decide approvals', async () => {
    await runNightly();
    const tenant = await login(ctx, 'emma');
    const a = await ctx.db.one('SELECT id FROM approval LIMIT 1');
    await api(ctx, tenant).post(`/api/approvals/${a.id}/approve`).send({}).expect(403);
  });
});

// ───────────────────────────── guardrails ─────────────────────────────

describe('agent guardrails (enforced in code, not the prompt)', () => {
  async function scriptedRun(runType: 'TRIAGE' | 'NIGHTLY_DIGEST', triggerRef: string, calls: { name: string; input: Record<string, unknown> }[]) {
    ctx.llm.script = [() => reply(calls), () => reply([], 'Done.')];
    const run = await ctx.db.one(`INSERT INTO agent_run(run_type, trigger_ref) VALUES ($1, $2) RETURNING id`, [runType, triggerRef]);
    await drainAgent(ctx);
    const results = await ctx.db.many(`SELECT tool_name, tool_output FROM agent_step WHERE run_id = $1 AND step_type = 'TOOL_RESULT' ORDER BY seq`, [run.id]);
    return results.map((r) => r.tool_output);
  }

  it('GATED tools create an approval and never execute', async () => {
    const [out] = await scriptedRun('NIGHTLY_DIGEST', ctx.ids.linden, [
      { name: 'propose_cancel_work_order', input: { work_order_id: ctx.ids.wo3aDoor, rationale: 'test' } },
    ]);
    expect(out.status).toBe('PENDING_APPROVAL');
    expect((await ctx.db.one('SELECT status FROM work_order WHERE id = $1', [ctx.ids.wo3aDoor])).status).toBe('OPEN');
  });

  it('cannot touch another property', async () => {
    const [out] = await scriptedRun('NIGHTLY_DIGEST', ctx.ids.harbor, [
      { name: 'assign_technician', input: { work_order_id: ctx.ids.wo3aDoor, technician_id: ctx.ids.sam, rationale: 'test' } },
    ]);
    expect(out.error).toMatch(/not found in this property/);
    expect((await ctx.db.one('SELECT status FROM work_order WHERE id = $1', [ctx.ids.wo3aDoor])).status).toBe('OPEN');
  });

  it('only offers each run type its own tools, and only touches its own request', async () => {
    const { id } = await submit('emma', 'Dripping faucet', 'The kitchen faucet drips all night.');
    await ctx.db.exec(`DELETE FROM agent_run`);
    const outs = await scriptedRun('TRIAGE', id, [
      { name: 'publish_digest', input: { property_id: ctx.ids.linden, summary: 'x', items: [] } },
      { name: 'set_triage', input: { request_id: ctx.ids.r3aDoor, category: 'GENERAL', urgency: 'LOW', rationale: 'x' } },
      { name: 'set_triage', input: { request_id: id, category: 'NOT_A_CATEGORY', urgency: 'LOW', rationale: 'x' } },
      { name: 'delete_everything', input: {} },
    ]);
    expect(outs[0].error).toMatch(/not available in a TRIAGE run/);
    expect(outs[1].error).toMatch(/only change the request it was started for/);
    expect(outs[2].error).toMatch(/category must be one of/);
    expect(outs[3].error).toMatch(/Unknown tool/);
    const offered = ctx.llm.requests.at(-1)!.tools.map((t) => t.name);
    expect(offered).not.toContain('publish_digest');
    expect(offered).toHaveLength(10);
    // The agent stopped without triaging: request goes back to the manual queue
    expect((await ctx.db.one('SELECT status FROM maintenance_request WHERE id = $1', [id])).status).toBe('NEW');
  });

  it('enforces business rules on agent writes (skills and capacity)', async () => {
    const [out] = await scriptedRun('NIGHTLY_DIGEST', ctx.ids.linden, [
      { name: 'assign_technician', input: { work_order_id: ctx.ids.wo3aDoor, technician_id: ctx.ids.priya, rationale: 'test' } },
    ]);
    expect(out.error).toMatch(/not qualified for STRUCTURAL/);
  });
});

// ───────────────────────────── worker resilience ─────────────────────────────

describe('worker queue', () => {
  it('retries transient failures, then gives the request back to a human', async () => {
    const boom = () => { throw new Error('upstream 529 overloaded'); };
    ctx.llm.script = [boom, boom, boom];
    const { id, runId } = await submit('emma', 'Dripping faucet', 'The kitchen faucet drips all night.');
    for (let i = 1; i <= 3; i++) {
      await ctx.db.exec(`UPDATE agent_run SET run_after = now() WHERE id = $1`, [runId]);
      expect(await ctx.worker.processNext()).toBe(true);
      const r = await ctx.db.one('SELECT status, attempts FROM agent_run WHERE id = $1', [runId]);
      expect(r).toEqual({ status: i < 3 ? 'QUEUED' : 'FAILED', attempts: i });
    }
    expect((await ctx.db.one('SELECT status FROM maintenance_request WHERE id = $1', [id])).status).toBe('NEW');
    const n = await ctx.db.many(`SELECT title FROM notification WHERE recipient_id = $1 AND title LIKE 'AI triage failed%'`, [ctx.ids.manager]);
    expect(n).toHaveLength(1);
  });

  it('does not retry non-retryable errors', async () => {
    ctx.llm.script = [() => { throw new NonRetryableError('Claude API 401: invalid key'); }];
    const { runId } = await submit('emma', 'Dripping faucet', 'The kitchen faucet drips all night.');
    await ctx.worker.processNext();
    expect((await ctx.db.one('SELECT status, attempts FROM agent_run WHERE id = $1', [runId]))).toEqual({ status: 'FAILED', attempts: 1 });
  });

  it('takes over a job whose worker died, and never hands the same job to two workers', async () => {
    const run = await ctx.db.one(`INSERT INTO agent_run(run_type, trigger_ref, status, attempts, locked_until) VALUES ('NIGHTLY_DIGEST', $1, 'RUNNING', 1, now() - interval '1 minute') RETURNING id`, [ctx.ids.linden]);
    const claimed = await ctx.worker.claim();
    expect(claimed?.id).toBe(run.id);
    expect(claimed?.attempts).toBe(2);
    await ctx.db.exec('DELETE FROM agent_run');
    for (let i = 0; i < 6; i++) await ctx.db.exec(`INSERT INTO agent_run(run_type, trigger_ref) VALUES ('NIGHTLY_DIGEST', $1)`, [ctx.ids.linden]);
    const claims = await Promise.all(Array.from({ length: 8 }, () => ctx.worker.claim()));
    const got = claims.filter(Boolean).map((c) => c!.id);
    expect(got).toHaveLength(6);
    expect(new Set(got).size).toBe(6);
  });

  it('queues only one active triage per request', async () => {
    const { id, runId } = await submit('emma', 'Dripping faucet', 'The kitchen faucet drips all night.');
    const res = await api(ctx, manager).post(`/api/requests/${id}/retriage`).expect(201);
    expect(res.body).toEqual({ id: runId, existing: true });
  });
});

// ───────────────────────────── technician workflow ─────────────────────────────

describe('technician workflow', () => {
  it('follows the state machine and requires resolution notes', async () => {
    const luis = await login(ctx, 'luis');
    const wo = ctx.ids.wo2bSink;
    await api(ctx, luis).post(`/api/work-orders/${wo}/status`).send({ status: 'COMPLETED' }).expect(422);
    await api(ctx, luis).post(`/api/work-orders/${wo}/status`).send({ status: 'CANCELLED' }).expect(409);
    await api(ctx, luis).post(`/api/work-orders/${wo}/status`).send({ status: 'COMPLETED', resolutionNotes: 'Fixed trap.' }).expect(200);
    const n = await ctx.db.many(`SELECT title FROM notification WHERE recipient_id = $1`, [ctx.ids.liam]);
    expect(n.map((x) => x.title)).toContain('Repair update: Plumbing: kitchen sink leaking underneath');
    await api(ctx, luis).get(`/api/work-orders/${ctx.ids.wo1bFridge}`).expect(404);
    const mine = await api(ctx, luis).get('/api/work-orders').expect(200);
    expect(mine.body.every((w: any) => w.technicianId === ctx.ids.luis)).toBe(true);
  });

  it('manager assignments still check skills', async () => {
    const res = await api(ctx, manager).post(`/api/work-orders/${ctx.ids.wo3aDoor}/assign`).send({ technicianId: ctx.ids.priya }).expect(422);
    expect(res.body.message).toMatch(/not qualified/);
    await api(ctx, manager).post(`/api/work-orders/${ctx.ids.wo3aDoor}/assign`).send({ technicianId: ctx.ids.sam }).expect(200);
  });

  it('dashboard reflects the data', async () => {
    const res = await api(ctx, manager).get('/api/dashboard').expect(200);
    expect(res.body.stats).toMatchObject({ overdue: 2, unassigned: 1, requestsWaiting: 2 });
  });
});
