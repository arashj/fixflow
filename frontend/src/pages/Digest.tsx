import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Play } from 'lucide-react';
import { errorMessage, useDigestsQuery, useRunNightlyMutation, useRunsQuery } from '../app/api';
import { dateOnly, relative } from '../app/format';
import type { Digest as D, DigestItem } from '../app/types';
import { AgentMark, AgentWorking, Empty, ErrorBox, Loading } from '../components/ui';

function itemLink(i: DigestItem): string | null {
  if (!i.ref_id) return null;
  if (i.ref_type === 'WORK_ORDER') return `/work-orders/${i.ref_id}`;
  if (i.ref_type === 'APPROVAL') return '/approvals';
  if (i.ref_type === 'ASSET') return '/assets';
  if (i.ref_type === 'REQUEST') return `/requests/${i.ref_id}`;
  return null;
}

const SEV_LABEL = { CRITICAL: 'Critical', WARN: 'Needs attention', INFO: 'For your information' };

export function Digest() {
  // Ids of the runs this page started; we poll until every one of them has finished.
  const [pending, setPending] = useState<string[]>([]);
  const { data, isLoading, refetch } = useDigestsQuery();
  const { data: runs } = useRunsQuery('NIGHTLY_DIGEST', { pollingInterval: pending.length ? 1500 : 0 });
  const [run, r] = useRunNightlyMutation();
  const otherActive = !pending.length && !!runs?.some((x) => x.status === 'QUEUED' || x.status === 'RUNNING');
  useEffect(() => {
    if (!pending.length || !runs) return;
    const done = pending.every((id) => runs.some((x) => x.id === id && x.status !== 'QUEUED' && x.status !== 'RUNNING'));
    if (done) { setPending([]); refetch(); }
  }, [pending, runs, refetch]);
  const working = pending.length > 0 || otherActive;
  const failed = runs?.filter((x) => x.status === 'FAILED' && Date.now() - new Date(x.createdAt).getTime() < 3600_000) ?? [];

  const byDate = new Map<string, D[]>();
  for (const d of data ?? []) byDate.set(d.digestDate, [...(byDate.get(d.digestDate) ?? []), d]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Daily digest</h1>
          <p>Every morning the agent checks each building: overdue work, preventive maintenance coming due, and equipment that keeps breaking. It schedules what it can and writes this summary.</p>
        </div>
        {working ? <AgentWorking label="Running the check" /> : (
          <button className="btn btn-primary" disabled={r.isLoading} onClick={() => run().unwrap().then((res) => setPending(res.runs.map((x) => x.id))).catch(() => undefined)}>
            <Play size={15} aria-hidden />Run the check now
          </button>
        )}
      </div>
      {r.error && <ErrorBox message={errorMessage(r.error)} />}
      {failed.length > 0 && !working && (
        <div style={{ marginBottom: 16 }}><ErrorBox message={`The last check failed for ${failed.map((f) => f.subject).join(', ')}: ${failed[0].error}`} /></div>
      )}
      {isLoading ? <Loading /> : !data?.length ? (
        <section className="panel"><Empty title="No digest yet">Run the check now to see what the agent finds.</Empty></section>
      ) : [...byDate.entries()].map(([date, list]) => (
        <div key={date} className="stack" style={{ marginBottom: 28 }}>
          <h2>{dateOnly(date)}</h2>
          {list.map((d) => (
            <section key={d.id} className="panel">
              <div className="panel-head">
                <h3 className="row" style={{ gap: 8 }}><AgentMark />{d.propertyName}</h3>
                <Link to={`/agent/${d.runId}`} className="small">How this was made, {relative(d.createdAt)}</Link>
              </div>
              <p className="panel-pad" style={{ margin: 0, paddingBottom: d.items.length ? 4 : 18 }}>{d.summary}</p>
              {d.items.map((i, n) => {
                const to = itemLink(i);
                return (
                  <div key={n} className="digest-item">
                    <span className={`sev sev-${i.severity}`} title={SEV_LABEL[i.severity]} aria-label={SEV_LABEL[i.severity]} role="img" />
                    <div>
                      <div style={{ fontWeight: 600 }}>{to ? <Link to={to}>{i.title}</Link> : i.title}</div>
                      {i.detail && <div className="muted small">{i.detail}</div>}
                    </div>
                    <span className="faint small">{SEV_LABEL[i.severity]}</span>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      ))}
    </>
  );
}
