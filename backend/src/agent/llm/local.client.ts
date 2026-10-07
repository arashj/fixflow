import { randomUUID } from 'crypto';
import { Category, Urgency } from '../../common/types';
import { classifyCategory, classifyUrgency, matchAsset, similarity, withArticle } from './classifier';

const n = (count: number, word: string, plural = `${word}s`) => `${count} ${count === 1 ? word : plural}`;
import { ContentBlock, LlmClient, LlmMessage, LlmRequest, LlmResponse, ToolUseBlock } from './llm.types';

interface Call {
  id: string;
  name: string;
  input: any;
  result: any;
  isError: boolean;
}

const CATEGORY_LABEL: Record<Category, string> = {
  PLUMBING: 'Plumbing', ELECTRICAL: 'Electrical', HVAC: 'Heating/cooling', APPLIANCE: 'Appliance', STRUCTURAL: 'Building repair', PEST: 'Pest control', GENERAL: 'General repair',
};

/**
 * Local rules engine. Used when ANTHROPIC_API_KEY is not set so the app is fully usable offline.
 * It reads the same conversation the real model would see and replies with the same tool calls,
 * so it exercises the identical agent loop, tool executor, access checks and audit log.
 * It does not look at photos.
 */
export class LocalRulesLlmClient implements LlmClient {
  readonly mode = 'local' as const;
  readonly model = 'local-rules-v1';

  async createMessage(req: LlmRequest): Promise<LlmResponse> {
    const ctx = parseContext(req.messages);
    const calls = history(req.messages);
    const next = ctx.run_type === 'TRIAGE' ? this.triage(ctx, calls) : this.nightly(ctx, calls);
    const content: ContentBlock[] = [];
    if (next.text) content.push({ type: 'text', text: next.text });
    for (const t of next.tools ?? []) content.push({ type: 'tool_use', id: `toolu_local_${randomUUID().slice(0, 12)}`, name: t.name, input: t.input } as ToolUseBlock);
    const inTokens = JSON.stringify(req.messages).length / 4;
    return {
      content,
      stopReason: next.tools?.length ? 'tool_use' : 'end_turn',
      usage: { inputTokens: Math.round(inTokens), outputTokens: Math.round(JSON.stringify(content).length / 4) },
      model: this.model,
    };
  }

  // ───────────────────────────── triage ─────────────────────────────

  private triage(ctx: any, calls: Call[]): Step {
    const last = (name: string) => [...calls].reverse().find((c) => c.name === name);
    const req = last('get_request');
    if (!req) return { text: 'Reading the request.', tools: [{ name: 'get_request', input: { request_id: ctx.request_id } }] };
    if (req.isError) return { text: `Stopping: could not load the request (${req.result?.error}).` };
    const r = req.result;
    const text = `${r.title}. ${r.description}`;
    // A retry can resume after the work order was created by an earlier attempt.
    const resumed = !!r.work_order_id && !calls.some((c) => c.name === 'create_work_order');
    const category: Category = resumed && r.category ? r.category : classifyCategory(text);
    const { urgency: guessed, reason } = classifyUrgency(text, category, new Date(ctx.now));
    const urgency: Urgency = resumed && r.urgency ? r.urgency : guessed;
    if (resumed) return this.afterWorkOrder(ctx, calls, r, r.work_order_id, category, urgency, reason);

    if (!last('search_assets') || !last('find_similar_requests')) {
      return {
        text: `This looks like ${withArticle(CATEGORY_LABEL[category].toLowerCase())} issue. Checking the unit's equipment and recent reports.`,
        tools: [
          { name: 'search_assets', input: { property_id: r.property_id, ...(r.unit_id ? { unit_id: r.unit_id } : {}) } },
          { name: 'find_similar_requests', input: { property_id: r.property_id, ...(r.unit_id ? { unit_id: r.unit_id } : {}), days_back: 14, exclude_request_id: r.id } },
        ],
      };
    }

    // Duplicate: same unit, same category, still being handled, and the wording overlaps.
    const similar: any[] = last('find_similar_requests')!.result?.requests ?? [];
    const dupDone = last('mark_duplicate');
    if (dupDone && !dupDone.isError) return { text: `Marked as a duplicate of an existing request that is still being handled. No new work order needed.` };
    if (!dupDone) {
      const dup = similar.find((s) => s.unit_id === r.unit_id && (s.category === category || s.category === null)
        && !['DUPLICATE', 'REJECTED'].includes(s.status)
        && !['COMPLETED', 'CANCELLED'].includes(s.work_order_status ?? '')
        && Date.now() - Date.parse(s.created_at) < 7 * 86400_000
        && similarity(text, `${s.title}. ${s.description}`) >= 0.2);
      if (dup) {
        return {
          text: `"${dup.title}" from ${dup.created_at.slice(0, 10)} describes the same problem in the same unit and is still open.`,
          tools: [{ name: 'mark_duplicate', input: { request_id: r.id, duplicate_of_id: dup.id,
            rationale: `Same ${CATEGORY_LABEL[category].toLowerCase()} problem in unit ${r.unit_label ?? ''} as "${dup.title}", which is still open.`.replace('  ', ' ') } }],
        };
      }
    }

    const assets: any[] = last('search_assets')!.result?.assets ?? [];
    const asset = matchAsset(text, assets, category);
    const triage = last('set_triage');
    if (!triage) {
      const repeat = similar.filter((s) => s.unit_id === r.unit_id && (s.category === category) && s.status !== 'DUPLICATE').length;
      const rationale = [
        `${CATEGORY_LABEL[category]} issue, urgency ${urgency.toLowerCase()} (${reason}).`,
        asset ? `Linked to "${asset.name}".` : 'No matching asset on file.',
        repeat ? `${n(repeat, `other ${CATEGORY_LABEL[category].toLowerCase()} report`)} from this unit in the last 14 days.` : '',
        '(Rules mode: photo not analyzed.)',
      ].filter(Boolean).join(' ');
      return { tools: [{ name: 'set_triage', input: { request_id: r.id, category, urgency, ...(asset ? { asset_id: asset.id } : {}), rationale } }] };
    }
    if (triage.isError) return { text: `Stopping: triage was rejected (${triage.result?.error}). A manager needs to review this request.` };

    const wo = last('create_work_order');
    if (!wo) {
      return {
        tools: [{ name: 'create_work_order', input: {
          request_id: r.id,
          title: `${CATEGORY_LABEL[category]}: ${r.title}`.slice(0, 200),
          description: [
            `Unit ${r.unit_label ?? '(common area)'}${asset ? `, ${asset.name}${asset.make ? ` (${asset.make}${asset.model ? ' ' + asset.model : ''})` : ''}` : ''}.`,
            `Tenant report: "${r.description}"`,
            r.photo_count ? `${n(r.photo_count, 'photo')} attached to the request.` : 'No photos attached.',
          ].join('\n'),
          priority: urgency,
        } }],
      };
    }
    if (wo.isError) return { text: `Stopping: could not create the work order (${wo.result?.error}).` };
    return this.afterWorkOrder(ctx, calls, r, wo.result.work_order_id, category, urgency, reason);
  }

  private afterWorkOrder(ctx: any, calls: Call[], r: any, woId: string, category: Category, urgency: Urgency, reason: string): Step {
    const last = (name: string) => [...calls].reverse().find((c) => c.name === name);

    const techs = last('list_technicians');
    if (!techs) return { text: 'Work order created. Finding a technician.', tools: [{ name: 'list_technicians', input: { property_id: r.property_id, category } }] };

    const assigns = calls.filter((c) => c.name === 'assign_technician');
    const assigned = assigns.find((a) => !a.isError);
    const notified = calls.some((c) => c.name === 'notify_manager');
    if (!assigned) {
      const tried = new Set(assigns.map((a) => a.input.technician_id));
      const pick = (techs.result?.technicians ?? [])
        .filter((t: any) => !t.unavailable_now && t.open_work_orders < t.capacity && !tried.has(t.technician_id))
        .sort((a: any, b: any) => a.open_work_orders - b.open_work_orders)[0];
      if (pick) {
        return { tools: [{ name: 'assign_technician', input: { work_order_id: woId, technician_id: pick.technician_id,
          rationale: `${pick.name} is qualified for ${CATEGORY_LABEL[category].toLowerCase()}, covers this building and has the lowest load (${pick.open_work_orders}/${pick.capacity} open).` } }] };
      }
      if (!notified) {
        return { tools: [{ name: 'notify_manager', input: {
          property_id: r.property_id, kind: urgency === 'EMERGENCY' ? 'EMERGENCY' : 'STATUS', work_order_id: woId,
          title: `${urgency === 'EMERGENCY' ? 'EMERGENCY, ' : ''}no technician available: ${r.title}`.slice(0, 200),
          body: `Unit ${r.unit_label ?? '(common area)'}. No qualified technician has capacity right now; please assign manually.`,
        } }] };
      }
      return { text: `Created the work order but no qualified technician was available. The manager was notified to assign it.` };
    }

    if (urgency === 'EMERGENCY' && !notified) {
      return { tools: [{ name: 'notify_manager', input: {
        property_id: r.property_id, kind: 'EMERGENCY', work_order_id: woId,
        title: `EMERGENCY in unit ${r.unit_label ?? '(common area)'}: ${r.title}`.slice(0, 200),
        body: `${reason[0].toUpperCase()}${reason.slice(1)}. Assigned to ${assigned.result.technician_name}, due within 4 hours.`,
      } }] };
    }
    return { text: `${CATEGORY_LABEL[category]} issue, ${urgency.toLowerCase()} urgency. Created the work order and assigned it to ${assigned.result.technician_name}.` };
  }

  // ───────────────────────────── nightly digest ─────────────────────────────

  private nightly(ctx: any, calls: Call[]): Step {
    const pid = ctx.property_id;
    const first = (name: string) => calls.find((c) => c.name === name);
    const overdueCall = first('list_overdue_work_orders');
    if (!overdueCall) {
      return {
        text: 'Starting the nightly check: overdue work, preventive maintenance due this week, and repeat failures.',
        tools: [
          { name: 'list_overdue_work_orders', input: { property_id: pid } },
          { name: 'list_due_pm_tasks', input: { property_id: pid, within_days: 7 } },
          { name: 'find_repeat_failures', input: { property_id: pid, days_back: 90, min_count: 3 } },
        ],
      };
    }
    const overdue: any[] = overdueCall.result?.work_orders ?? [];
    const due: any[] = first('list_due_pm_tasks')?.result?.tasks ?? [];
    const repeats: any[] = first('find_repeat_failures')?.result?.assets ?? [];

    // 1) Create work orders for preventive tasks due this week
    const pmCalls = calls.filter((c) => c.name === 'create_pm_work_order');
    const pmTodo = due.filter((t) => !t.open_work_order_id);
    if (pmTodo.length && !pmCalls.length) {
      return { text: `${n(pmTodo.length, 'preventive task')} due without a work order. Creating ${pmTodo.length === 1 ? 'it' : 'them'}.`,
        tools: pmTodo.map((t) => ({ name: 'create_pm_work_order', input: { pm_schedule_id: t.pm_schedule_id } })) };
    }
    const newPm = pmCalls.filter((c) => !c.isError && c.result.created);

    // 2) Assign new PM work orders and overdue unassigned ones
    const toAssign = [
      ...newPm.map((c) => ({ id: c.result.work_order_id, category: c.result.category, title: c.result.title })),
      ...overdue.filter((w) => w.status === 'OPEN' && !w.technician_id).map((w) => ({ id: w.id, category: w.category, title: w.title })),
    ];
    const techCalls = calls.filter((c) => c.name === 'list_technicians');
    const categories = [...new Set(toAssign.map((a) => a.category))];
    if (toAssign.length && !techCalls.length) {
      return { tools: categories.map((category) => ({ name: 'list_technicians', input: { property_id: pid, category } })) };
    }
    const assignCalls = calls.filter((c) => c.name === 'assign_technician');
    if (toAssign.length && !assignCalls.length) {
      const pool = new Map<string, any[]>();
      for (const c of techCalls) pool.set(c.input.category, (c.result?.technicians ?? []).map((t: any) => ({ ...t })));
      const tools: Step['tools'] = [];
      for (const a of toAssign) {
        const t = (pool.get(a.category) ?? []).filter((x) => !x.unavailable_now && x.open_work_orders < x.capacity)
          .sort((x, y) => x.open_work_orders - y.open_work_orders)[0];
        if (!t) continue;
        t.open_work_orders++;
        tools.push({ name: 'assign_technician', input: { work_order_id: a.id, technician_id: t.technician_id,
          rationale: `${t.name} covers this building, is qualified for ${a.category.toLowerCase()} and has the lightest load.` } });
      }
      if (tools.length) return { tools };
    }

    // 3) Gated proposals: close finished-but-open work; ask vendors about assets that keep failing
    const gated = calls.filter((c) => ['propose_close_work_order', 'draft_vendor_email'].includes(c.name));
    if (!gated.length) {
      const tools: Step['tools'] = [];
      for (const w of overdue) {
        if (w.has_resolution_notes && ['IN_PROGRESS', 'ON_HOLD'].includes(w.status)) {
          tools.push({ name: 'propose_close_work_order', input: { work_order_id: w.id, resolution_notes: w.resolution_notes,
            rationale: `${w.technician_name ?? 'The technician'} left resolution notes but the work order is still ${w.status.replace('_', ' ').toLowerCase()} and ${n(w.days_overdue, 'day')} overdue.` } });
        }
      }
      for (const a of repeats) {
        if (!a.vendor_email || !a.latest_work_order_id) continue;
        tools.push({ name: 'draft_vendor_email', input: {
          work_order_id: a.latest_work_order_id, vendor_email: a.vendor_email,
          subject: `Replacement quote: ${a.asset_name} at ${ctx.property_name}`,
          body: [
            `Hello${a.vendor_name ? ` ${a.vendor_name}` : ''},`, '',
            `Our ${a.asset_name.toLowerCase()} at ${ctx.property_name} has needed ${a.count} repairs in the last 90 days:`,
            ...a.work_order_titles.slice(0, 5).map((t: string) => `- ${t}`), '',
            'Could you send a quote to replace it, and your earliest availability for an inspection?', '', 'Thank you,', ctx.manager_name,
          ].join('\n'),
          rationale: `${a.count} repairs on the ${a.asset_name.toLowerCase()} in 90 days. Replacing it may cost less than continued repairs.`,
        } });
      }
      if (tools.length) return { tools };
    }

    // 4) Publish the digest
    if (!first('publish_digest')) {
      const items: any[] = [];
      for (const w of overdue) {
        items.push({ type: 'OVERDUE', severity: w.priority === 'EMERGENCY' || w.days_overdue >= 3 ? 'CRITICAL' : 'WARN',
          title: `Overdue ${w.days_overdue}d: ${w.title}`.slice(0, 200),
          detail: w.technician_name ? `${w.technician_name}, status ${w.status.replace('_', ' ').toLowerCase()}.` : 'No technician assigned.',
          ref_type: 'WORK_ORDER', ref_id: w.id });
      }
      for (const a of repeats) {
        items.push({ type: 'REPEAT_FAILURE', severity: 'WARN', title: `${a.asset_name}: ${a.count} repairs in 90 days`,
          detail: a.vendor_email ? `Drafted a quote request to ${a.vendor_name ?? a.vendor_email} for your approval.` : 'No vendor on file. Consider replacement.',
          ref_type: 'ASSET', ref_id: a.asset_id });
      }
      for (const c of newPm) {
        const assign = assignCalls.find((x) => x.input.work_order_id === c.result.work_order_id && !x.isError);
        items.push({ type: 'PM_CREATED', severity: 'INFO', title: `Scheduled: ${c.result.title}`.slice(0, 200),
          detail: `Due ${c.result.due_on}${assign ? `, assigned to ${assign.result.technician_name}` : ', not yet assigned'}.`,
          ref_type: 'WORK_ORDER', ref_id: c.result.work_order_id });
      }
      for (const g of calls.filter((c) => ['propose_close_work_order', 'draft_vendor_email'].includes(c.name) && !c.isError)) {
        items.push({ type: 'APPROVAL_PENDING', severity: 'INFO',
          title: g.name === 'draft_vendor_email' ? `Approve email to ${g.input.vendor_email}` : 'Approve closing a finished work order',
          detail: g.input.rationale, ref_type: 'APPROVAL', ref_id: g.result.approval_id });
      }
      const rank = { CRITICAL: 0, WARN: 1, INFO: 2 } as Record<string, number>;
      items.sort((a, b) => rank[a.severity] - rank[b.severity]);
      const critical = items.filter((i) => i.severity === 'CRITICAL').length;
      const summary = items.length === 0
        ? 'All clear: nothing overdue, no preventive work due this week and no repeat failures.'
        : [
          overdue.length ? `${n(overdue.length, 'work order')} overdue${critical ? ` (${critical} critical)` : ''}.` : 'Nothing overdue.',
          newPm.length ? `Scheduled ${n(newPm.length, 'preventive task')}.` : '',
          repeats.length ? (repeats.length === 1 ? `The ${repeats[0].asset_name.toLowerCase()} keeps failing.` : `${repeats.length} pieces of equipment keep failing.`) : '',
          items.some((i) => i.type === 'APPROVAL_PENDING') ? 'Some actions are waiting for your approval.' : '',
        ].filter(Boolean).join(' ');
      return { tools: [{ name: 'publish_digest', input: { property_id: pid, summary, items: items.slice(0, 30) } }] };
    }
    return { text: 'Nightly check complete. Digest published.' };
  }
}

interface Step {
  text?: string;
  tools?: { name: string; input: Record<string, unknown> }[];
}

function parseContext(messages: LlmMessage[]): any {
  const first = messages[0];
  const text = first.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n');
  const m = /<context>([\s\S]*?)<\/context>/.exec(text);
  if (!m) throw new Error('Local rules engine: missing <context> block in the first message');
  return JSON.parse(m[1]);
}

function history(messages: LlmMessage[]): Call[] {
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  for (const m of messages) {
    for (const b of m.content as any[]) {
      if (m.role === 'assistant' && b.type === 'tool_use') {
        const c: Call = { id: b.id, name: b.name, input: b.input, result: undefined, isError: false };
        calls.push(c);
        byId.set(b.id, c);
      } else if (m.role === 'user' && b.type === 'tool_result') {
        const c = byId.get(b.tool_use_id);
        if (!c) continue;
        c.isError = !!b.is_error;
        try {
          c.result = JSON.parse(b.content);
        } catch {
          c.result = { error: b.content };
        }
      }
    }
  }
  return calls;
}

