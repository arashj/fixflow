import { config } from '../config';

/** Today's date (YYYY-MM-DD) in the app time zone. */
export function todayInAppTz(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
