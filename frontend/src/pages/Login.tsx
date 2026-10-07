import { useState, type FormEvent } from 'react';
import { CheckCircle2, Wrench } from 'lucide-react';
import { errorMessage, useAgentStatusQuery, useDemoAccountsQuery, useLoginMutation } from '../app/api';
import { signIn } from '../app/store';
import { AgentMark, ErrorBox } from '../components/ui';

const ROLE_LABEL = { MANAGER: 'Property manager', TECHNICIAN: 'Technician', TENANT: 'Tenant' } as const;

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [login, { isLoading, error }] = useLoginMutation();
  const { data: demo } = useDemoAccountsQuery();
  const { data: status } = useAgentStatusQuery();

  async function submit(e?: FormEvent, creds = { email, password }) {
    e?.preventDefault();
    try {
      signIn(await login(creds).unwrap());
    } catch {
      /* error rendered below */
    }
  }

  return (
    <div className="login">
      <section className="login-art">
        <div className="row" style={{ gap: 10, color: '#fff' }}>
          <Wrench size={22} aria-hidden /><span className="brand-name">FixFlow</span>
        </div>
        <div>
          <h1>Repair requests that sort themselves out.</h1>
          <p style={{ marginTop: 16 }}>
            Tenants report a problem with a photo. An AI agent triages it, creates the work order and assigns the right technician
            in seconds. Anything risky waits for your approval.
          </p>
        </div>
        <div className="ticket" aria-hidden>
          <div className="ticket-top">
            <div className="faint small">Unit 1A, reported 9:42 pm</div>
            <b>Water pouring from under the kitchen sink</b>
          </div>
          <ol>
            <li><AgentMark /> Triaged as plumbing, emergency</li>
            <li><AgentMark /> Linked to the unit’s kitchen sink</li>
            <li><AgentMark /> Work order created, due in 4 hours</li>
            <li><AgentMark /> Assigned to Sam, manager alerted</li>
            <li><CheckCircle2 size={18} color="#2c7049" /> Every step logged for review</li>
          </ol>
        </div>
      </section>

      <section className="login-form">
        <div className="inner stack">
          <div>
            <h2 style={{ fontSize: '1.5rem' }}>Sign in</h2>
            <p className="muted" style={{ marginTop: 6 }}>Pick a demo account to try each role, or sign in with email.</p>
          </div>
          {demo && demo.length > 0 && (
            <ul className="demo-list" aria-label="Demo accounts">
              {demo.map((d) => (
                <li key={d.email}>
                  <button type="button" disabled={isLoading} onClick={() => submit(undefined, { email: d.email, password: 'demo1234' })}>
                    <span style={{ fontWeight: 650 }}>{d.fullName}</span>
                    <span className="role">{ROLE_LABEL[d.role]}</span>
                    <span className="faint small">{d.detail ?? d.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="stack" onSubmit={submit} style={{ gap: 12 }}>
            <label className="field">
              <span>Email</span>
              <input className="input" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">
              <span>Password</span>
              <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            {error && <ErrorBox message={errorMessage(error)} />}
            <button className="btn btn-primary" disabled={isLoading}>{isLoading ? 'Signing in…' : 'Sign in'}</button>
            <p className="faint small" style={{ margin: 0 }}>
              Demo accounts all use the password demo1234.{status?.demoResets ? ' This demo resets every night, so feel free to change anything.' : ''}
            </p>
          </form>
        </div>
      </section>
    </div>
  );
}
