import * as os from 'os';
import * as path from 'path';
// Runs before any module is imported, so config.ts picks these up.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://fixflow:fixflow@localhost:5432/fixflow_test';
process.env.AGENT_WORKER_ENABLED = 'false';
process.env.ANTHROPIC_API_KEY = '';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'fixflow-test-uploads');
process.env.JWT_SECRET = 'test-secret';
process.env.FRONTEND_DIST = path.join(os.tmpdir(), 'fixflow-no-frontend');
