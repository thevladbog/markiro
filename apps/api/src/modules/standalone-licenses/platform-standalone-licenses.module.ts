import { ReleaseCatalogModule } from "../release-catalog/release-catalog.module";
import { PlatformStandaloneDiagnosticsModule } from "../standalone-diagnostics/platform-standalone-diagnostics.module";
import { Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { PlatformAuditModule } from "../../platform-auth/platform-audit.module";
import { STANDALONE_LICENSE_CLOCK } from "./standalone-license-authority";
import { StandaloneLicenseIssuanceService } from "./standalone-license-issuance.service";
import {
  configureStandaloneLicenseSigning,
  STANDALONE_LICENSE_SIGNING,
} from "./standalone-license-keyset";
import { PlatformStandaloneLicensesController } from "./platform-standalone-licenses.controller";
import { StandaloneSitesService } from "./standalone-sites.service";

/** Registered only alongside the platform auth module; EntitlementsService comes from SubscriptionsModule. */
@Module({})
export class PlatformStandaloneLicensesModule {
  static forRoot(env: Env, catalogModule = ReleaseCatalogModule.forRoot(env)): DynamicModule {
    return {
      module: PlatformStandaloneLicensesModule,
      imports: [
        PlatformAuditModule,
        PlatformStandaloneDiagnosticsModule.forRoot(env, catalogModule),
      ],
      controllers: [PlatformStandaloneLicensesController],
      providers: [
        { provide: STANDALONE_LICENSE_SIGNING, useValue: configureStandaloneLicenseSigning(env) },
        { provide: STANDALONE_LICENSE_CLOCK, useValue: () => new Date() },
        StandaloneSitesService,
        StandaloneLicenseIssuanceService,
      ],
    };
  }
}
