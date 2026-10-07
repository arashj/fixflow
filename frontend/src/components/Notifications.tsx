import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useMarkAllReadMutation, useMarkReadMutation, useNotificationsQuery } from '../app/api';
import { relative } from '../app/format';

export function Notifications() {
  const { data } = useNotificationsQuery(undefined, { pollingInterval: 10_000 });
  const [markRead] = useMarkReadMutation();
  const [markAll] = useMarkAllReadMutation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const unread = data?.unread ?? 0;
  return (
    <div className="notif-wrap" ref={ref}>
      <button className="icon-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Bell size={18} aria-hidden />
        {unread > 0 && <span className="dot">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="spread" style={{ padding: '12px 16px' }}>
            <h3>Notifications</h3>
            {unread > 0 && <button className="btn btn-quiet btn-sm" onClick={() => markAll()}>Mark all read</button>}
          </div>
          {!data?.items.length && <div className="empty small">Nothing yet. Updates about your work show up here.</div>}
          {data?.items.map((n) => {
            const body = (
              <>
                <span className="u" aria-hidden />
                <span>
                  <span className="t">{n.title}</span>
                  <span className="b">{n.body}</span>
                  <span className="faint small">{relative(n.createdAt)}</span>
                </span>
              </>
            );
            const cls = `n ${n.kind} ${n.readAt ? '' : 'unread'}`;
            const onClick = () => { if (!n.readAt) markRead(n.id); setOpen(false); };
            return n.linkPath
              ? <Link key={n.id} to={n.linkPath} className={cls} onClick={onClick}>{body}</Link>
              : <button key={n.id} className={cls} onClick={onClick} style={{ border: 0, background: 'none', width: '100%', textAlign: 'left' }}>{body}</button>;
          })}
        </div>
      )}
    </div>
  );
}
