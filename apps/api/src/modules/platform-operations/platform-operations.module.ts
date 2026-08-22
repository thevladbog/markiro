import { Module, type DynamicModule } from "@nestjs/common";
import type { Db } from "@markiro/db";

import { DB } from "../../auth/auth.module";
import type { Env } from "../../env";
import { ReadinessService } from "../../health/readiness.service";
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
      exports: [PlatformOperationsService],
    };
  }
}
