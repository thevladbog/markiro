import { Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { JournalService } from "../integrations/journal.service";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
import { ChzTokenService } from "../chz-exports/chz-token.service";
import { TrueApiClient } from "../chz-exports/true-api.client";
import { ChzCodeStatusIngestService } from "./chz-code-status-ingest.service";
import { ChzCodeStatusRefreshService } from "./chz-code-status-refresh.service";

/**
 * `TrueApiClient`'s single constructor parameter is typed as
 * `TrueApiClientDependencies`, an interface -- TypeScript emits `Object` for
 * it in `design:paramtypes`, so registering the bare class as a provider
 * makes Nest try (and fail) to resolve a provider for `Object`. A factory
 * sidesteps constructor injection entirely and just takes the class's own
 * default (the real `fetch`). Same shape as `ChzExportsModule.forRoot`'s own
 * copy of this factory.
 */
function provideTrueApiClient() {
  return { provide: TrueApiClient, useFactory: () => new TrueApiClient() };
}

/**
 * Assembles the Chestny ZNAK code-status stack: `ChzCodeStatusIngestService`
 * (decides which marking codes belong in `chz_code_statuses`, Task 3) and
 * `ChzCodeStatusRefreshService` (asks ЧЗ what it currently says about the due
 * ones and records the answer, Task 4).
 *
 * `PgBossService`'s own `refresh-chz-code-statuses` worker (`jobs.module.ts`)
 * does *not* import this module to reach these services -- it declares its
 * own copies directly, the same way it keeps its own `ChzTokenService`/
 * `TrueApiClient` for `ChzExportRunnerService` instead of importing
 * `ChzExportsModule`. This module exists for other consumers of the two
 * runner services (e.g. a future admin-facing controller) that have no
 * reason to duplicate this wiring themselves.
 */
@Module({})
export class ChzCodeStatusesModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: ChzCodeStatusesModule,
      providers: [
        provideTrueApiClient(),
        ChzTokenService,
        JournalService,
        {
          provide: ChzCryptoService,
          useFactory: () => new ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY),
        },
        ChzCodeStatusIngestService,
        ChzCodeStatusRefreshService,
      ],
      exports: [ChzCodeStatusIngestService, ChzCodeStatusRefreshService],
    };
  }
}
