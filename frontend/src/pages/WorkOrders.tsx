import { Link, useSearchParams } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { useWorkOrdersQuery } from '../app/api';
import { CATEGORY_LABEL, relative } from '../app/format';
import { useAppSelector } from '../app/store';
import type { WorkOrderSummary } from '../app/types';
import { AgentMark, Empty, Loading, UrgencyTag, WoStatusPill } from '../components/ui';

type Filter = { key: string; label: string; match: (w: WorkOrderSummary) => boolean };
const OPEN = (w: WorkOrderSummary) => !['COMPLETED', 'CANCELLED'].includes(w.status);
const MANAGER_FILTERS: Filter[] = [
  { key: 'open', label: 'Open', match: OPEN },
  { key: 'emergency', label: 'Emergencies', match: (w) => OPEN(w) && w.priority === 'EMERGENCY' },
  { key: 'overdue', label: 'Overdue', match: (w) => w.overdue },
  { key: 'unassigned', label: 'No technician', match: (w) => w.status === 'OPEN' },
  { key: 'preventive', label: 'Preventive', match: (w) => OPEN(w) && w.source === 'PREVENTIVE' },
  { key: 'done', label: 'Done', match: (w) => w.status === 'COMPLETED' },
];
const TECH_FILTERS: Filter[] = [
  { key: 'open', label: 'To do', match: OPEN },
  { key: 'done', label: 'Done', match: (w) => w.status === 'COMPLETED' },
];

function WorkOrderRow({ w, showTech }: { w: WorkOrderSummary; showTech: boolean }) {
  return (
    <li>
      <Link to={`/work-orders/${w.id}`} className="item">
        <div>
          <div className="item-title row" style={{ gap: 8 }}>
            {w.createdByAgent && <AgentMark title="Created by the AI agent" />}
            {w.title}
          </div>
          <div className="item-meta">
            <span>{w.propertyName}{w.unitLabel ? `, unit ${w.unitLabel}` : ''}</span>
            <span>{CATEGORY_LABEL[w.category]}{w.source === 'PREVENTIVE' ? ', preventive' : ''}</span>
            {showTech && <span>{w.technicianName ?? 'No technician'}</span>}
            {w.dueAt && w.status !== 'COMPLETED' && w.status !== 'CANCELLED' && (
              <span className="row" style={{ gap: 4, color: w.overdue ? 'var(--emergency)' : undefined }}>
                <CalendarClock size={14} aria-hidden />due {relative(w.dueAt)}
              </span>
            )}
            {w.completedAt && <span>done {relative(w.completedAt)}</span>}
          </div>
        </div>
        <div className="item-side">
          <WoStatusPill status={w.status} overdue={w.overdue} />
          <UrgencyTag urgency={w.priority} />
        </div>
      </Link>
    </li>
  );
}

export function WorkOrders() {
  const role = useAppSelector((s) => s.auth.user!.role);
  const isTech = role === 'TECHNICIAN';
  const filters = isTech ? TECH_FILTERS : MANAGER_FILTERS;
  const [params, setParams] = useSearchParams();
  const key = filters.some((f) => f.key === params.get('filter')) ? params.get('filter')! : 'open';
  const { data, isLoading } = useWorkOrdersQuery(undefined, { pollingInterval: 10_000 });
  const f = filters.find((x) => x.key === key)!;
  const rows = (data ?? []).filter(f.match);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{isTech ? 'My jobs' : 'Work orders'}</h1>
          <p>{isTech ? 'Jobs assigned to you, most urgent first.' : 'Every repair and preventive job across your buildings, most urgent first.'}</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {filters.map((x) => (
          <button key={x.key} role="tab" aria-selected={key === x.key} onClick={() => setParams(x.key === 'open' ? {} : { filter: x.key })}>
            {x.label}<span className="count">{(data ?? []).filter(x.match).length}</span>
          </button>
        ))}
      </div>
      <section className="panel">
        {isLoading ? <Loading /> : rows.length ? <ul className="list">{rows.map((w) => <WorkOrderRow key={w.id} w={w} showTech={!isTech} />)}</ul>
          : <Empty title={isTech && key === 'open' ? 'No jobs right now' : 'Nothing here'}>{isTech && key === 'open' ? 'New assignments appear here and in your notifications.' : null}</Empty>}
      </section>
    </>
  );
}
