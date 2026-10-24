import { Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { PlatformAuditModule } from "../../platform-auth/platform-audit.module";
import { PlatformStandaloneReleasesController } from "./platform-standalone-releases.controller";
import { createStandaloneReleasesRuntime } from "./release-runtime";
import { ReleaseCatalogModule } from "../release-catalog/release-catalog.module";
import {
  STANDALONE_RELEASES,
  STANDALONE_RELEASES_CLOCK,
  StandaloneReleasesService,
} from "./standalone-releases.service";

/** Registered alongside the platform auth module; unconfigured storage only empties the section. */
@Module({})
export class PlatformStandaloneReleasesModule {
  static forRoot(env: Env, catalogModule = ReleaseCatalogModule.forRoot(env)): DynamicModule {
    return {
      module: PlatformStandaloneReleasesModule,
      imports: [PlatformAuditModule, catalogModule],
      controllers: [PlatformStandaloneReleasesController],
      providers: [
        { provide: STANDALONE_RELEASES, useValue: createStandaloneReleasesRuntime(env) },
        { provide: STANDALONE_RELEASES_CLOCK, useValue: () => new Date() },
        StandaloneReleasesService,
      ],
    };
  }
}
