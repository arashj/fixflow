# FixFlow

Maintenance requests for small property managers, run by an AI agent.

A tenant reports a problem with a photo. Within seconds an agent triages it (category, urgency, which piece of equipment), checks whether it duplicates an open report, creates the work order, and assigns the best available technician. Every morning it checks each building, schedules preventive maintenance, spots equipment that keeps failing, and writes the manager a digest. Anything risky (emailing a vendor, closing or cancelling work, reassigning a job in progress) is only *proposed*: the manager approves it with one click.

Every agent step is recorded and shown in the UI, with what the agent looked up, what it changed, and why.

## Try it in two minutes

1. Sign in as **Emma Wilson** (tenant) and report a problem, e.g. "Bathroom sink pipe leaking", with a photo.
2. Watch the request page: the agent triages it and a technician appears within seconds.
3. Sign out and sign in as **Maya Chen** (manager). Open the request, then **See agent steps** to read the full trace.
4. Go to **Daily digest** and press **Run the check now**. Then open **Approvals**: edit and send the drafted vendor email, and close the job the technician finished but never closed.
5. Sign in as **Luis Ortega** (technician), start a job and mark it done. Emma gets a notification.

All demo accounts use the password `demo1234`.

## What's in it

| | |
|---|---|
| **Tenants** | Report problems with up to 4 photos, follow progress, get notified at each step |
| **Technicians** | Job queue sorted by urgency, start / hold / complete with resolution notes (mobile friendly) |
| **Managers** | Overview, requests, work orders, approvals, daily digest, agent activity, equipment and preventive schedules, technician workload |
| **Agent** | Triage on every new request; nightly check per building; 19 tools; human approval for risky actions |

## How the agent works

```
tenant submits ──► maintenance_request + agent_run (QUEUED)   ◄── nightly cron queues one run per building
                                  │
                     AgentWorker  │  claims jobs with FOR UPDATE SKIP LOCKED + a 5-minute lease,
                                  │  retries with backoff (3 attempts), hands failures back to a human
                                  ▼
                     AgentRunner: system prompt + context (+ photos) ──► LLM ──► tool_use
                                  │                                         ▲
                                  ▼                                         │ tool_result
                     ToolExecutor ── validates input against the JSON schema
                                  ── checks the tool is allowed for this run type
                                  ── checks every id belongs to the run's building
                                  ── READ:  query only
                                  ── WRITE: runs in a transaction through the same domain rules as the API
                                  ── GATED: never acts; inserts an approval for the manager
                                  │
                     every model turn, tool call and result ──► agent_step (the audit trail in the UI)
```

The guarantees live in code, not in the prompt. The test suite proves the agent cannot run a tool outside its run type, touch another building, change a different request than the one it was started for, assign an unqualified technician, or execute a gated action.

**Two LLM modes.** With `ANTHROPIC_API_KEY` set, the agent uses Claude (Messages API with tool use, photos sent as image blocks). Without a key it uses a built-in rules engine that speaks the same protocol, so the app is fully usable offline and every trace looks the same. The rules engine does not look at photos.

Tool definitions: `backend/src/agent/tool-definitions.json`. Prompts: `backend/src/agent/prompts.ts`.

## Stack

- **Backend:** NestJS 11, TypeScript, PostgreSQL 16 (plain SQL migrations, no ORM), JWT auth with roles, Anthropic SDK, `@nestjs/schedule`
- **Frontend:** React 19, TypeScript, Redux Toolkit + RTK Query, React Router 7, Vite
- **Ops:** Docker multi-stage image (API + built frontend on one port), docker compose, GitHub Actions CI

## Run it locally

Requirements: Node 22+, PostgreSQL 16.

```bash
# 1. Database
createuser -s fixflow 2>/dev/null; psql -c "ALTER ROLE fixflow PASSWORD 'fixflow'"
createdb -O fixflow fixflow && createdb -O fixflow fixflow_test

# 2. Backend
cd backend
cp .env.example .env            # add ANTHROPIC_API_KEY to use Claude
npm install
npm run build
npm run seed                    # runs migrations, loads demo data, queues two triage runs
npm start                       # http://localhost:3000

# 3. Frontend (development, hot reload, proxies /api to :3000)
cd ../frontend
npm install
npm run dev                     # http://localhost:5173
```

To serve everything from one port instead, run `npm run build` in `frontend/`; the backend serves `frontend/dist` automatically.

With Docker:

```bash
docker compose up --build
docker compose run --rm app node dist/db/seed-cli.js
```

### Environment

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | `postgres://fixflow:fixflow@localhost:5432/fixflow` | |
| `JWT_SECRET` | dev value | **Set in production** |
| `ANTHROPIC_API_KEY` | empty | Empty = local rules engine |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | |
| `AGENT_WORKER_ENABLED` | `true` | Turn off on web-only instances |
| `NIGHTLY_CRON` | `0 6 * * *` | Runs in `APP_TIMEZONE` |
| `APP_TIMEZONE` | `America/Toronto` | |
| `UPLOAD_DIR` | `./uploads` | Photo storage |

## Tests

```bash
cd backend && npm test          # 40 tests against a real Postgres (fixflow_test)
```

Covers auth and row-level access, the full triage flow, emergencies, duplicates, the no-technician fallback, photo validation, the nightly check (and that running it twice changes nothing), approvals executing exactly once and failing safely when the work order changed, every agent guardrail, worker retries and lease takeover, concurrent job claiming, and the technician state machine.

## Project layout

```
backend/
  migrations/              V1 schema, V2 vendors + email outbox
  src/agent/               queue, worker, runner, tool executor, prompts, LLM clients
  src/work-orders/         domain rules shared by the API and the agent
  src/requests/            tenant submissions and photo uploads
  src/approvals/           approval execution + email outbox
  test/                    e2e and unit tests
frontend/src/
  pages/                   one file per screen
  app/api.ts               RTK Query endpoints
```

## Known limits

- Vendor emails go to an outbox table and are logged by a dev transport; plug SMTP or SES into `MailerService.drain()`.
- Photos are stored on local disk; swap for S3/MinIO for multi-instance deployments.
- No sign-up or account management screens; accounts come from the seed script.
