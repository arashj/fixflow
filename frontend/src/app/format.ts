import type { Category, RequestStatus, Urgency, WoStatus } from './types';

export const CATEGORY_LABEL: Record<Category, string> = {
  PLUMBING: 'Plumbing', ELECTRICAL: 'Electrical', HVAC: 'Heating & cooling', APPLIANCE: 'Appliance',
  STRUCTURAL: 'Building', PEST: 'Pest control', GENERAL: 'General',
};
export const URGENCY_LABEL: Record<Urgency, string> = { EMERGENCY: 'Emergency', HIGH: 'High', NORMAL: 'Normal', LOW: 'Low' };
export const WO_STATUS_LABEL: Record<WoStatus, string> = {
  OPEN: 'Unassigned', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress', ON_HOLD: 'On hold', COMPLETED: 'Done', CANCELLED: 'Cancelled',
};
export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  NEW: 'Waiting for triage', TRIAGING: 'AI is triaging', TRIAGED: 'Triaged', CONVERTED: 'Work order created', DUPLICATE: 'Merged', REJECTED: 'Closed',
};

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff < 0 ? 'just now' : 'in under a minute';
  if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86400_000) return rtf.format(Math.round(diff / 3600_000), 'hour');
  if (abs < 30 * 86400_000) return rtf.format(Math.round(diff / 86400_000), 'day');
  return dateTime(iso);
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function dateOnly(iso: string | null | undefined): string {
  if (!iso) return '';
  // Date-only strings (YYYY-MM-DD) are calendar dates: format without a time-zone shift
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function plural(n: number, word: string, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}
