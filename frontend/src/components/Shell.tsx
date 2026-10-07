import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Bot, Boxes, ClipboardList, Inbox, LayoutDashboard, LogOut, Menu, Newspaper, ShieldCheck, Users, Wrench, Plus } from 'lucide-react';
import { useAgentStatusQuery, useApprovalsQuery } from '../app/api';
import { signOut, useAppSelector } from '../app/store';
import { Notifications } from './Notifications';

function Logo() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#f4f7f6" />
      <path d="M9 23l8.5-8.5M19.5 7.5a5 5 0 0 0-1.6 5.6L9 22l1 1 8.9-8.9a5 5 0 0 0 5.6-1.6l-2.6-.5-.9-2.4 2-2a5 5 0 0 0-2.4-.1z" fill="none" stroke="#1d3b33" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export function Shell() {
  const user = useAppSelector((s) => s.auth.user)!;
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const { data: agent } = useAgentStatusQuery();
  const isManager = user.role === 'MANAGER';
  const { data: approvals } = useApprovalsQuery(undefined, { skip: !isManager, pollingInterval: 15_000 });
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <NavLink to="/" className="brand"><Logo /><span className="brand-name">FixFlow</span></NavLink>
        <nav className="nav">
          {isManager && (
            <>
              <NavLink to="/" end><LayoutDashboard size={18} aria-hidden />Overview</NavLink>
              <NavLink to="/requests"><Inbox size={18} aria-hidden />Requests</NavLink>
              <NavLink to="/work-orders"><ClipboardList size={18} aria-hidden />Work orders</NavLink>
              <NavLink to="/approvals"><ShieldCheck size={18} aria-hidden />Approvals{!!approvals?.length && <span className="count">{approvals.length}</span>}</NavLink>
              <div className="nav-group">AI agent</div>
              <NavLink to="/digest"><Newspaper size={18} aria-hidden />Daily digest</NavLink>
              <NavLink to="/agent"><Bot size={18} aria-hidden />Agent activity</NavLink>
              <div className="nav-group">Buildings</div>
              <NavLink to="/assets"><Boxes size={18} aria-hidden />Equipment</NavLink>
              <NavLink to="/team"><Users size={18} aria-hidden />Technicians</NavLink>
            </>
          )}
          {user.role === 'TECHNICIAN' && <NavLink to="/" end><Wrench size={18} aria-hidden />My jobs</NavLink>}
          {user.role === 'TENANT' && (
            <>
              <NavLink to="/" end><Inbox size={18} aria-hidden />My requests</NavLink>
              <NavLink to="/new"><Plus size={18} aria-hidden />Report a problem</NavLink>
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          <div className="who">{user.fullName}</div>
          <div style={{ color: '#9fbab0' }}>{user.role === 'MANAGER' ? 'Property manager' : user.role === 'TECHNICIAN' ? 'Technician' : 'Tenant'}</div>
          {isManager && agent && (
            <div className="agent-mode">
              <Bot size={15} aria-hidden />
              <span>{agent.mode === 'claude' ? <>Agent runs on Claude ({agent.model})</> : <>Agent runs in local rules mode. Add an Anthropic API key to use Claude.</>}</span>
            </div>
          )}
          <button className="btn btn-quiet btn-sm" style={{ color: '#cfdcd7', marginTop: 10, paddingLeft: 0 }} onClick={signOut}>
            <LogOut size={15} aria-hidden /> Sign out
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="Open menu" onClick={() => setOpen(true)}><Menu size={18} aria-hidden /></button>
          <Notifications />
        </header>
        <main className="page" id="main"><Outlet /></main>
      </div>
      {open && <div style={{ position: 'fixed', inset: 0, zIndex: 35 }} onClick={() => setOpen(false)} aria-hidden />}
    </div>
  );
}
