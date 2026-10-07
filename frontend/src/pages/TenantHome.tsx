import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { useRequestsQuery } from '../app/api';
import { Empty, Loading } from '../components/ui';
import { RequestRow } from './Requests';

export function TenantHome() {
  const { data, isLoading } = useRequestsQuery(undefined, { pollingInterval: 8000 });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>My requests</h1>
          <p>Report a problem in your home and follow the repair here. You’ll also get a notification at each step.</p>
        </div>
        <Link to="/new" className="btn btn-primary"><Plus size={16} aria-hidden />Report a problem</Link>
      </div>
      <section className="panel">
        {isLoading ? <Loading /> : data?.length ? <ul className="list">{data.map((r) => <RequestRow key={r.id} r={r} showWho={false} />)}</ul> : (
          <Empty title="No requests yet">When something breaks, <Link to="/new">report it here</Link> with a photo.</Empty>
        )}
      </section>
    </>
  );
}
