import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { errorMessage, useRunQuery, useRunsQuery } from '../app/api';
import { dateTime, relative } from '../app/format';
import type { AgentStep } from '../app/types';
import { AccessMark, AgentMark, AgentWorking, Empty, ErrorBox, Loading, Pill } from '../components/ui';

const TYPE_LABEL = { TRIAGE: 'Triage', NIGHTLY_DIGEST: 'Nightly check', MANUAL: 'Manual run' } as const;

export function AgentRuns() {
  const [type, setType] = useState<string>('');
  const { data, isLoading } = useRunsQuery(type || undefined, { pollingInterval: 5000 });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Agent activity</h1>
          <p>Every time the agent runs, each step it took is recorded: what it looked up, what it changed, and what it asked you to approve.</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {[['', 'All runs'], ['TRIAGE', 'Triage'], ['NIGHTLY_DIGEST', 'Nightly checks']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={type === k} onClick={() => setType(k)}>{l}</button>
        ))}
      </div>
      <section className="panel">
        {isLoading ? <Loading /> : !data?.length ? <Empty title="No runs yet">The agent runs when a tenant submits a request, and every morning.</Empty> : (
          <ul className="list">
            {data.map((r) => (
              <li key={r.id}>
                <Link to={`/agent/${r.id}`} className="item">
                  <div>
                    <div className="item-title row" style={{ gap: 8 }}><AgentMark />{TYPE_LABEL[r.runType]}: {r.subject}</div>
                    <div className="item-meta">
                      <span>{r.status === 'FAILED' ? r.error : r.summary ?? 'Working…'}</span>
                    </div>
                    <div className="item-meta" style={{ marginTop: 2 }}>
                      <span>{relative(r.createdAt)}</span>
                      <span>{r.toolCalls} tool calls</span>
                      {r.startedAt && r.finishedAt && <span>{formatDuration(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime())}</span>}
                      {r.attempts > 1 && <span>{r.attempts} attempts</span>}
                    </div>
                  </div>
                  <div className="item-side"><Pill tone={r.status}>{r.status.toLowerCase()}</Pill></div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function short(v: unknown): string {
  if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(v)) return `…${v.slice(-6)}`;
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

function resultSummary(tool: string, out: Record<string, any> | null): { text: string; tone: '' | 'err' | 'gated' } {
  if (!out) return { text: 'No result', tone: 'err' };
  if (out.error) return { text: out.error, tone: 'err' };
  if (out.status === 'PENDING_APPROVAL') return { text: out.note ?? 'Not executed. Waiting for your approval.', tone: 'gated' };
  switch (tool) {
    case 'get_request': return { text: `“${out.title}”, unit ${out.unit_label ?? 'n/a'}, ${out.photo_count} photo(s)`, tone: '' };
    case 'search_assets': return { text: out.assets.length ? `Found ${out.assets.length}: ${out.assets.map((a: any) => a.name).slice(0, 6).join(', ')}` : 'No equipment on file', tone: '' };
    case 'find_similar_requests': return { text: out.requests.length ? `${out.requests.length} recent: ${out.requests.map((r: any) => `“${r.title}” (${r.status.toLowerCase()})`).slice(0, 3).join(', ')}` : 'No similar recent requests', tone: '' };
    case 'get_asset_history': return { text: `${out.asset?.name}: ${out.work_orders.length} past work order(s)`, tone: '' };
    case 'list_technicians': return { text: out.technicians.length ? out.technicians.map((t: any) => `${t.name} ${t.open_work_orders}/${t.capacity}${t.unavailable_now ? ' (away)' : ''}`).join(', ') : 'Nobody qualified covers this building', tone: '' };
    case 'list_overdue_work_orders': return { text: out.work_orders.length ? `${out.work_orders.length} overdue: ${out.work_orders.map((w: any) => w.title).join('; ')}` : 'Nothing overdue', tone: '' };
    case 'list_due_pm_tasks': return { text: out.tasks.length ? `${out.tasks.length} due: ${out.tasks.map((t: any) => `${t.title} (${t.next_due_on})`).join('; ')}` : 'Nothing due this week', tone: '' };
    case 'find_repeat_failures': return { text: out.assets.length ? out.assets.map((a: any) => `${a.asset_name}: ${a.count} repairs`).join('; ') : 'No repeat failures', tone: '' };
    case 'set_triage': return { text: `Saved: ${out.category.toLowerCase()}, ${out.urgency.toLowerCase()}`, tone: '' };
    case 'mark_duplicate': return { text: 'Marked as duplicate', tone: '' };
    case 'create_work_order': return { text: `Work order created, due ${dateTime(out.due_at)}`, tone: '' };
    case 'create_pm_work_order': return { text: out.created ? `Created “${out.title}”` : out.note, tone: '' };
    case 'assign_technician': return { text: `Assigned to ${out.technician_name}`, tone: '' };
    case 'notify_manager': return { text: 'Manager notified', tone: '' };
    case 'publish_digest': return { text: `Digest published with ${out.items} item(s)`, tone: '' };
    default: return { text: 'Done', tone: '' };
  }
}

const HIDE_ARGS = new Set(['body', 'items']);

export function AgentRunDetail() {
  const { id } = useParams();
  const [poll, setPoll] = useState(0);
  const { data: run, isLoading, error } = useRunQuery(id!, { pollingInterval: poll });
  const live = run?.status === 'QUEUED' || run?.status === 'RUNNING';
  if (live !== (poll > 0)) setPoll(live ? 1500 : 0);
  if (isLoading) return <Loading />;
  if (error || !run) return <ErrorBox message={errorMessage(error)} />;

  const results = new Map<string, AgentStep>();
  for (const s of run.steps) if (s.stepType === 'TOOL_RESULT' && s.toolUseId) results.set(s.toolUseId, s);
  const rows = run.steps.filter((s) => s.stepType !== 'TOOL_RESULT');
  const duration = run.startedAt && run.finishedAt ? formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) : null;
  const subjectLink = run.runType === 'TRIAGE' ? `/requests/${run.triggerRef}` : '/digest';

  return (
    <>
      <Link to="/agent" className="back"><ArrowLeft size={16} aria-hidden />Agent activity</Link>
      <div className="page-head">
        <div>
          <h1>{TYPE_LABEL[run.runType]}: <Link to={subjectLink} style={{ color: 'inherit' }}>{run.subject}</Link></h1>
          <p>{run.summary ?? (live ? 'The agent is working on this now.' : run.error)}</p>
        </div>
        {live ? <AgentWorking label="Running" /> : <Pill tone={run.status}>{run.status.toLowerCase()}</Pill>}
      </div>

      <div className="grid-2">
        <section className="panel" aria-label="Steps">
          <div className="panel-head"><h2>Steps</h2><span className="faint small">{run.toolCalls} tool calls</span></div>
          <ol className="ledger">
            {rows.map((s, i) => {
              const no = i + 1;
              if (s.stepType === 'MODEL_TEXT') {
                return <li key={s.seq}><div className="rail">{no}</div><div className="body thought">{s.text}</div></li>;
              }
              if (s.stepType === 'ERROR') {
                return <li key={s.seq} className="error-row"><div className="rail">{no}</div><div className="body"><div className="result err">{s.text}</div></div></li>;
              }
              const res = s.toolUseId ? results.get(s.toolUseId) : undefined;
              const sum = resultSummary(s.toolName!, res?.toolOutput ?? null);
              const args = Object.entries(s.toolInput ?? {});
              return (
                <li key={s.seq}>
                  <div className="rail">{no}</div>
                  <div className="body">
                    <div className="call">
                      <span className="tool">{s.toolName}</span>
                      {s.access && <AccessMark access={s.access} />}
                      {res?.durationMs != null && <span className="faint small">{res.durationMs} ms</span>}
                    </div>
                    {args.length > 0 && (
                      <dl className="args">
                        {args.filter(([k]) => !HIDE_ARGS.has(k)).map(([k, v]) => <FragmentKV key={k} k={k} v={short(v)} />)}
                      </dl>
                    )}
                    {s.toolName === 'draft_vendor_email' && s.toolInput?.body && <p className="quote small" style={{ marginTop: 8 }}>{s.toolInput.body}</p>}
                    <div className={`result ${sum.tone}`}>{res ? sum.text : 'Waiting for result…'}</div>
                    <details>
                      <summary>Raw input and output</summary>
                      <pre>{JSON.stringify({ input: s.toolInput, output: res?.toolOutput }, null, 2)}</pre>
                    </details>
                  </div>
                </li>
              );
            })}
            {!rows.length && <li><div className="rail" /><div className="body muted">{live ? 'Starting…' : 'No steps recorded.'}</div></li>}
          </ol>
        </section>

        <div className="stack">
          <section className="panel panel-pad">
            <dl className="kv">
              <dt>Model</dt><dd>{run.model ?? '—'}</dd>
              <dt>Started</dt><dd>{dateTime(run.startedAt ?? run.createdAt)}</dd>
              <dt>Duration</dt><dd>{duration ?? '—'}</dd>
              <dt>Attempts</dt><dd>{run.attempts} of {run.maxAttempts}</dd>
              <dt>Tokens</dt><dd>{run.inputTokens.toLocaleString()} in, {run.outputTokens.toLocaleString()} out</dd>
            </dl>
          </section>
          <section className="panel panel-pad small">
            <h3 style={{ marginBottom: 10 }}>How the agent is kept in check</h3>
            <div className="stack" style={{ gap: 10 }}>
              <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}><AccessMark access="READ" /><span>Looks things up. Changes nothing.</span></div>
              <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}><AccessMark access="WRITE" /><span>Changes data through the same rules as the app, so it can’t assign an unqualified technician or touch another building.</span></div>
              <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}><AccessMark access="GATED" /><span>Never acts. Creates a proposal in Approvals.</span></div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function FragmentKV({ k, v }: { k: string; v: string }) {
  return (<><dt>{k}</dt><dd>{v}</dd></>);
}
