import { useState } from 'react';
import { Link } from 'react-router-dom';
import { errorMessage, useApprovalsQuery, useApproveMutation, useRejectMutation } from '../app/api';
import { dateTime, relative } from '../app/format';
import type { Approval } from '../app/types';
import { AgentMark, Empty, ErrorBox, Loading, Pill } from '../components/ui';

const VERB: Record<Approval['actionType'], string> = {
  SEND_VENDOR_EMAIL: 'Send email', CLOSE_WORK_ORDER: 'Close work order', CANCEL_WORK_ORDER: 'Cancel work order', REASSIGN_IN_PROGRESS: 'Reassign',
};

function headline(a: Approval) {
  switch (a.actionType) {
    case 'SEND_VENDOR_EMAIL': return `Email ${a.payload.vendor_email}`;
    case 'CLOSE_WORK_ORDER': return `Close “${a.workOrderTitle}” as done`;
    case 'CANCEL_WORK_ORDER': return `Cancel “${a.workOrderTitle}”`;
    case 'REASSIGN_IN_PROGRESS': return `Move “${a.workOrderTitle}” from ${a.currentTechnicianName ?? 'nobody'} to ${a.newTechnicianName}`;
  }
}

function PendingApproval({ a }: { a: Approval }) {
  const [subject, setSubject] = useState<string>(a.payload.subject ?? '');
  const [body, setBody] = useState<string>(a.payload.body ?? '');
  const [note, setNote] = useState('');
  const [approve, ap] = useApproveMutation();
  const [reject, rj] = useRejectMutation();
  const busy = ap.isLoading || rj.isLoading;
  const isEmail = a.actionType === 'SEND_VENDOR_EMAIL';
  return (
    <article className="approval" aria-labelledby={`ap-${a.id}`}>
      <div className="spread">
        <div id={`ap-${a.id}`} className="what">{headline(a)}</div>
        <span className="faint small">{a.propertyName}, proposed {relative(a.createdAt)}</span>
      </div>
      <div className="ai-note" style={{ marginTop: 10 }}>
        <AgentMark />
        <p>{a.rationale} <Link to={`/agent/${a.runId}`}>See how the agent got here</Link></p>
      </div>
      <p className="small muted" style={{ margin: '10px 0 0' }}>Work order: <Link to={`/work-orders/${a.workOrderId}`}>{a.workOrderTitle}</Link></p>
      {a.actionType === 'CLOSE_WORK_ORDER' && (
        <div style={{ marginTop: 10 }}>
          <b className="small">Technician’s notes</b>
          <p className="quote" style={{ marginTop: 4 }}>{a.payload.resolution_notes}</p>
        </div>
      )}
      {isEmail && (
        <div className="email-preview">
          <div className="hdr">
            <span className="muted">To: {a.payload.vendor_email}</span>
            <label className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <span className="muted">Subject</span>
              <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </label>
          </div>
          <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Email body" />
        </div>
      )}
      <div className="row" style={{ marginTop: 14 }}>
        <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Note for the log (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Decision note" />
        <button className="btn btn-primary" disabled={busy || (isEmail && (!subject.trim() || !body.trim()))}
          onClick={() => approve({ id: a.id, note: note || undefined, ...(isEmail ? { subject, body } : {}) })}>
          {VERB[a.actionType]}
        </button>
        <button className="btn" disabled={busy} onClick={() => reject({ id: a.id, note: note || undefined })}>Reject</button>
      </div>
      {(ap.error || rj.error) && <div style={{ marginTop: 10 }}><ErrorBox message={errorMessage(ap.error || rj.error)} /></div>}
    </article>
  );
}

export function Approvals() {
  const [tab, setTab] = useState<'PENDING' | 'ALL'>('PENDING');
  const { data, isLoading } = useApprovalsQuery(tab, { pollingInterval: 15_000 });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p>The agent never sends emails, closes, cancels or reassigns work on its own. It proposes, you decide. Nothing happens until you approve.</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'PENDING'} onClick={() => setTab('PENDING')}>Waiting for you</button>
        <button role="tab" aria-selected={tab === 'ALL'} onClick={() => setTab('ALL')}>History</button>
      </div>
      <section className="panel">
        {isLoading ? <Loading /> : !data?.length ? (
          <Empty title={tab === 'PENDING' ? 'Nothing to approve' : 'No decisions yet'}>{tab === 'PENDING' ? 'Proposals from the nightly check appear here.' : null}</Empty>
        ) : tab === 'PENDING' ? data.map((a) => <PendingApproval key={a.id} a={a} />) : (
          <div className="table-wrap">
            <table className="plain">
              <thead><tr><th>Proposal</th><th>Decision</th><th>By</th><th>When</th></tr></thead>
              <tbody>
                {data.map((a) => (
                  <tr key={a.id}>
                    <td><Link to={`/work-orders/${a.workOrderId}`}>{headline(a)}</Link>{a.decisionNote && <div className="small muted">{a.decisionNote}</div>}</td>
                    <td><Pill tone={a.status}>{a.status === 'EXECUTED' ? 'approved' : a.status.toLowerCase()}</Pill></td>
                    <td>{a.decidedByName ?? '—'}</td>
                    <td className="small">{dateTime(a.decidedAt ?? a.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
