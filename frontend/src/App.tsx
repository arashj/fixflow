import { Navigate, Route, Routes } from 'react-router-dom';
import { useAppSelector } from './app/store';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Requests } from './pages/Requests';
import { RequestDetail } from './pages/RequestDetail';
import { WorkOrders } from './pages/WorkOrders';
import { WorkOrderDetail } from './pages/WorkOrderDetail';
import { Approvals } from './pages/Approvals';
import { AgentRunDetail, AgentRuns } from './pages/Agent';
import { Digest } from './pages/Digest';
import { Assets } from './pages/Assets';
import { Team } from './pages/Team';
import { TenantHome } from './pages/TenantHome';
import { NewRequest } from './pages/NewRequest';
import { Empty } from './components/ui';

function NotFound() {
  return <section className="panel"><Empty title="Page not found">The link may be old. Use the menu to find what you need.</Empty></section>;
}

export function App() {
  const user = useAppSelector((s) => s.auth.user);
  if (!user) {
    return <Routes><Route path="*" element={<Login />} /></Routes>;
  }
  return (
    <Routes>
      <Route element={<Shell />}>
        {user.role === 'MANAGER' && (
          <>
            <Route index element={<Overview />} />
            <Route path="requests" element={<Requests />} />
            <Route path="work-orders" element={<WorkOrders />} />
            <Route path="approvals" element={<Approvals />} />
            <Route path="agent" element={<AgentRuns />} />
            <Route path="agent/:id" element={<AgentRunDetail />} />
            <Route path="digest" element={<Digest />} />
            <Route path="assets" element={<Assets />} />
            <Route path="team" element={<Team />} />
          </>
        )}
        {user.role === 'TECHNICIAN' && (
          <>
            <Route index element={<WorkOrders />} />
            <Route path="work-orders" element={<Navigate to="/" replace />} />
          </>
        )}
        {user.role === 'TENANT' && (
          <>
            <Route index element={<TenantHome />} />
            <Route path="new" element={<NewRequest />} />
          </>
        )}
        <Route path="requests/:id" element={<RequestDetail />} />
        <Route path="work-orders/:id" element={<WorkOrderDetail />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
