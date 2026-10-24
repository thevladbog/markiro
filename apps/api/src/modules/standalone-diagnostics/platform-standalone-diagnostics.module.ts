import { ReleaseCatalogModule } from "../release-catalog/release-catalog.module";
import { CatalogService } from "../release-catalog/catalog-service";
import { CatalogRepository } from "../release-catalog/catalog-repository";
import { Logger, Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { PlatformAuditModule } from "../../platform-auth/platform-audit.module";
import { PlatformStandaloneDiagnosticsController } from "./platform-standalone-diagnostics.controller";
import { StandaloneDiagnosticsRetention } from "./standalone-diagnostics-retention";
import { standaloneLatestBuildSource } from "../standalone-releases/release-runtime";
import {
  STANDALONE_DIAGNOSTICS_CLOCK,
  STANDALONE_LATEST_BUILD,
  StandaloneDiagnosticsService,
} from "./standalone-diagnostics.service";
import {
  configureStandaloneSupportKeys,
  STANDALONE_SUPPORT_KEYS,
  supportKeyKidMismatches,
} from "./standalone-support-keys";

/** Registered alongside the platform auth module (next to the licensing module). */
@Module({})
export class PlatformStandaloneDiagnosticsModule {
  static forRoot(env: Env, catalogModule = ReleaseCatalogModule.forRoot(env)): DynamicModule {
    const keys = configureStandaloneSupportKeys(env);
    for (const kid of supportKeyKidMismatches(keys ?? []))
      new Logger(PlatformStandaloneDiagnosticsModule.name).warn(
        `Support key ${kid} differs from the id derived from its public point`,
      );
    return {
      module: PlatformStandaloneDiagnosticsModule,
      imports: [PlatformAuditModule, catalogModule],
      controllers: [PlatformStandaloneDiagnosticsController],
      exports: [StandaloneDiagnosticsService],
      providers: [
        { provide: STANDALONE_SUPPORT_KEYS, useValue: keys },
        { provide: STANDALONE_DIAGNOSTICS_CLOCK, useValue: () => new Date() },
        {
          provide: STANDALONE_LATEST_BUILD,
          inject: [CatalogService, CatalogRepository],
          useFactory: (catalog: CatalogService | null, repository: CatalogRepository) =>
            standaloneLatestBuildSource(catalog ? repository : null),
        },
        StandaloneDiagnosticsService,
        StandaloneDiagnosticsRetention,
      ],
    };
  }
}
