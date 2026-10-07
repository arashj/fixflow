import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Check, MessageSquare, Pause, Play, UserRound, X } from 'lucide-react';
import { errorMessage, useAssignMutation, useCandidatesQuery, useCommentMutation, useSetStatusMutation, useWorkOrderQuery } from '../app/api';
import { CATEGORY_LABEL, WO_STATUS_LABEL, dateTime, relative } from '../app/format';
import { useAppSelector } from '../app/store';
import type { WorkOrderDetail as WO, WorkOrderEvent } from '../app/types';
import { AgentMark, ErrorBox, Loading, Photos, Pill, UrgencyTag, WoStatusPill } from '../components/ui';

const ACTION_TEXT: Record<string, string> = {
  SEND_VENDOR_EMAIL: 'email a vendor', CLOSE_WORK_ORDER: 'close this work order', CANCEL_WORK_ORDER: 'cancel this work order', REASSIGN_IN_PROGRESS: 'reassign this work order',
};

function describe(e: WorkOrderEvent): { what: string; extra?: string } {
  const p = e.payload ?? {};
  switch (e.eventType) {
    case 'CREATED': return { what: p.source === 'PREVENTIVE' ? `Created from the preventive schedule, due ${p.dueOn}` : `Created the work order, priority ${String(p.priority ?? '').toLowerCase()}` };
    case 'ASSIGNED': return { what: `Assigned to ${p.technicianName}`, extra: p.rationale ?? undefined };
    case 'REASSIGNED': return { what: `Reassigned to ${p.technicianName}`, extra: p.rationale ?? undefined };
    case 'STATUS_CHANGED': return {
      what: `${WO_STATUS_LABEL[p.from as keyof typeof WO_STATUS_LABEL] ?? p.from} → ${WO_STATUS_LABEL[p.to as keyof typeof WO_STATUS_LABEL] ?? p.to}`,
      extra: [p.note, p.resolutionNotes].filter(Boolean).join('\n') || undefined,
    };
    case 'COMMENT': return { what: 'Commented', extra: p.text };
    case 'DUPLICATE_LINKED': return { what: `Linked a repeat report: “${p.title}”`, extra: p.rationale };
    case 'APPROVAL_REQUESTED': return { what: `Asked for approval to ${ACTION_TEXT[p.actionType] ?? p.actionType}`, extra: p.rationale };
    case 'APPROVAL_DECIDED': return { what: `${p.decision === 'APPROVED' ? 'Approved' : 'Rejected'} the request to ${ACTION_TEXT[p.actionType] ?? p.actionType}`, extra: p.note ?? undefined };
    case 'VENDOR_EMAIL_SENT': return { what: `Emailed ${p.to}`, extra: p.subject };
    default: return { what: e.eventType.toLowerCase().replace(/_/g, ' ') };
  }
}

function Timeline({ events }: { events: WorkOrderEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((e) => {
        const d = describe(e);
        return (
          <li key={e.id}>
            {e.actorType === 'AGENT' ? <AgentMark /> : <span className="dot">{e.eventType === 'COMMENT' ? <MessageSquare aria-hidden /> : <UserRound aria-hidden />}</span>}
            <div>
              <div className="what">
                <b>{e.actorType === 'AGENT' ? 'AI agent' : e.actorName ?? 'System'}</b> {d.what.charAt(0).toLowerCase() + d.what.slice(1)}
              </div>
              {d.extra && <div className="extra">{d.extra}</div>}
              <div className="when">
                {dateTime(e.createdAt)}
                {e.agentRunId && <>, <Link to={`/agent/${e.agentRunId}`}>see agent steps</Link></>}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function WorkOrderDetail() {
  const { id } = useParams();
  const role = useAppSelector((s) => s.auth.user!.role);
  const { data: w, isLoading, error } = useWorkOrderQuery(id!, { pollingInterval: 15_000 });
  if (isLoading) return <Loading />;
  if (error || !w) return <ErrorBox message={errorMessage(error)} />;
  const closed = ['COMPLETED', 'CANCELLED'].includes(w.status);

  return (
    <>
      <Link to={role === 'TECHNICIAN' ? '/' : '/work-orders'} className="back"><ArrowLeft size={16} aria-hidden />{role === 'TECHNICIAN' ? 'My jobs' : 'Work orders'}</Link>
      <div className="page-head">
        <div>
          <h1>{w.title}</h1>
          <p>{w.propertyName}{w.unitLabel ? `, unit ${w.unitLabel}` : ', building'}{w.assetName ? `. ${w.assetName}${w.assetMake ? ` (${w.assetMake}${w.assetModel ? ` ${w.assetModel}` : ''})` : ''}` : ''}.</p>
        </div>
        <div className="row"><UrgencyTag urgency={w.priority} /><WoStatusPill status={w.status} overdue={w.overdue} /></div>
      </div>

      <div className="grid-2">
        <div className="stack">
          {role === 'TECHNICIAN' && !closed && <TechActions w={w} />}
          <section className="panel panel-pad">
            <h2 style={{ marginBottom: 10 }}>Job</h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{w.description}</p>
            {w.requestId && (
              <>
                <h3 style={{ margin: '16px 0 8px' }}>{w.submittedByName ? `${w.submittedByName} reported` : 'Original report'}</h3>
                <p className="quote">{w.requestDescription}</p>
                <Photos photos={w.photos} alt={w.title} />
              </>
            )}
            {w.resolutionNotes && (
              <>
                <h3 style={{ margin: '16px 0 8px' }}>Resolution notes</h3>
                <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{w.resolutionNotes}</p>
              </>
            )}
          </section>
          <section className="panel">
            <div className="panel-head"><h2>History</h2></div>
            <Timeline events={w.events} />
            {role !== 'TENANT' && <CommentBox id={w.id} />}
          </section>
        </div>

        <div className="stack">
          <section className="panel panel-pad">
            <dl className="kv">
              <dt>Technician</dt><dd>{w.technicianName ?? <span className="faint">None yet</span>}</dd>
              <dt>Due</dt><dd>{w.dueAt ? <>{dateTime(w.dueAt)} <span className="faint">({relative(w.dueAt)})</span></> : '—'}</dd>
              <dt>Category</dt><dd>{CATEGORY_LABEL[w.category]}</dd>
              <dt>Source</dt><dd>{w.source === 'PREVENTIVE' ? 'Preventive schedule' : <Link to={`/requests/${w.requestId}`}>Tenant request</Link>}</dd>
              <dt>Created</dt><dd className="row" style={{ gap: 6 }}>{w.createdByAgent && <AgentMark title="Created by the AI agent" />}{dateTime(w.createdAt)}</dd>
              {w.vendorName && <><dt>Vendor</dt><dd>{w.vendorName}</dd></>}
            </dl>
          </section>
          {role === 'MANAGER' && !closed && <ManagerActions w={w} />}
          {role === 'MANAGER' && w.approvals.length > 0 && (
            <section className="panel">
              <div className="panel-head"><h2>Agent proposals</h2><Link to="/approvals" className="small">Approvals</Link></div>
              <ul className="list">
                {w.approvals.map((a) => (
                  <li key={a.id} className="item" style={{ display: 'grid' }}>
                    <div><div className="item-title">Asked to {ACTION_TEXT[a.actionType]}</div><div className="item-meta"><span>{a.rationale}</span></div></div>
                    <div className="item-side"><Pill tone={a.status}>{a.status.toLowerCase()}</Pill></div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

function TechActions({ w }: { w: WO }) {
  const [setStatus, s] = useSetStatusMutation();
  const [notes, setNotes] = useState('');
  const [completing, setCompleting] = useState(false);
  const go = (status: WO['status'], extra: { resolutionNotes?: string } = {}) => setStatus({ id: w.id, status, ...extra });
  return (
    <section className="panel panel-pad stack" style={{ gap: 12, borderColor: 'var(--pine-3)' }}>
      <div className="spread">
        <h2>{w.status === 'ASSIGNED' ? 'Ready to start?' : w.status === 'ON_HOLD' ? 'On hold' : 'Working on it'}</h2>
        <div className="row">
          {w.status === 'ASSIGNED' && <button className="btn btn-primary" disabled={s.isLoading} onClick={() => go('IN_PROGRESS')}><Play size={15} aria-hidden />Start job</button>}
          {w.status === 'ON_HOLD' && <button className="btn btn-primary" disabled={s.isLoading} onClick={() => go('IN_PROGRESS')}><Play size={15} aria-hidden />Resume</button>}
          {w.status === 'IN_PROGRESS' && <button className="btn" disabled={s.isLoading} onClick={() => go('ON_HOLD')}><Pause size={15} aria-hidden />Put on hold</button>}
          {(w.status === 'IN_PROGRESS' || w.status === 'ON_HOLD') && !completing && (
            <button className="btn btn-primary" onClick={() => setCompleting(true)}><Check size={15} aria-hidden />Mark done</button>
          )}
        </div>
      </div>
      {completing && (
        <form className="stack" style={{ gap: 10 }} onSubmit={(e) => { e.preventDefault(); go('COMPLETED', { resolutionNotes: notes }); }}>
          <label className="field">
            <span>What did you do?</span>
            <textarea className="textarea" required value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Parts replaced, what you tested, anything the manager should know" />
            <small>The tenant gets a notification that the repair is done.</small>
          </label>
          <div className="row">
            <button className="btn btn-primary" disabled={s.isLoading || !notes.trim()}>Complete job</button>
            <button type="button" className="btn btn-quiet" onClick={() => setCompleting(false)}>Cancel</button>
          </div>
        </form>
      )}
      {s.error && <ErrorBox message={errorMessage(s.error)} />}
    </section>
  );
}

function ManagerActions({ w }: { w: WO }) {
  const { data: candidates } = useCandidatesQuery(w.id);
  const [assign, a] = useAssignMutation();
  const [setStatus, s] = useSetStatusMutation();
  const [tech, setTech] = useState('');
  const options = (candidates ?? []).filter((c) => c.technician_id !== w.technicianId);
  return (
    <section className="panel">
      <div className="panel-head"><h2>{w.technicianId ? 'Reassign' : 'Assign a technician'}</h2></div>
      <form className="panel-pad stack" style={{ gap: 10 }} onSubmit={(e: FormEvent) => { e.preventDefault(); if (tech) assign({ id: w.id, technicianId: tech }).unwrap().then(() => setTech('')).catch(() => undefined); }}>
        {options.length ? (
          <select className="select" value={tech} onChange={(e) => setTech(e.target.value)} aria-label="Technician">
            <option value="">Choose a technician</option>
            {options.map((c) => (
              <option key={c.technician_id} value={c.technician_id}>
                {c.name}: {c.open_work_orders} of {c.capacity} jobs{c.unavailable_now ? ', away now' : ''}
              </option>
            ))}
          </select>
        ) : <p className="muted small" style={{ margin: 0 }}>No other technician covers this building with {CATEGORY_LABEL[w.category].toLowerCase()} skills.</p>}
        {a.error && <ErrorBox message={errorMessage(a.error)} />}
        <div className="spread">
          <button className="btn btn-primary" disabled={!tech || a.isLoading}>{w.technicianId ? 'Reassign' : 'Assign'}</button>
          <button type="button" className="btn btn-danger btn-sm" disabled={s.isLoading}
            onClick={() => { if (confirm('Cancel this work order? The tenant will be notified.')) setStatus({ id: w.id, status: 'CANCELLED', note: 'Cancelled by manager' }); }}>
            <X size={14} aria-hidden />Cancel work order
          </button>
        </div>
        {s.error && <ErrorBox message={errorMessage(s.error)} />}
      </form>
    </section>
  );
}

function CommentBox({ id }: { id: string }) {
  const [text, setText] = useState('');
  const [comment, c] = useCommentMutation();
  return (
    <form className="row" style={{ padding: '0 20px 18px' }} onSubmit={(e) => { e.preventDefault(); comment({ id, text }).unwrap().then(() => setText('')).catch(() => undefined); }}>
      <input className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Add a note for the team" value={text} onChange={(e) => setText(e.target.value)} aria-label="Note" />
      <button className="btn" disabled={!text.trim() || c.isLoading}>Add note</button>
      {c.error && <ErrorBox message={errorMessage(c.error)} />}
    </form>
  );
}
