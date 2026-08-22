import { Global, Module, type DynamicModule } from "@nestjs/common";

import type { AuthSetup } from "../auth/auth.setup";
import { DB_POOL } from "../auth/auth.module";
import { HealthController } from "../health.controller";
import { PgBossService } from "../jobs/jobs.module";
import { MailTransportService } from "../modules/mail/mail-transport.service";
import { ObjectStorageService } from "../modules/storage/object-storage.service";
import { ReadinessService } from "./readiness.service";

@Global()
@Module({})
export class HealthModule {
  static forRoot(): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
        {
          provide: ReadinessService,
          inject: [DB_POOL, PgBossService, MailTransportService, ObjectStorageService],
          useFactory: (
            pool: AuthSetup["pool"],
            jobs: PgBossService,
            mail: MailTransportService,
            storage: ObjectStorageService,
          ) =>
            new ReadinessService({
              database: async () => {
                await pool.query("SELECT 1");
              },
              jobs: async () => {
                await jobs.checkReady();
              },
              smtp: async () => {
                await mail.verify();
                return { status: mail.health.status };
              },
              storage: async () => {
                await storage.ensureBucket();
              },
              now: () => new Date(),
            }),
        },
      ],
      exports: [ReadinessService],
    };
  }
}
