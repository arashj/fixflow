import { Link } from 'react-router-dom';
import { useDashboardQuery, useDigestsQuery } from '../app/api';
import { relative, plural } from '../app/format';
import { AgentMark, Empty, Loading, Pill } from '../components/ui';
import { useAppSelector } from '../app/store';

export function Overview() {
  const user = useAppSelector((s) => s.auth.user)!;
  const { data, isLoading } = useDashboardQuery(undefined, { pollingInterval: 10_000 });
  const { data: digests } = useDigestsQuery();
  if (isLoading || !data) return <Loading />;
  const { stats, agent, recentRuns, workload } = data;
  const latest = digests?.filter((d) => d.digestDate === digests[0]?.digestDate) ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}, {user.fullName.split(' ')[0]}</h1>
          <p>{stats.pendingApprovals || stats.openEmergencies || stats.overdue
            ? 'Here is what needs a decision from you. The agent handles the rest.'
            : 'Nothing needs you right now. The agent is handling incoming requests.'}</p>
        </div>
      </div>

      <div className="attention">
        <Link to="/work-orders?filter=emergency" className={`tile ${stats.openEmergencies ? 'hot' : ''}`}>
          <span className="num">{stats.openEmergencies}</span><span className="label">Open emergencies</span>
        </Link>
        <Link to="/approvals" className={`tile ${stats.pendingApprovals ? 'agentic' : ''}`}>
          <span className="num">{stats.pendingApprovals}</span><span className="label">Waiting for your approval</span>
        </Link>
        <Link to="/work-orders?filter=overdue" className={`tile ${stats.overdue ? 'hot' : ''}`}>
          <span className="num">{stats.overdue}</span><span className="label">Overdue work orders</span>
        </Link>
        <Link to="/work-orders?filter=unassigned" className="tile">
          <span className="num">{stats.unassigned}</span><span className="label">No technician yet</span>
        </Link>
      </div>

      <div className="grid-2">
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Today’s digest</h2>
              <Link to="/digest" className="small">Open digest</Link>
            </div>
            {latest.length ? latest.map((d) => (
              <div key={d.id} className="panel-pad" style={{ borderTop: '1px solid var(--line)' }}>
                <div className="spread"><b>{d.propertyName}</b><span className="faint small">{relative(d.createdAt)}</span></div>
                <p style={{ margin: '6px 0 0' }}>{d.summary}</p>
              </div>
            )) : <Empty title="No digest yet">The agent writes one every morning. You can also run it now from the digest page.</Empty>}
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Technician workload</h2><Link to="/team" className="small">All technicians</Link></div>
            <div className="panel-pad stack" style={{ gap: 12 }}>
              {workload.map((t) => (
                <div key={t.id}>
                  <div className="spread small"><span style={{ fontWeight: 600 }}>{t.name}</span><span className="muted">{t.open} of {t.capacity} open jobs</span></div>
                  <div className={`load-bar ${t.open >= t.capacity ? 'full' : ''}`} role="img" aria-label={`${t.open} of ${t.capacity}`}>
                    <i style={{ width: `${Math.min(100, (t.open / t.capacity) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="agent-board" aria-labelledby="agent-h">
          <div className="row"><AgentMark title="AI agent" /><h2 id="agent-h">What the agent did</h2></div>
          <div className="facts">
            <div><span className="num">{agent.workOrdersCreated30d}</span><span>work orders created</span></div>
            <div><span className="num">{agent.autoAssigned30d}</span><span>assigned without you</span></div>
            <div><span className="num">{agent.avgTriageSeconds === null ? '—' : agent.avgTriageSeconds < 1 ? <>&lt;1<small style={{ fontSize: '0.9rem' }}>s</small></> : <>{agent.avgTriageSeconds}<small style={{ fontSize: '0.9rem' }}>s</small></>}</span><span>average triage time</span></div>
          </div>
          <p className="small" style={{ color: '#a9c2b9', margin: '0 0 4px' }}>Last 30 days, {plural(agent.runs30d, 'run')}{agent.failed30d ? `, ${agent.failed30d} failed` : ''}.</p>
          <ul className="feed">
            {recentRuns.map((r) => (
              <li key={r.id}>
                <AgentMark />
                <div>
                  <Link to={`/agent/${r.id}`}>{r.runType === 'TRIAGE' ? `Triage: ${r.subject ?? 'request'}` : `Nightly check: ${r.subject}`}</Link>
                  <div className="s">{r.status === 'SUCCEEDED' ? r.summary : <Pill tone={r.status}>{r.status.toLowerCase()}</Pill>} <span style={{ color: '#7f9e93' }}>{relative(r.createdAt)}</span></div>
                </div>
              </li>
            ))}
            {!recentRuns.length && <li><span /><span className="s">No runs yet. New requests are triaged as soon as they arrive.</span></li>}
          </ul>
          <Link to="/agent" className="small" style={{ display: 'inline-block', marginTop: 10 }}>See every run and its steps</Link>
        </section>
      </div>
    </>
  );
}
