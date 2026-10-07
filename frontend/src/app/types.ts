export type Role = 'MANAGER' | 'TECHNICIAN' | 'TENANT';
export type Category = 'PLUMBING' | 'ELECTRICAL' | 'HVAC' | 'APPLIANCE' | 'STRUCTURAL' | 'PEST' | 'GENERAL';
export type Urgency = 'LOW' | 'NORMAL' | 'HIGH' | 'EMERGENCY';
export type WoStatus = 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
export type RequestStatus = 'NEW' | 'TRIAGING' | 'TRIAGED' | 'CONVERTED' | 'DUPLICATE' | 'REJECTED';
export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type Access = 'READ' | 'WRITE' | 'GATED';

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: Role;
}

export interface DemoAccount {
  email: string;
  fullName: string;
  role: Role;
  detail: string | null;
}

export interface RequestSummary {
  id: string;
  title: string;
  status: RequestStatus;
  category: Category | null;
  urgency: Urgency | null;
  createdAt: string;
  propertyId: string;
  propertyName: string;
  unitLabel: string | null;
  submittedByName: string;
  workOrderId: string | null;
  workOrderStatus: WoStatus | null;
  photoCount: number;
  agentStatus: RunStatus | null;
}

export interface RequestDetail {
  id: string;
  title: string;
  description: string;
  status: RequestStatus;
  category: Category | null;
  urgency: Urgency | null;
  triageRationale: string | null;
  createdAt: string;
  updatedAt: string;
  propertyId: string;
  propertyName: string;
  unitId: string | null;
  unitLabel: string | null;
  submittedByName: string;
  assetId: string | null;
  assetName: string | null;
  duplicateOfId: string | null;
  duplicateOfTitle: string | null;
  workOrderId: string | null;
  workOrderStatus: WoStatus | null;
  workOrderDueAt: string | null;
  technicianName: string | null;
  photos: { id: string }[];
  agentRuns: { id: string; status: RunStatus; createdAt: string; summary?: string; error?: string }[];
}

export interface WorkOrderSummary {
  id: string;
  title: string;
  status: WoStatus;
  priority: Urgency;
  category: Category;
  dueAt: string | null;
  createdAt: string;
  completedAt: string | null;
  requestId: string | null;
  source: 'REQUEST' | 'PREVENTIVE';
  createdByAgent: boolean;
  overdue: boolean;
  propertyId: string;
  propertyName: string;
  unitLabel: string | null;
  assetName: string | null;
  technicianId: string | null;
  technicianName: string | null;
}

export interface WorkOrderEvent {
  id: string;
  actorType: 'USER' | 'AGENT' | 'SYSTEM';
  eventType: string;
  payload: Record<string, any>;
  createdAt: string;
  agentRunId: string | null;
  actorName: string | null;
}

export interface WorkOrderDetail extends WorkOrderSummary {
  description: string;
  resolutionNotes: string | null;
  assetId: string | null;
  createdByAgentRunId: string | null;
  requestTitle: string | null;
  requestDescription: string | null;
  triageRationale: string | null;
  submittedByName: string | null;
  assetMake: string | null;
  assetModel: string | null;
  vendorName: string | null;
  events: WorkOrderEvent[];
  photos: { id: string }[];
  approvals: { id: string; actionType: string; status: string; rationale: string; createdAt: string }[];
}

export interface TechnicianCandidate {
  technician_id: string;
  name: string;
  capacity: number;
  open_work_orders: number;
  unavailable_now: boolean;
}

export interface Approval {
  id: string;
  actionType: 'SEND_VENDOR_EMAIL' | 'CLOSE_WORK_ORDER' | 'CANCEL_WORK_ORDER' | 'REASSIGN_IN_PROGRESS';
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'EXECUTED' | 'FAILED';
  payload: Record<string, any>;
  rationale: string;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  decidedByName: string | null;
  runId: string;
  workOrderId: string;
  workOrderTitle: string;
  workOrderStatus: WoStatus;
  propertyName: string;
  currentTechnicianName: string | null;
  newTechnicianName: string | null;
}

export interface AgentRunSummary {
  id: string;
  runType: 'TRIAGE' | 'NIGHTLY_DIGEST' | 'MANUAL';
  status: RunStatus;
  attempts: number;
  model: string | null;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  summary: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  triggerRef: string;
  subject: string | null;
  propertyName: string | null;
}

export interface AgentStep {
  seq: number;
  stepType: 'MODEL_TEXT' | 'TOOL_CALL' | 'TOOL_RESULT' | 'ERROR';
  toolName: string | null;
  toolUseId: string | null;
  toolInput: Record<string, any> | null;
  toolOutput: Record<string, any> | null;
  text: string | null;
  durationMs: number | null;
  createdAt: string;
  access?: Access;
}

export interface AgentRunDetail extends AgentRunSummary {
  maxAttempts: number;
  steps: AgentStep[];
}

export interface DigestItem {
  type: 'OVERDUE' | 'PM_CREATED' | 'REPEAT_FAILURE' | 'UNASSIGNED' | 'APPROVAL_PENDING' | 'NOTE';
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  title: string;
  detail?: string;
  ref_type?: 'WORK_ORDER' | 'ASSET' | 'REQUEST' | 'APPROVAL';
  ref_id?: string;
}

export interface Digest {
  id: string;
  digestDate: string;
  summary: string;
  items: DigestItem[];
  createdAt: string;
  runId: string;
  propertyId: string;
  propertyName: string;
}

export interface Dashboard {
  stats: {
    requestsWaiting: number;
    openWorkOrders: number;
    overdue: number;
    unassigned: number;
    openEmergencies: number;
    completedThisWeek: number;
    pendingApprovals: number;
  };
  agent: {
    runs30d: number;
    succeeded30d: number;
    failed30d: number;
    avgTriageSeconds: number | null;
    workOrdersCreated30d: number;
    autoAssigned30d: number;
  };
  recentRuns: { id: string; runType: string; status: RunStatus; summary: string | null; createdAt: string; subject: string | null }[];
  workload: { id: string; name: string; capacity: number; open: number }[];
}

export interface Property {
  id: string;
  name: string;
  address: string;
  units: { id: string; label: string; tenantName: string | null }[];
}

export interface Asset {
  id: string;
  name: string;
  category: Category;
  make: string | null;
  model: string | null;
  installedOn: string | null;
  vendorName: string | null;
  vendorEmail: string | null;
  propertyId: string;
  propertyName: string;
  unitLabel: string | null;
  repairs90d: number;
  openWorkOrders: number;
  pmSchedules: { id: string; title: string; intervalDays: number; nextDueOn: string; active: boolean }[];
}

export interface Technician {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  active: boolean;
  capacity: number;
  skills: Category[];
  properties: string[];
  open: number;
  nextUnavailability: { startsAt: string; endsAt: string; reason: string | null } | null;
}

export interface Notification {
  id: string;
  kind: 'EMERGENCY' | 'ASSIGNMENT' | 'APPROVAL_NEEDED' | 'DIGEST' | 'STATUS';
  title: string;
  body: string;
  linkPath: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface AgentStatus {
  mode: 'claude' | 'local';
  model: string;
  demoResets?: boolean;
}
