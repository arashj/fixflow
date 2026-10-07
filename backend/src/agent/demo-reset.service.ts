import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { Db } from '../db/db.service';
import { seed } from '../db/seed';

/** For the public demo: visitors change data, so it is reloaded on a schedule (DEMO_RESET_CRON). */
@Injectable()
export class DemoResetService implements OnApplicationBootstrap {
  private readonly log = new Logger('DemoReset');
  constructor(private db: Db, private scheduler: SchedulerRegistry) {}

  onApplicationBootstrap() {
    if (!config.demoResetCron) return;
    const job = new CronJob(config.demoResetCron, () => void this.reset().catch((e) => this.log.error(e)), null, true, config.timezone);
    this.scheduler.addCronJob('demo-reset', job as any);
    this.log.log(`Demo data resets on "${config.demoResetCron}" (${config.timezone})`);
  }

  async reset() {
    await seed(this.db.pool);
    if (fs.existsSync(config.uploadDir)) {
      for (const f of fs.readdirSync(config.uploadDir)) fs.rmSync(path.join(config.uploadDir, f), { force: true });
    }
    this.log.log('Demo data reloaded');
  }
}
