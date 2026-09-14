import { Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { PlatformAuditModule } from "../../platform-auth/platform-audit.module";
import { GRANT_SIGNING_CONFIGURATION, configureGrantSigning } from "./grant-keyset";
import { PlatformGrantReadinessController } from "./platform-grant-readiness.controller";
import { PlatformGrantReadinessService } from "./platform-grant-readiness.service";
import { PlatformGrantActivationController } from "./platform-grant-activation.controller";
import { PlatformGrantActivationService } from "./platform-grant-activation.service";
import { PlatformGrantRollbackController } from "./platform-grant-rollback.controller";
import { PlatformGrantRollbackService } from "./platform-grant-rollback.service";

@Module({})
export class PlatformGrantReadinessModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: PlatformGrantReadinessModule,
      imports: [PlatformAuditModule],
      controllers: [
        PlatformGrantReadinessController,
        PlatformGrantActivationController,
        PlatformGrantRollbackController,
      ],
      providers: [
        { provide: GRANT_SIGNING_CONFIGURATION, useValue: configureGrantSigning(env) },
        PlatformGrantReadinessService,
        PlatformGrantActivationService,
        PlatformGrantRollbackService,
      ],
    };
  }
}
