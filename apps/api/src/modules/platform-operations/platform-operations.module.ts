import { Module, type DynamicModule } from "@nestjs/common";
import type { Db } from "@markiro/db";

import type { AuthSetup } from "../../auth/auth.setup";
import { DB, DB_POOL } from "../../auth/auth.module";
import type { Env } from "../../env";
import { ReadinessService } from "../../health/readiness.service";
import { PgBossService } from "../../jobs/jobs.module";
import { ObjectStorageService } from "../storage/object-storage.service";
import { MailTransportService } from "../mail/mail-transport.service";
import { PlatformDadataModule } from "../platform-dadata/platform-dadata.module";
import { PlatformDadataService } from "../platform-dadata/platform-dadata.service";
import { PlatformOperationsController } from "./platform-operations.controller";
import {
  DrizzlePlatformOperationsRepository,
  PLATFORM_OPERATIONS_REPOSITORY,
  PlatformOperationsService,
} from "./platform-operations.service";

@Module({})
export class PlatformOperationsModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: PlatformOperationsModule,
      imports: [PlatformDadataModule.forRoot(env)],
      controllers: [PlatformOperationsController],
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
        {
          provide: PLATFORM_OPERATIONS_REPOSITORY,
          inject: [DB],
          useFactory: (db: Db) => new DrizzlePlatformOperationsRepository(db),
        },
        {
          provide: PlatformOperationsService,
          inject: [PLATFORM_OPERATIONS_REPOSITORY, ReadinessService, PlatformDadataService],
          useFactory: (
            repository: DrizzlePlatformOperationsRepository,
            readiness: ReadinessService,
            dadata: PlatformDadataService,
          ) => new PlatformOperationsService(repository, readiness, dadata),
        },
      ],
      exports: [ReadinessService, PlatformOperationsService],
    };
  }
}
