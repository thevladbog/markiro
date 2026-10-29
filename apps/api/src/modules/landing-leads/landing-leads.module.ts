import { Module, type DynamicModule } from "@nestjs/common";
import type { Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { Env } from "../../env";
import { DemoRequestRateLimiter } from "../demo-requests/demo-request-rate-limiter";
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
 * Public intake `POST /api/landing-leads` (spec §15.3). It shares the demo form's switch,
 * rate-limit settings; the limiter instance is its own.
 */
@Module({})
export class LandingLeadsModule {
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
          provide: DemoRequestRateLimiter,
          inject: [DemoRequestTelemetry],
          useFactory: (telemetry: DemoRequestTelemetry) =>
            new DemoRequestRateLimiter(
              {
                windowMs: env.LANDING_DEMO_RATE_WINDOW_SECONDS * 1_000,
                sourceBudget: env.LANDING_DEMO_SOURCE_LIMIT,
                globalBudget: env.LANDING_DEMO_GLOBAL_LIMIT,
                maxTrackedWindows: 10_000,
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
          inject: [DemoRequestRateLimiter, LandingLeadRepository],
          useFactory: (limiter: DemoRequestRateLimiter, repository: LandingLeadRepository) =>
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
