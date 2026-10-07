import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, RotateCw } from 'lucide-react';
import {
  errorMessage, useAssetsQuery, useCreateWorkOrderMutation, useRejectRequestMutation, useRequestQuery, useRetriageMutation, useTriageManuallyMutation,
} from '../app/api';
import { CATEGORY_LABEL, REQUEST_STATUS_LABEL, URGENCY_LABEL, dateTime, relative } from '../app/format';
import { useAppSelector } from '../app/store';
import type { Category, RequestDetail as Req, Urgency } from '../app/types';
import { AgentMark, AgentWorking, CategoryText, ErrorBox, Loading, Photos, Pill, UrgencyTag, WoStatusPill } from '../components/ui';

export function RequestDetail() {
  const { id } = useParams();
  const role = useAppSelector((s) => s.auth.user!.role);
  const [poll, setPoll] = useState(0);
  const { data: r, isLoading, error } = useRequestQuery(id!, { pollingInterval: poll });
  const working = !!r?.agentRuns.some((a) => a.status === 'QUEUED' || a.status === 'RUNNING') || r?.status === 'TRIAGING';
  if (working !== (poll > 0)) setPoll(working ? 1500 : 0);

  if (isLoading) return <Loading />;
  if (error || !r) return <ErrorBox message={errorMessage(error)} />;

  return (
    <>
      <Link to={role === 'MANAGER' ? '/requests' : '/'} className="back"><ArrowLeft size={16} aria-hidden />{role === 'MANAGER' ? 'Requests' : 'My requests'}</Link>
      <div className="page-head">
        <div>
          <h1>{r.title}</h1>
          <p>{r.propertyName}{r.unitLabel ? `, unit ${r.unitLabel}` : ', common area'}. Reported by {r.submittedByName} {relative(r.createdAt)}.</p>
        </div>
        {working ? <AgentWorking /> : r.workOrderStatus ? <WoStatusPill status={r.workOrderStatus} /> : <Pill tone="ON_HOLD">{REQUEST_STATUS_LABEL[r.status]}</Pill>}
      </div>
      {role === 'TENANT' ? <TenantView r={r} working={working} /> : <StaffView r={r} working={working} manager={role === 'MANAGER'} />}
    </>
  );
}

function TenantView({ r, working }: { r: Req; working: boolean }) {
  const stage = r.workOrderStatus === 'COMPLETED' ? 5 : r.workOrderStatus === 'IN_PROGRESS' || r.workOrderStatus === 'ON_HOLD' ? 4
    : r.workOrderStatus ? 3 : ['TRIAGED', 'DUPLICATE'].includes(r.status) ? 2 : 1;
  const steps = ['Reported', 'Reviewed', 'Scheduled', 'Being fixed', 'Done'];
  const message = r.status === 'DUPLICATE'
    ? <>This is the same problem as <b>{r.duplicateOfTitle}</b>, which is already being handled, so the two were merged. You don’t need to do anything.</>
    : r.status === 'REJECTED' ? <>Your property manager closed this request. {r.triageRationale}</>
    : r.workOrderStatus === 'COMPLETED' ? <>The repair is done. If the problem comes back, report it again.</>
    : r.workOrderStatus === 'CANCELLED' ? <>The repair was cancelled. Contact your property manager if this is still a problem.</>
    : r.technicianName ? <>{r.technicianName} is handling this.{r.workOrderDueAt ? <> Expected by <b>{dateTime(r.workOrderDueAt)}</b></> : null}</>
    : r.workOrderId ? <>A repair was scheduled. Your property manager is choosing a technician.</>
    : working ? <>We’re reviewing your request now. This usually takes a few seconds.</>
    : <>Your property manager will review this shortly.</>;
  return (
    <div className="grid-2">
      <div className="stack">
        <section className="panel panel-pad">
          <ol className="progress" aria-label="Progress">
            {steps.map((s, i) => <li key={s} className={i + 1 < stage ? 'done' : i + 1 === stage ? 'current' : ''} aria-current={i + 1 === stage ? 'step' : undefined}>{s}</li>)}
          </ol>
          <p style={{ margin: '20px 0 0' }}>{message}</p>
          {r.urgency === 'EMERGENCY' && r.workOrderStatus !== 'COMPLETED' && (
            <p className="form-error" style={{ marginTop: 14 }}>Marked as an emergency. If anyone is in danger, call 911 first.</p>
          )}
        </section>
        <section className="panel panel-pad">
          <h2 style={{ marginBottom: 10 }}>What you reported</h2>
          <p className="quote">{r.description}</p>
          <Photos photos={r.photos} alt={r.title} />
        </section>
      </div>
      <section className="panel panel-pad">
        <dl className="kv">
          <dt>Submitted</dt><dd>{dateTime(r.createdAt)}</dd>
          <dt>Type</dt><dd><CategoryText category={r.category} /></dd>
          <dt>Urgency</dt><dd><UrgencyTag urgency={r.urgency} /></dd>
          <dt>Technician</dt><dd>{r.technicianName ?? 'Not yet assigned'}</dd>
        </dl>
      </section>
    </div>
  );
}

function StaffView({ r, working, manager }: { r: Req; working: boolean; manager: boolean }) {
  const [retriage, rt] = useRetriageMutation();
  const canAct = manager && ['NEW', 'TRIAGED'].includes(r.status) && !working;
  return (
    <div className="grid-2">
      <div className="stack">
        <section className="panel panel-pad">
          <h2 style={{ marginBottom: 10 }}>Tenant’s description</h2>
          <p className="quote">{r.description}</p>
          <Photos photos={r.photos} alt={r.title} />
        </section>
        {r.triageRationale && (
          <div className="ai-note">
            {r.triageRationale.startsWith('Triaged manually') || r.triageRationale.startsWith('Rejected by') ? <span /> : <AgentMark />}
            <p>{r.triageRationale}</p>
          </div>
        )}
        {r.status === 'DUPLICATE' && r.duplicateOfId && (
          <div className="form-ok">Merged into <Link to={`/requests/${r.duplicateOfId}`}>{r.duplicateOfTitle}</Link>.</div>
        )}
        {canAct && <ManualTriage r={r} />}
      </div>
      <div className="stack">
        <section className="panel panel-pad">
          <dl className="kv">
            <dt>Status</dt><dd>{REQUEST_STATUS_LABEL[r.status]}</dd>
            <dt>Category</dt><dd><CategoryText category={r.category} /></dd>
            <dt>Urgency</dt><dd><UrgencyTag urgency={r.urgency} /></dd>
            <dt>Equipment</dt><dd>{r.assetName ?? <span className="faint">Not linked</span>}</dd>
            <dt>Work order</dt><dd>{r.workOrderId ? <Link to={`/work-orders/${r.workOrderId}`}>Open work order</Link> : <span className="faint">None</span>}</dd>
            <dt>Technician</dt><dd>{r.technicianName ?? <span className="faint">None</span>}</dd>
          </dl>
        </section>
        {manager && (
          <section className="panel">
            <div className="panel-head">
              <h2>Agent runs</h2>
              {canAct && (
                <button className="btn btn-sm" disabled={rt.isLoading} onClick={() => retriage(r.id)}><RotateCw size={14} aria-hidden />Run again</button>
              )}
            </div>
            {rt.error && <div style={{ padding: '12px 20px 0' }}><ErrorBox message={errorMessage(rt.error)} /></div>}
            <ul className="list">
              {r.agentRuns.map((a) => (
                <li key={a.id}>
                  <Link to={`/agent/${a.id}`} className="item">
                    <div>
                      <div className="item-title">{a.status === 'SUCCEEDED' ? a.summary : a.status === 'FAILED' ? `Failed: ${a.error}` : 'In progress'}</div>
                      <div className="item-meta"><span>{dateTime(a.createdAt)}</span></div>
                    </div>
                    <div className="item-side"><Pill tone={a.status}>{a.status.toLowerCase()}</Pill></div>
                  </Link>
                </li>
              ))}
              {!r.agentRuns.length && <li><div className="empty small">The agent has not run on this request.</div></li>}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

const CATEGORIES = Object.keys(CATEGORY_LABEL) as Category[];
const URGENCIES = Object.keys(URGENCY_LABEL) as Urgency[];

function ManualTriage({ r }: { r: Req }) {
  const { data: assets } = useAssetsQuery(r.propertyId);
  const [category, setCategory] = useState<Category>(r.category ?? 'GENERAL');
  const [urgency, setUrgency] = useState<Urgency>(r.urgency ?? 'NORMAL');
  const [assetId, setAssetId] = useState(r.assetId ?? '');
  const [title, setTitle] = useState(r.title);
  const [reason, setReason] = useState('');
  const [triage, t] = useTriageManuallyMutation();
  const [create, c] = useCreateWorkOrderMutation();
  const [reject, rj] = useRejectRequestMutation();
  const unitAssets = (assets ?? []).filter((a) => !a.unitLabel || a.unitLabel === r.unitLabel);
  const err = t.error || c.error || rj.error;

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await triage({ id: r.id, category, urgency, assetId: assetId || null }).unwrap();
      await create({ requestId: r.id, title, description: r.description, priority: urgency }).unwrap();
    } catch { /* shown below */ }
  }

  return (
    <section className="panel">
      <div className="panel-head"><h2>Triage it yourself</h2></div>
      <form className="panel-pad stack" style={{ gap: 12 }} onSubmit={submit}>
        <p className="muted small" style={{ margin: 0 }}>Set the details and create the work order. You can assign a technician on the next screen.</p>
        <label className="field"><span>Work order title</span><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} /></label>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <label className="field" style={{ flex: 1, minWidth: 150 }}><span>Category</span>
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              {CATEGORIES.map((c2) => <option key={c2} value={c2}>{CATEGORY_LABEL[c2]}</option>)}
            </select>
          </label>
          <label className="field" style={{ flex: 1, minWidth: 150 }}><span>Urgency</span>
            <select className="select" value={urgency} onChange={(e) => setUrgency(e.target.value as Urgency)}>
              {URGENCIES.map((u) => <option key={u} value={u}>{URGENCY_LABEL[u]}</option>)}
            </select>
          </label>
        </div>
        <label className="field"><span>Equipment</span>
          <select className="select" value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">Not linked</option>
            {unitAssets.map((a) => <option key={a.id} value={a.id}>{a.name}{a.unitLabel ? '' : ' (building)'}</option>)}
          </select>
        </label>
        {err && <ErrorBox message={errorMessage(err)} />}
        <div className="row">
          <button className="btn btn-primary" disabled={t.isLoading || c.isLoading}>Create work order</button>
        </div>
        <details>
          <summary className="small muted" style={{ cursor: 'pointer' }}>Close without a repair</summary>
          <div className="row" style={{ marginTop: 10 }}>
            <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Reason the tenant will see" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button type="button" className="btn btn-danger" disabled={reason.trim().length < 3 || rj.isLoading} onClick={() => reject({ id: r.id, reason })}>Close request</button>
          </div>
        </details>
      </form>
    </section>
  );
}
