import { Module, type DynamicModule } from "@nestjs/common";
import type { Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { Env } from "../../env";
import { LandingLeadRateLimiter } from "./landing-lead-rate-limiter";
import {
  DEMO_REQUEST_SUBMISSION_ENABLED,
  DemoRequestSubmissionGuard,
} from "../demo-requests/demo-request-submission.guard";
import { DemoRequestTelemetry } from "../demo-requests/demo-request.telemetry";
import { MailDeliveryService } from "../mail/mail-delivery.service";
import { LandingLeadRepository } from "./landing-lead.repository";
import { LandingLeadService } from "./landing-lead.service";
import { LandingLeadPublicErrorFilter, LandingLeadsController } from "./landing-leads.controller";

/**
 * Public intake shares the demo switch and budgets, but persists its own admission
 * counters across API instances and restarts.
 */
@Module({})
export class LandingLeadsModule {
  /** Wire delivery and shared admission with a stable, server-owned source-HMAC secret. */
  static forRoot(env: Env): DynamicModule {
    return {
      module: LandingLeadsModule,
      controllers: [LandingLeadsController],
      providers: [
        DemoRequestTelemetry,
        LandingLeadPublicErrorFilter,
        { provide: DEMO_REQUEST_SUBMISSION_ENABLED, useValue: env.LANDING_DEMO_SUBMISSION_ENABLED },
        DemoRequestSubmissionGuard,
        {
          provide: LandingLeadRateLimiter,
          inject: [DB, DemoRequestTelemetry],
          useFactory: (db: Db, telemetry: DemoRequestTelemetry) =>
            new LandingLeadRateLimiter(
              db,
              {
                windowMs: env.LANDING_DEMO_RATE_WINDOW_SECONDS * 1_000,
                sourceBudget: env.LANDING_DEMO_SOURCE_LIMIT,
                globalBudget: env.LANDING_DEMO_GLOBAL_LIMIT,
                sourceKeySecret: env.PLATFORM_AUTH_SECRET,
              },
              telemetry,
            ),
        },
        {
          provide: LandingLeadRepository,
          inject: [DB, MailDeliveryService],
          useFactory: (db: Db, mail: MailDeliveryService) =>
            new LandingLeadRepository(db, mail, {
              recipient: env.LANDING_DEMO_RECIPIENT ?? "",
              replyTo: env.LANDING_DEMO_REPLY_TO ?? "",
              landingOrigin: env.LANDING_ORIGIN ?? "http://landing-demo-disabled.invalid",
              adminOrigin: env.SAAS_ADMIN_ORIGIN,
            }),
        },
        {
          provide: LandingLeadService,
          inject: [LandingLeadRateLimiter, LandingLeadRepository],
          useFactory: (limiter: LandingLeadRateLimiter, repository: LandingLeadRepository) =>
            new LandingLeadService(
              { enabled: env.LANDING_DEMO_SUBMISSION_ENABLED },
              limiter,
              repository,
            ),
        },
      ],
    };
  }
}
