import { useEffect, useState, type ReactNode } from 'react';
import { Bot, Eye, Lock, PenLine } from 'lucide-react';
import { useAppSelector } from '../app/store';
import { CATEGORY_LABEL, URGENCY_LABEL, WO_STATUS_LABEL } from '../app/format';
import type { Access, Category, Urgency, WoStatus } from '../app/types';

export function UrgencyTag({ urgency }: { urgency: Urgency | null }) {
  if (!urgency) return <span className="faint small">Not set</span>;
  return <span className={`urg urg-${urgency}`}>{URGENCY_LABEL[urgency]}</span>;
}

export function WoStatusPill({ status, overdue }: { status: WoStatus; overdue?: boolean }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className={`pill pill-${status}`}>{WO_STATUS_LABEL[status]}</span>
      {overdue && <span className="pill pill-overdue">Overdue</span>}
    </span>
  );
}

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function CategoryText({ category }: { category: Category | null }) {
  return <>{category ? CATEGORY_LABEL[category] : 'Uncategorized'}</>;
}

/** The yellow hex marks anything the AI agent did. */
export function AgentMark({ title = 'Done by the AI agent' }: { title?: string }) {
  return (
    <span className="agent-mark" title={title} aria-label={title} role="img">
      <Bot aria-hidden />
    </span>
  );
}

export function AgentWorking({ label = 'AI agent is working on this' }: { label?: string }) {
  return (
    <span className="agent-working" role="status">
      <AgentMark title="AI agent" />
      {label}
    </span>
  );
}

const ACCESS_TEXT: Record<Access, string> = { READ: 'Read', WRITE: 'Write', GATED: 'Needs approval' };
const ACCESS_HELP: Record<Access, string> = {
  READ: 'Looks up data. Changes nothing.',
  WRITE: 'Changes data right away, through the same rules as the app.',
  GATED: 'Never acts on its own. Creates a proposal for a manager to approve.',
};
export function AccessMark({ access }: { access: Access }) {
  const Icon = access === 'READ' ? Eye : access === 'WRITE' ? PenLine : Lock;
  return (
    <span className={`access access-${access}`} title={ACCESS_HELP[access]}>
      <Icon aria-hidden /> {ACCESS_TEXT[access]}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <div className="loading" role="status">{what}…</div>;
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="form-error" role="alert">{message}</div>;
}

/** Fetches a protected photo with the Authorization header and shows it from a blob URL. */
export function AuthPhoto({ id, alt }: { id: string; alt: string }) {
  const token = useAppSelector((s) => s.auth.token);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    fetch(`/api/attachments/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(b);
        setUrl(objectUrl);
      })
      .catch(() => !revoked && setFailed(true));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, token]);
  if (failed) return <span className="faint small" style={{ padding: 8 }}>Photo unavailable</span>;
  if (!url) return <span aria-busy="true" aria-label="Loading photo" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" title="Open full size">
      <img src={url} alt={alt} />
    </a>
  );
}

export function Photos({ photos, alt }: { photos: { id: string }[]; alt: string }) {
  if (!photos.length) return <p className="muted small">No photos attached.</p>;
  return (
    <div className="photos">
      {photos.map((p, i) => <AuthPhoto key={p.id} id={p.id} alt={`${alt}, photo ${i + 1}`} />)}
    </div>
  );
}
