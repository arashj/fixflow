import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Camera } from 'lucide-react';
import { useRequestsQuery } from '../app/api';
import { REQUEST_STATUS_LABEL, relative } from '../app/format';
import type { RequestSummary } from '../app/types';
import { AgentWorking, CategoryText, Empty, Loading, Pill, UrgencyTag, WoStatusPill } from '../components/ui';

const TABS = [
  { key: 'attention', label: 'Needs triage', match: (r: RequestSummary) => ['NEW', 'TRIAGING', 'TRIAGED'].includes(r.status) },
  { key: 'converted', label: 'Work order created', match: (r: RequestSummary) => r.status === 'CONVERTED' },
  { key: 'closed', label: 'Merged or closed', match: (r: RequestSummary) => ['DUPLICATE', 'REJECTED'].includes(r.status) },
  { key: 'all', label: 'All', match: () => true },
];

export function RequestRow({ r, showWho = true }: { r: RequestSummary; showWho?: boolean }) {
  const working = r.agentStatus === 'QUEUED' || r.agentStatus === 'RUNNING';
  return (
    <li>
      <Link to={`/requests/${r.id}`} className="item">
        <div>
          <div className="item-title">{r.title}</div>
          <div className="item-meta">
            <span>{r.propertyName}{r.unitLabel ? `, unit ${r.unitLabel}` : ''}</span>
            {showWho && <span>{r.submittedByName}</span>}
            <span>{relative(r.createdAt)}</span>
            {r.photoCount > 0 && <span className="row" style={{ gap: 4 }}><Camera size={14} aria-hidden />{r.photoCount}</span>}
          </div>
        </div>
        <div className="item-side">
          {working ? <AgentWorking label="Triaging" /> : (
            <>
              {r.workOrderStatus ? <WoStatusPill status={r.workOrderStatus} /> : <Pill tone={r.status === 'NEW' ? 'OPEN' : 'ON_HOLD'}>{REQUEST_STATUS_LABEL[r.status]}</Pill>}
              <span className="row small" style={{ gap: 12 }}><span className="muted"><CategoryText category={r.category} /></span><UrgencyTag urgency={r.urgency} /></span>
            </>
          )}
        </div>
      </Link>
    </li>
  );
}

export function Requests() {
  const { data, isLoading } = useRequestsQuery(undefined, { pollingInterval: 5000 });
  const [tab, setTab] = useState('attention');
  const current = TABS.find((t) => t.key === tab)!;
  const rows = (data ?? []).filter(current.match);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Requests</h1>
          <p>Everything tenants reported. New requests are triaged by the agent within seconds; the ones it could not handle stay under Needs triage.</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}<span className="count">{(data ?? []).filter(t.match).length}</span>
          </button>
        ))}
      </div>
      <section className="panel">
        {isLoading ? <Loading /> : rows.length ? <ul className="list">{rows.map((r) => <RequestRow key={r.id} r={r} />)}</ul>
          : <Empty title={tab === 'attention' ? 'Nothing waiting for triage' : 'No requests here'}>{tab === 'attention' ? 'The agent has handled every new request.' : null}</Empty>}
      </section>
    </>
  );
}
