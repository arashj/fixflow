import * as bcrypt from 'bcryptjs';
import { Pool, PoolClient } from 'pg';
import { todayInAppTz } from '../common/time';

export const DEMO_PASSWORD = 'demo1234';
const D = '@demo.fixflow.dev';

const DAY = 86400_000;
const ago = (days: number, hours = 0) => new Date(Date.now() - days * DAY - hours * 3600_000);
const ahead = (days: number, hours = 0) => new Date(Date.now() + days * DAY + hours * 3600_000);
function dateOffset(days: number): string {
  const [y, m, d] = todayInAppTz().split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** Wipes app data and loads the demo dataset. Optionally queues triage runs for two fresh requests. */
export async function seed(pool: Pool, opts: { queueAgentRuns?: boolean } = {}): Promise<Record<string, string>> {
  const c = await pool.connect();
  const ids: Record<string, string> = {};
  const ins = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0]?.id as string;
  try {
    await c.query('BEGIN');
    await c.query(`TRUNCATE outbox_email, digest, notification, approval, work_order_event, work_order, pm_schedule, agent_step, agent_run,
      request_attachment, maintenance_request, technician_unavailability, technician_property, technician_skill, technician,
      asset, unit, property, app_user RESTART IDENTITY CASCADE`);
    const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const user = async (key: string, name: string, email: string, role: string) => {
      ids[key] = await ins('INSERT INTO app_user(email, password_hash, full_name, role) VALUES ($1,$2,$3,$4) RETURNING id', [email + D, hash, name, role]);
    };

    // People
    await user('manager', 'Maya Chen', 'manager', 'MANAGER');
    await user('luis', 'Luis Ortega', 'luis', 'TECHNICIAN');
    await user('priya', 'Priya Shah', 'priya', 'TECHNICIAN');
    await user('sam', 'Sam Okafor', 'sam', 'TECHNICIAN');
    const tenants: [string, string, string][] = [
      ['emma', 'Emma Wilson', 'emma'], ['noah', 'Noah Tremblay', 'noah'], ['olivia', 'Olivia Martin', 'olivia'],
      ['liam', 'Liam Gagnon', 'liam'], ['ava', 'Ava Roy', 'ava'], ['chloe', 'Chloe Nguyen', 'chloe'], ['ethan', 'Ethan Brown', 'ethan'],
    ];
    for (const [k, n, e] of tenants) await user(k, n, e, 'TENANT');

    // Properties and units
    ids.linden = await ins('INSERT INTO property(name, address, manager_id) VALUES ($1,$2,$3) RETURNING id', ['Linden Court', '48 Linden Avenue', ids.manager]);
    ids.harbor = await ins('INSERT INTO property(name, address, manager_id) VALUES ($1,$2,$3) RETURNING id', ['Harbor Lofts', '210 Harbor Street', ids.manager]);
    const unit = async (key: string, prop: string, label: string, tenant: string | null) => {
      ids[key] = await ins('INSERT INTO unit(property_id, label, tenant_id) VALUES ($1,$2,$3) RETURNING id', [ids[prop], label, tenant ? ids[tenant] : null]);
    };
    await unit('u1A', 'linden', '1A', 'emma');
    await unit('u1B', 'linden', '1B', 'noah');
    await unit('u2A', 'linden', '2A', 'olivia');
    await unit('u2B', 'linden', '2B', 'liam');
    await unit('u3A', 'linden', '3A', 'ava');
    await unit('u3B', 'linden', '3B', null);
    await unit('u101', 'harbor', '101', 'chloe');
    await unit('u102', 'harbor', '102', 'ethan');
    await unit('u201', 'harbor', '201', null);

    // Technicians
    const tech = async (key: string, phone: string, cap: number, skills: string[], props: string[]) => {
      await c.query('INSERT INTO technician(user_id, phone, max_open_work_orders) VALUES ($1,$2,$3)', [ids[key], phone, cap]);
      for (const s of skills) await c.query('INSERT INTO technician_skill(technician_id, category) VALUES ($1,$2)', [ids[key], s]);
      for (const p of props) await c.query('INSERT INTO technician_property(technician_id, property_id) VALUES ($1,$2)', [ids[key], ids[p]]);
    };
    await tech('luis', '514-555-0141', 5, ['PLUMBING', 'GENERAL'], ['linden', 'harbor']);
    await tech('priya', '514-555-0177', 5, ['ELECTRICAL', 'HVAC', 'APPLIANCE'], ['linden', 'harbor']);
    await tech('sam', '514-555-0190', 4, ['GENERAL', 'STRUCTURAL', 'PEST', 'APPLIANCE', 'PLUMBING'], ['linden']);
    await c.query('INSERT INTO technician_unavailability(technician_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4)',
      [ids.sam, ahead(4), ahead(9), 'Vacation']);

    // Assets
    const asset = async (key: string, prop: string, unitKey: string | null, category: string, name: string, make?: string, model?: string,
      installedYearsAgo?: number, vendor?: [string, string]) => {
      ids[key] = await ins(
        `INSERT INTO asset(property_id, unit_id, category, name, make, model, installed_on, vendor_name, vendor_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [ids[prop], unitKey ? ids[unitKey] : null, category, name, make ?? null, model ?? null,
          installedYearsAgo !== undefined ? ago(installedYearsAgo * 365).toISOString().slice(0, 10) : null, vendor?.[0] ?? null, vendor?.[1] ?? null]);
    };
    for (const u of ['1A', '1B', '2A', '2B', '3A', '3B']) {
      await asset(`sink${u}`, 'linden', `u${u}`, 'PLUMBING', 'Kitchen sink', 'Moen', 'Adler 87233', 9);
      await asset(`toilet${u}`, 'linden', `u${u}`, 'PLUMBING', 'Bathroom toilet', 'American Standard', 'Cadet 3', 9);
      await asset(`bathSink${u}`, 'linden', `u${u}`, 'PLUMBING', 'Bathroom sink', 'Kohler', 'Archer K-2355', 9);
      await asset(`fridge${u}`, 'linden', `u${u}`, 'APPLIANCE', 'Refrigerator', 'Frigidaire', 'FFTR1835VW', u === '1B' ? 12 : 4);
      await asset(`stove${u}`, 'linden', `u${u}`, 'APPLIANCE', 'Stove', 'GE', 'JB258', 6);
    }
    await asset('boiler', 'linden', null, 'HVAC', 'Boiler', 'Viessmann', 'Vitodens 200', 11, ['Nordic Heating Services', 'service@nordicheating.example']);
    await asset('waterHeater', 'linden', null, 'PLUMBING', 'Water heater', 'Bradford White', 'RG250T6N', 13, ['AquaPro Plumbing Supply', 'quotes@aquapro.example']);
    await asset('panel', 'linden', null, 'ELECTRICAL', 'Electrical panel', 'Square D', 'QO 200A', 15);
    await asset('smoke', 'linden', null, 'ELECTRICAL', 'Hallway smoke detectors', 'Kidde', 'i12060', 3);
    await asset('frontDoor', 'linden', null, 'STRUCTURAL', 'Front entrance door', undefined, undefined, 10);
    for (const u of ['101', '102', '201']) {
      await asset(`sink${u}`, 'harbor', `u${u}`, 'PLUMBING', 'Kitchen sink', 'Kohler', 'K-5840', 3);
      await asset(`fridge${u}`, 'harbor', `u${u}`, 'APPLIANCE', 'Refrigerator', 'Samsung', 'RF28T5001SR', 3);
      await asset(`toilet${u}`, 'harbor', `u${u}`, 'PLUMBING', 'Bathroom toilet', 'TOTO', 'Drake II', 3);
    }
    await asset('rooftopHvac', 'harbor', null, 'HVAC', 'Rooftop HVAC unit', 'Carrier', '48FC', 3, ['Harbor Mechanical', 'dispatch@harbormech.example']);

    // Preventive maintenance
    const pm = async (assetKey: string, title: string, description: string, interval: number, dueInDays: number) => {
      await c.query('INSERT INTO pm_schedule(asset_id, title, description, interval_days, next_due_on) VALUES ($1,$2,$3,$4,$5)',
        [ids[assetKey], title, description, interval, dateOffset(dueInDays)]);
    };
    await pm('waterHeater', 'Flush water heater', 'Drain and flush sediment, check anode rod and T&P valve.', 90, 0);
    await pm('boiler', 'Annual boiler inspection', 'Combustion analysis, check pressure relief valve, clean burner.', 365, 3);
    await pm('smoke', 'Test smoke detectors', 'Test every hallway detector, replace batteries older than 12 months.', 180, 20);
    await pm('rooftopHvac', 'Replace rooftop HVAC filters', 'Replace MERV-13 filters and check belt tension.', 30, 2);

    // Work order history
    const event = async (wo: string, actorType: string, actor: string | null, type: string, payload: object, at: Date) => {
      await c.query(`INSERT INTO work_order_event(work_order_id, actor_type, actor_user_id, event_type, payload, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [wo, actorType, actor, type, JSON.stringify(payload), at]);
    };
    const request = async (key: string, prop: string, unitKey: string | null, by: string, title: string, description: string,
      status: string, at: Date, triage?: { category: string; urgency: string; asset?: string; rationale: string }) => {
      ids[key] = await ins(
        `INSERT INTO maintenance_request(property_id, unit_id, submitted_by, title, description, status, category, urgency, asset_id, triage_rationale, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id`,
        [ids[prop], unitKey ? ids[unitKey] : null, ids[by], title, description, status, triage?.category ?? null, triage?.urgency ?? null,
          triage?.asset ? ids[triage.asset] : null, triage?.rationale ?? null, at]);
    };
    const wo = async (key: string, w: { prop: string; unit?: string; asset?: string; request?: string; title: string; description: string; category: string;
      priority: string; status: string; tech?: string; created: Date; due: Date; completed?: Date; notes?: string }) => {
      ids[key] = await ins(
        `INSERT INTO work_order(request_id, property_id, unit_id, asset_id, title, description, category, priority, status, assigned_technician_id,
                                due_at, created_by_user_id, resolution_notes, completed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING id`,
        [w.request ? ids[w.request] : null, ids[w.prop], w.unit ? ids[w.unit] : null, w.asset ? ids[w.asset] : null, w.title, w.description, w.category,
          w.priority, w.status, w.tech ? ids[w.tech] : null, w.due, ids.manager, w.notes ?? null, w.completed ?? null, w.created]);
      await event(ids[key], 'USER', ids.manager, 'CREATED', { priority: w.priority, dueAt: w.due.toISOString() }, w.created);
      if (w.tech) {
        const techName = { luis: 'Luis Ortega', priya: 'Priya Shah', sam: 'Sam Okafor' }[w.tech];
        await event(ids[key], 'USER', ids.manager, 'ASSIGNED', { technicianId: ids[w.tech], technicianName: techName }, new Date(w.created.getTime() + 600_000));
      }
      if (['IN_PROGRESS', 'COMPLETED'].includes(w.status) && w.tech) {
        await event(ids[key], 'USER', ids[w.tech], 'STATUS_CHANGED', { from: 'ASSIGNED', to: 'IN_PROGRESS' }, new Date(w.created.getTime() + 3 * 3600_000));
      }
      if (w.status === 'COMPLETED' && w.tech) {
        await event(ids[key], 'USER', ids[w.tech], 'STATUS_CHANGED', { from: 'IN_PROGRESS', to: 'COMPLETED', resolutionNotes: w.notes }, w.completed!);
      }
    };

    // Water heater: three repairs in ~70 days → repeat failure, vendor on file
    await wo('wh1', { prop: 'linden', asset: 'waterHeater', title: 'No hot water in the building', description: 'Several tenants report no hot water.',
      category: 'PLUMBING', priority: 'HIGH', status: 'COMPLETED', tech: 'luis', created: ago(68), due: ago(67), completed: ago(67, 20), notes: 'Thermocouple replaced, relit pilot.' });
    await wo('wh2', { prop: 'linden', asset: 'waterHeater', title: 'Water heater pilot keeps going out', description: 'Pilot light out again; lukewarm water.',
      category: 'PLUMBING', priority: 'HIGH', status: 'COMPLETED', tech: 'luis', created: ago(31), due: ago(30), completed: ago(30, 18), notes: 'Cleaned pilot assembly, adjusted gas valve.' });
    await wo('wh3', { prop: 'linden', asset: 'waterHeater', title: 'Water heater leaking at the base', description: 'Small puddle under the water heater in the basement.',
      category: 'PLUMBING', priority: 'HIGH', status: 'COMPLETED', tech: 'luis', created: ago(9), due: ago(8), completed: ago(8, 16), notes: 'Tightened drain valve, tank shows corrosion. Recommend replacement soon.' });

    // 2B sink: technician fixed it and left notes, but never closed the job (now overdue) → agent proposes closing
    await request('r2bSink', 'linden', 'u2B', 'liam', 'Kitchen sink leaking underneath', 'Water is dripping from the pipe under my kitchen sink into the cabinet. I put a bowl under it.',
      'CONVERTED', ago(3), { category: 'PLUMBING', urgency: 'HIGH', asset: 'sink2B', rationale: 'Active leak under the sink, contained with a bowl.' });
    await wo('wo2bSink', { prop: 'linden', unit: 'u2B', asset: 'sink2B', request: 'r2bSink', title: 'Plumbing: kitchen sink leaking underneath',
      description: 'Unit 2B, kitchen sink (Moen Adler). Leak at the trap, tenant has a bowl under it.', category: 'PLUMBING', priority: 'HIGH',
      status: 'IN_PROGRESS', tech: 'luis', created: ago(3), due: ago(2), notes: 'Replaced the P-trap washer and tightened slip nuts. No leak after 20 min test.' });

    // 1B fridge: assigned, overdue, no progress
    await request('r1bFridge', 'linden', 'u1B', 'noah', 'Fridge not cooling', 'My fridge stopped cooling since yesterday, freezer is OK but the fridge side is warm.',
      'CONVERTED', ago(5), { category: 'APPLIANCE', urgency: 'HIGH', asset: 'fridge1B', rationale: 'Refrigerator not cooling; food safety risk.' });
    await wo('wo1bFridge', { prop: 'linden', unit: 'u1B', asset: 'fridge1B', request: 'r1bFridge', title: 'Appliance: fridge not cooling',
      description: 'Unit 1B, Frigidaire fridge, 12 years old. Fridge warm, freezer OK; likely damper or defrost issue.', category: 'APPLIANCE', priority: 'HIGH',
      status: 'ASSIGNED', tech: 'priya', created: ago(5), due: ago(4) });

    // 3A: low priority, open and unassigned, not yet due
    await request('r3aDoor', 'linden', 'u3A', 'ava', 'Closet door squeaks', 'The bedroom closet door squeaks loudly when opened. Not urgent.',
      'CONVERTED', ago(1), { category: 'STRUCTURAL', urgency: 'LOW', rationale: 'Cosmetic, not urgent.' });
    await wo('wo3aDoor', { prop: 'linden', unit: 'u3A', request: 'r3aDoor', title: 'Building repair: closet door squeaks',
      description: 'Unit 3A bedroom closet door hinge squeak. Lubricate or replace hinge pins.', category: 'STRUCTURAL', priority: 'LOW',
      status: 'OPEN', created: ago(1), due: ahead(6) });

    // Completed history for context
    await wo('hallLights', { prop: 'linden', title: 'Replace hallway light fixtures, 2nd floor', description: 'Two hallway fixtures flickering.',
      category: 'ELECTRICAL', priority: 'NORMAL', status: 'COMPLETED', tech: 'priya', created: ago(20), due: ago(17), completed: ago(18), notes: 'Replaced two LED drivers.' });
    await wo('harborDoor', { prop: 'harbor', unit: 'u101', asset: 'sink101', title: 'Kitchen faucet loose', description: 'Faucet base loose.',
      category: 'PLUMBING', priority: 'NORMAL', status: 'COMPLETED', tech: 'luis', created: ago(12), due: ago(9), completed: ago(10), notes: 'Tightened mounting nut.' });

    // Two fresh tenant requests; the agent triages them as soon as the worker starts
    await request('rEmmaLeak', 'linden', 'u1A', 'emma', 'Water pouring from under the kitchen sink',
      'Water is pouring out from under my kitchen sink and spreading across the floor. I turned off the valve but it is still leaking a lot.', 'NEW', ago(0, 0.2));
    await request('rEthanMice', 'harbor', 'u102', 'ethan', 'Mice in the kitchen', 'I have seen mice twice this week near the stove and found droppings in the cabinet.', 'NEW', ago(0, 0.1));
    if (opts.queueAgentRuns !== false) {
      await c.query(`INSERT INTO agent_run(run_type, trigger_ref) VALUES ('TRIAGE', $1), ('TRIAGE', $2)`, [ids.rEmmaLeak, ids.rEthanMice]);
    }

    await c.query('COMMIT');
    return ids;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    (c as PoolClient).release();
  }
}
