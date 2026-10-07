import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';
import { AppModule } from './app.module';
import { Db } from './db/db.service';
import { migrate } from './db/migrate';
import { seed } from './db/seed';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  app.set('trust proxy', 1);
  const pool = app.get(Db).pool;
  await migrate(pool, config.migrationsDir, (m) => Logger.log(m, 'Migrations'));
  if (config.seedOnEmpty && !(await pool.query('SELECT 1 FROM app_user LIMIT 1')).rowCount) {
    await seed(pool);
    Logger.log('Empty database: loaded demo data', 'Bootstrap');
  }

  // Serve the built React app (if present) from the same origin, with SPA fallback.
  const index = path.join(config.frontendDist, 'index.html');
  if (fs.existsSync(index)) {
    app.useStaticAssets(config.frontendDist, { index: false, maxAge: '1h' });
    app.getHttpAdapter().getInstance().get(/^(?!\/api\/).*/, (_req: any, res: any) => res.sendFile(index));
    Logger.log(`Serving frontend from ${config.frontendDist}`, 'Bootstrap');
  }
  await app.listen(config.port);
  Logger.log(`FixFlow API listening on http://localhost:${config.port}`, 'Bootstrap');
}
bootstrap();
