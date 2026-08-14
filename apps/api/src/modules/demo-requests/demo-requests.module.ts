import { Module, type DynamicModule } from "@nestjs/common";
import { DB } from "../../auth/auth.module";
import type { Env } from "../../env";
import { MailDeliveryService } from "../mail/mail-delivery.service";
import { DemoRequestCaptchaService } from "./demo-request-captcha.service";
import { DemoRequestRateLimiter } from "./demo-request-rate-limiter";
import { DemoRequestRepository } from "./demo-request.repository";
import { DemoRequestService } from "./demo-request.service";
import { DemoRequestsController } from "./demo-requests.controller";
import type { Db } from "@markiro/db";

@Module({})
export class DemoRequestsModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: DemoRequestsModule,
      controllers: [DemoRequestsController],
      providers: [
        {
          provide: DemoRequestRateLimiter,
          useFactory: () =>
            new DemoRequestRateLimiter({
              windowMs: env.LANDING_DEMO_RATE_WINDOW_SECONDS * 1_000,
              sourceBudget: env.LANDING_DEMO_SOURCE_LIMIT,
              globalBudget: env.LANDING_DEMO_GLOBAL_LIMIT,
              maxTrackedWindows: 10_000,
            }),
        },
        {
          provide: DemoRequestCaptchaService,
          useFactory: () =>
            new DemoRequestCaptchaService({
              serverKey: env.SMARTCAPTCHA_SERVER_KEY ?? "",
              landingOrigin: env.LANDING_ORIGIN ?? "http://landing-demo-disabled.invalid",
            }),
        },
        {
          provide: DemoRequestRepository,
          inject: [DB, MailDeliveryService],
          useFactory: (db: Db, mail: MailDeliveryService) =>
            new DemoRequestRepository(db, mail, {
              recipient: env.LANDING_DEMO_RECIPIENT ?? "",
              replyTo: env.LANDING_DEMO_REPLY_TO ?? "",
            }),
        },
        {
          provide: DemoRequestService,
          inject: [DemoRequestRateLimiter, DemoRequestCaptchaService, DemoRequestRepository],
          useFactory: (
            limiter: DemoRequestRateLimiter,
            captcha: DemoRequestCaptchaService,
            repository: DemoRequestRepository,
          ) =>
            new DemoRequestService(
              {
                enabled: env.LANDING_DEMO_SUBMISSION_ENABLED,
                consentVersion: env.LANDING_DEMO_CONSENT_VERSION,
              },
              limiter,
              captcha,
              repository,
            ),
        },
      ],
    };
  }
}
