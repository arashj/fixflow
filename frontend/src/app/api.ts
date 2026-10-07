import { createApi, fetchBaseQuery, type BaseQueryFn, type FetchArgs, type FetchBaseQueryError } from '@reduxjs/toolkit/query/react';
import { signedOut } from './authSlice';
import type {
  AgentRunDetail, AgentRunSummary, AgentStatus, Approval, Asset, Dashboard, DemoAccount, Digest, Notification, Property,
  RequestDetail, RequestSummary, Technician, TechnicianCandidate, User, WorkOrderDetail, WorkOrderSummary, WoStatus, Category, Urgency,
} from './types';

const raw = fetchBaseQuery({
  baseUrl: '/api',
  prepareHeaders: (headers, { getState }) => {
    const token = (getState() as { auth: { token: string | null } }).auth.token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return headers;
  },
});

const baseQuery: BaseQueryFn<string | FetchArgs, unknown, FetchBaseQueryError> = async (args, api, extra) => {
  const res = await raw(args, api, extra);
  const url = typeof args === 'string' ? args : args.url;
  if (res.error?.status === 401 && !url.startsWith('/auth/login')) api.dispatch(signedOut());
  return res;
};

/** Pulls the server's message out of an RTK Query error. */
export function errorMessage(e: unknown): string {
  const err = e as { status?: number | string; data?: { message?: string | string[] } };
  const m = err?.data?.message;
  if (Array.isArray(m)) return m.join('; ');
  if (m) return m;
  if (err?.status === 'FETCH_ERROR') return 'Cannot reach the server. Check your connection and try again.';
  return 'Something went wrong. Try again.';
}

export const api = createApi({
  reducerPath: 'api',
  baseQuery,
  tagTypes: ['Request', 'WorkOrder', 'Approval', 'Run', 'Dashboard', 'Notification', 'Digest', 'Asset'],
  endpoints: (b) => ({
    login: b.mutation<{ token: string; user: User }, { email: string; password: string }>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body }),
    }),
    demoAccounts: b.query<DemoAccount[], void>({ query: () => '/auth/demo-accounts' }),
    agentStatus: b.query<AgentStatus, void>({ query: () => '/agent/status' }),

    requests: b.query<RequestSummary[], { status?: string } | void>({
      query: (a) => ({ url: '/requests', params: a?.status ? { status: a.status } : undefined }),
      providesTags: ['Request'],
    }),
    request: b.query<RequestDetail, string>({ query: (id) => `/requests/${id}`, providesTags: (_r, _e, id) => [{ type: 'Request', id }] }),
    createRequest: b.mutation<{ id: string; agentRunId: string }, FormData>({
      query: (body) => ({ url: '/requests', method: 'POST', body }),
      invalidatesTags: ['Request', 'Dashboard'],
    }),
    retriage: b.mutation<{ id: string }, string>({
      query: (id) => ({ url: `/requests/${id}/retriage`, method: 'POST' }),
      invalidatesTags: ['Request', 'Run'],
    }),
    triageManually: b.mutation<void, { id: string; category: Category; urgency: Urgency; assetId?: string | null }>({
      query: ({ id, ...body }) => ({ url: `/requests/${id}/triage`, method: 'POST', body }),
      invalidatesTags: ['Request', 'Dashboard'],
    }),
    rejectRequest: b.mutation<void, { id: string; reason: string }>({
      query: ({ id, reason }) => ({ url: `/requests/${id}/reject`, method: 'POST', body: { reason } }),
      invalidatesTags: ['Request', 'Dashboard'],
    }),

    workOrders: b.query<WorkOrderSummary[], { status?: string; overdue?: boolean } | void>({
      query: (a) => ({ url: '/work-orders', params: { ...(a?.status ? { status: a.status } : {}), ...(a?.overdue ? { overdue: 'true' } : {}) } }),
      providesTags: ['WorkOrder'],
    }),
    workOrder: b.query<WorkOrderDetail, string>({ query: (id) => `/work-orders/${id}`, providesTags: (_r, _e, id) => [{ type: 'WorkOrder', id }] }),
    createWorkOrder: b.mutation<{ id: string }, { requestId: string; title: string; description: string; priority: Urgency }>({
      query: (body) => ({ url: '/work-orders', method: 'POST', body }),
      invalidatesTags: ['Request', 'WorkOrder', 'Dashboard'],
    }),
    candidates: b.query<TechnicianCandidate[], string>({ query: (id) => `/work-orders/${id}/technicians`, providesTags: ['WorkOrder'] }),
    assign: b.mutation<void, { id: string; technicianId: string }>({
      query: ({ id, technicianId }) => ({ url: `/work-orders/${id}/assign`, method: 'POST', body: { technicianId } }),
      invalidatesTags: ['WorkOrder', 'Request', 'Dashboard'],
    }),
    setStatus: b.mutation<void, { id: string; status: WoStatus; note?: string; resolutionNotes?: string }>({
      query: ({ id, ...body }) => ({ url: `/work-orders/${id}/status`, method: 'POST', body }),
      invalidatesTags: ['WorkOrder', 'Request', 'Dashboard', 'Approval'],
    }),
    comment: b.mutation<void, { id: string; text: string }>({
      query: ({ id, text }) => ({ url: `/work-orders/${id}/comments`, method: 'POST', body: { text } }),
      invalidatesTags: (_r, _e, a) => [{ type: 'WorkOrder', id: a.id }],
    }),

    approvals: b.query<Approval[], string | void>({ query: (status) => ({ url: '/approvals', params: { status: status ?? 'PENDING' } }), providesTags: ['Approval'] }),
    approve: b.mutation<void, { id: string; note?: string; subject?: string; body?: string }>({
      query: ({ id, ...body }) => ({ url: `/approvals/${id}/approve`, method: 'POST', body }),
      invalidatesTags: ['Approval', 'WorkOrder', 'Dashboard', 'Notification'],
    }),
    reject: b.mutation<void, { id: string; note?: string }>({
      query: ({ id, ...body }) => ({ url: `/approvals/${id}/reject`, method: 'POST', body }),
      invalidatesTags: ['Approval', 'WorkOrder', 'Dashboard'],
    }),

    runs: b.query<AgentRunSummary[], string | void>({ query: (type) => ({ url: '/agent/runs', params: type ? { type } : undefined }), providesTags: ['Run'] }),
    run: b.query<AgentRunDetail, string>({ query: (id) => `/agent/runs/${id}`, providesTags: (_r, _e, id) => [{ type: 'Run', id }] }),
    runNightly: b.mutation<{ runs: { id: string; propertyId: string; existing: boolean }[] }, void>({
      query: () => ({ url: '/agent/nightly', method: 'POST' }),
      invalidatesTags: ['Run'],
    }),

    dashboard: b.query<Dashboard, void>({ query: () => '/dashboard', providesTags: ['Dashboard'] }),
    digests: b.query<Digest[], void>({ query: () => '/digests', providesTags: ['Digest'] }),
    properties: b.query<Property[], void>({ query: () => '/properties' }),
    assets: b.query<Asset[], string | void>({ query: (propertyId) => ({ url: '/assets', params: propertyId ? { propertyId } : undefined }), providesTags: ['Asset'] }),
    technicians: b.query<Technician[], void>({ query: () => '/technicians', providesTags: ['WorkOrder'] }),

    notifications: b.query<{ items: Notification[]; unread: number }, void>({ query: () => '/notifications', providesTags: ['Notification'] }),
    markRead: b.mutation<void, string>({ query: (id) => ({ url: `/notifications/${id}/read`, method: 'POST' }), invalidatesTags: ['Notification'] }),
    markAllRead: b.mutation<void, void>({ query: () => ({ url: '/notifications/read-all', method: 'POST' }), invalidatesTags: ['Notification'] }),
  }),
});

export const {
  useLoginMutation, useDemoAccountsQuery, useAgentStatusQuery,
  useRequestsQuery, useRequestQuery, useCreateRequestMutation, useRetriageMutation, useTriageManuallyMutation, useRejectRequestMutation,
  useWorkOrdersQuery, useWorkOrderQuery, useCreateWorkOrderMutation, useCandidatesQuery, useAssignMutation, useSetStatusMutation, useCommentMutation,
  useApprovalsQuery, useApproveMutation, useRejectMutation,
  useRunsQuery, useRunQuery, useRunNightlyMutation,
  useDashboardQuery, useDigestsQuery, usePropertiesQuery, useAssetsQuery, useTechniciansQuery,
  useNotificationsQuery, useMarkReadMutation, useMarkAllReadMutation,
} = api;
