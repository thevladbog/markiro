import { Global, Module, type DynamicModule } from "@nestjs/common";
import type { PlatformAuth } from "@markiro/db";
import { PlatformAuthGuard } from "./platform-auth.guard";
import { PlatformAuditService } from "./platform-audit.service";
import { PlatformMeController } from "./platform-me.controller";
import { PLATFORM_AUTH } from "./platform-auth.setup";
import {
  PLATFORM_ACTIVATION_BASE_URL,
  PlatformActivationService,
} from "./platform-activation.service";
import { PlatformActivationController } from "./platform-activation.controller";
import { PlatformTeamController } from "./platform-team.controller";
import { PlatformTeamService } from "./platform-team.service";
import { PlatformAuditController } from "./platform-audit.controller";

export { PLATFORM_AUTH } from "./platform-auth.setup";

@Global()
@Module({})
export class PlatformAuthModule {
  static forRoot(auth: PlatformAuth, activationBaseUrl: string): DynamicModule {
    return {
      module: PlatformAuthModule,
      controllers: [
        PlatformMeController,
        PlatformActivationController,
        PlatformTeamController,
        PlatformAuditController,
      ],
      providers: [
        { provide: PLATFORM_AUTH, useValue: auth },
        PlatformAuthGuard,
        PlatformAuditService,
        PlatformActivationService,
        PlatformTeamService,
        { provide: PLATFORM_ACTIVATION_BASE_URL, useValue: activationBaseUrl },
      ],
      exports: [
        PLATFORM_AUTH,
        PlatformAuthGuard,
        PlatformAuditService,
        PlatformActivationService,
        PlatformTeamService,
      ],
    };
  }
}
