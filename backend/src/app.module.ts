import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { config } from './config';
import { DbModule } from './db/db.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthController } from './auth/auth.controller';
import { AccessService } from './common/access.service';
import { DomainErrorFilter } from './common/domain-error.filter';
import { NotificationsService } from './notifications/notifications.service';
import { NotificationsController } from './notifications/notifications.controller';
import { WorkOrderOps } from './work-orders/work-order.ops';
import { WorkOrdersController } from './work-orders/work-orders.controller';
import { RequestsController } from './requests/requests.controller';
import { ApprovalsController } from './approvals/approvals.controller';
import { MailerService } from './approvals/mailer.service';
import { AdminController } from './admin/admin.controller';
import { AgentController } from './agent/agent.controller';
import { AgentQueue } from './agent/agent-queue.service';
import { AgentRunner } from './agent/agent-runner.service';
import { AgentWorker } from './agent/agent-worker.service';
import { ToolExecutor } from './agent/tool-executor.service';
import { LLM_CLIENT } from './agent/llm/llm.types';
import { AnthropicLlmClient } from './agent/llm/anthropic.client';
import { LocalRulesLlmClient } from './agent/llm/local.client';

@Module({
  imports: [
    DbModule,
    ScheduleModule.forRoot(),
    JwtModule.register({ global: true, secret: config.jwtSecret, signOptions: { expiresIn: '7d' } }),
  ],
  controllers: [AuthController, RequestsController, WorkOrdersController, ApprovalsController, AdminController, AgentController, NotificationsController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
    {
      provide: LLM_CLIENT,
      useFactory: () => (config.anthropicApiKey ? new AnthropicLlmClient(config.anthropicApiKey, config.anthropicModel) : new LocalRulesLlmClient()),
    },
    AccessService, NotificationsService, WorkOrderOps, MailerService,
    AgentQueue, AgentRunner, AgentWorker, ToolExecutor,
  ],
})
export class AppModule {}
