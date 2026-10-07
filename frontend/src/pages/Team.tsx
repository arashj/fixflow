import { useTechniciansQuery } from '../app/api';
import { CATEGORY_LABEL, dateOnly } from '../app/format';
import { Empty, Loading } from '../components/ui';

export function Team() {
  const { data, isLoading } = useTechniciansQuery();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Technicians</h1>
          <p>The agent only assigns work to technicians who cover the building, have the right skill, are available and have room in their queue.</p>
        </div>
      </div>
      <section className="panel">
        {isLoading ? <Loading /> : !data?.length ? <Empty title="No technicians yet" /> : (
          <div className="table-wrap">
            <table className="plain">
              <thead><tr><th>Name</th><th>Skills</th><th>Buildings</th><th>Workload</th><th>Time off</th></tr></thead>
              <tbody>
                {data.map((t) => (
                  <tr key={t.id}>
                    <td><b>{t.name}</b><div className="small muted">{t.phone}</div></td>
                    <td className="small">{t.skills.map((s) => CATEGORY_LABEL[s]).join(', ')}</td>
                    <td className="small">{t.properties.join(', ')}</td>
                    <td style={{ minWidth: 140 }}>
                      <div className="small">{t.open} of {t.capacity} jobs</div>
                      <div className={`load-bar ${t.open >= t.capacity ? 'full' : ''}`}><i style={{ width: `${Math.min(100, (t.open / t.capacity) * 100)}%` }} /></div>
                    </td>
                    <td className="small">{t.nextUnavailability ? `${t.nextUnavailability.reason ?? 'Away'}, ${dateOnly(t.nextUnavailability.startsAt)} to ${dateOnly(t.nextUnavailability.endsAt)}` : <span className="faint">None planned</span>}</td>
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
