import { Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { InventoriesModule } from "../inventories/inventories.module";
import { JournalService } from "../integrations/journal.service";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
import { ChzExportRunnerService } from "./chz-export-runner.service";
import { ChzExportsService } from "./chz-exports.service";
import { ChzTokenService } from "./chz-token.service";
import { TrueApiClient } from "./true-api.client";

/**
 * `TrueApiClient`'s single constructor parameter is typed as
 * `TrueApiClientDependencies`, an interface -- TypeScript emits `Object` for
 * it in `design:paramtypes`, so registering the bare class as a provider
 * makes Nest try (and fail) to resolve a provider for `Object`. A factory
 * sidesteps constructor injection entirely and just takes the class's own
 * default (the real `fetch`).
 */
function provideTrueApiClient() {
  return { provide: TrueApiClient, useFactory: () => new TrueApiClient() };
}

/**
 * Assembles the ChZ export cabinet stack: `ChzExportsService` (pre-flight,
 * ordering and retry, Task 4) and `ChzExportRunnerService` (the queue
 * consumer, Task 5), ready for Task 7's controller to be added to
 * `controllers` here.
 *
 * `PgBossService`'s own `run-chz-export` worker (`jobs.module.ts`) does
 * *not* import this module to reach `ChzExportRunnerService` -- it declares
 * its own copy of that service and its dependencies directly, the same way
 * it keeps its own `ChzCryptoService` factory instead of importing
 * `SignerAgentsModule`: this module's `ChzExportsService` needs
 * `PgBossService`, which lives in `JobsModule`, so importing this module
 * into `JobsModule` would be circular.
 */
@Module({})
export class ChzExportsModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: ChzExportsModule,
      imports: [InventoriesModule],
      providers: [
        provideTrueApiClient(),
        ChzTokenService,
        JournalService,
        {
          provide: ChzCryptoService,
          useFactory: () => new ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY),
        },
        ChzExportRunnerService,
        ChzExportsService,
      ],
      exports: [ChzExportRunnerService, ChzExportsService],
    };
  }
}
