import { useAssetsQuery } from '../app/api';
import { CATEGORY_LABEL, dateOnly } from '../app/format';
import { Empty, Loading } from '../components/ui';

export function Assets() {
  const { data, isLoading } = useAssetsQuery();
  const props = [...new Set((data ?? []).map((a) => a.propertyName))];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Equipment</h1>
          <p>What’s installed in each building, how often it breaks, and its preventive maintenance schedule. The agent links incoming requests to this list.</p>
        </div>
      </div>
      {isLoading ? <Loading /> : !data?.length ? <section className="panel"><Empty title="No equipment yet" /></section> : props.map((p) => (
        <section key={p} className="panel" style={{ marginBottom: 20 }}>
          <div className="panel-head"><h2>{p}</h2></div>
          <div className="table-wrap">
            <table className="plain">
              <thead><tr><th>Equipment</th><th>Where</th><th>Type</th><th>Repairs, 90 days</th><th>Preventive maintenance</th><th>Vendor</th></tr></thead>
              <tbody>
                {data.filter((a) => a.propertyName === p).map((a) => (
                  <tr key={a.id}>
                    <td><b>{a.name}</b><div className="small muted">{[a.make, a.model].filter(Boolean).join(' ')}{a.installedOn ? `, installed ${a.installedOn.slice(0, 4)}` : ''}</div></td>
                    <td>{a.unitLabel ? `Unit ${a.unitLabel}` : 'Building'}</td>
                    <td>{CATEGORY_LABEL[a.category]}</td>
                    <td><span className={a.repairs90d >= 3 ? 'urg urg-HIGH' : ''}>{a.repairs90d}</span>{a.openWorkOrders > 0 && <div className="small muted">{a.openWorkOrders} open</div>}</td>
                    <td className="small">{a.pmSchedules.length ? a.pmSchedules.map((s) => <div key={s.id}>{s.title}, every {s.intervalDays} days. Next {dateOnly(s.nextDueOn)}</div>) : <span className="faint">None</span>}</td>
                    <td className="small">{a.vendorName ?? <span className="faint">None</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}
