import 'dotenv/config';
import * as path from 'path';

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://fixflow:fixflow@localhost:5432/fixflow',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  port: Number(process.env.PORT ?? 3000),
  uploadDir: path.resolve(process.env.UPLOAD_DIR ?? './uploads'),
  timezone: process.env.APP_TIMEZONE ?? 'America/Toronto',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  agentWorkerEnabled: bool(process.env.AGENT_WORKER_ENABLED, true),
  agentPollMs: Number(process.env.AGENT_POLL_MS ?? 1500),
  nightlyCron: process.env.NIGHTLY_CRON ?? '0 6 * * *',
  frontendDist: path.resolve(process.env.FRONTEND_DIST ?? path.join(__dirname, '..', '..', 'frontend', 'dist')),
  migrationsDir: path.resolve(process.env.MIGRATIONS_DIR ?? path.join(__dirname, '..', 'migrations')),
};

export type AppConfig = typeof config;
