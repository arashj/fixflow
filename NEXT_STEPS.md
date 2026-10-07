# Status and next steps

Handoff notes for whoever (human or AI session) picks this up next.

## Done and verified

- Backend (NestJS + Postgres): auth, roles, row-level access, requests with photo upload, work orders, approvals, notifications, digest, dashboard.
- Agent: 19 tools, READ/WRITE/GATED enforcement, property scoping, run-type allowlist, job queue with leases and retries, nightly scheduler, Claude client and local rules engine.
- Frontend (React 19 + RTK Query): every screen for tenant, technician and manager, desktop and mobile.
- 40 backend tests passing against real Postgres.
- Full browser walkthrough of all three roles (Playwright, desktop + mobile): no console errors, no failed API calls.
- Production-only dependency run (dev deps pruned) boots, migrates, seeds and runs the agent.

## Not verified in the build environment

These were written but could not be run where the app was built (network policy blocked the registries):

1. **Claude mode against the live API.** No API key was available. The code uses the official SDK and standard tool-use format, and a test confirms photos are sent as image blocks. To check: set `ANTHROPIC_API_KEY` in `backend/.env`, restart, submit a request, and read the trace under Agent activity.
2. **`docker build` / `docker compose up`.** Docker Hub was unreachable. The image layout was simulated (pruned production deps) and works. First real build may need small fixes.
3. **GitHub Actions CI** (`.github/workflows/ci.yml`): not run yet.

## Suggested next steps, in order

1. Run Claude mode once and tune `backend/src/agent/prompts.ts` against real traces.
2. Deploy (Render, Railway or Fly with managed Postgres) and put the live URL plus demo logins in the README and the Upwork listing.
3. Record a 2-minute walkthrough following "Try it in two minutes" in the README.
4. Replace the dev mail transport in `backend/src/approvals/mailer.service.ts` with SMTP or Resend.
5. Move photo storage from local disk to S3-compatible storage.
6. Nice to have: manager screens to add buildings, units, equipment and technicians (today they come from `backend/src/db/seed.ts`); frontend component tests.

## Gotchas

- Tests need the `fixflow_test` database (or `TEST_DATABASE_URL`). They drop and recreate its schema.
- `npm run seed` wipes all app data and reloads the demo set.
- Jest resolves `./x` to `x.json` before `x.ts`, which is why the tool file is `tool-definitions.json`, not `tools.json`.
- In SQL, reusing one parameter as two types (e.g. `$2` compared to a literal and assigned to a varchar column) fails at runtime with "inconsistent types deduced". Cast explicitly (`$2::varchar`).
