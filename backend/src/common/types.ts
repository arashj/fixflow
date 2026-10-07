export type Role = 'MANAGER' | 'TECHNICIAN' | 'TENANT';
export const CATEGORIES = ['PLUMBING', 'ELECTRICAL', 'HVAC', 'APPLIANCE', 'STRUCTURAL', 'PEST', 'GENERAL'] as const;
export type Category = (typeof CATEGORIES)[number];
export const URGENCIES = ['LOW', 'NORMAL', 'HIGH', 'EMERGENCY'] as const;
export type Urgency = (typeof URGENCIES)[number];
export const WO_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const;
export type WoStatus = (typeof WO_STATUSES)[number];
export const OPEN_WO_STATUSES: WoStatus[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
}

/** Default due time after creation, by priority. */
export const DUE_HOURS: Record<Urgency, number> = { EMERGENCY: 4, HIGH: 24, NORMAL: 72, LOW: 168 };
