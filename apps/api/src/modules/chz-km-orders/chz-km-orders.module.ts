import { Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { PgBossService } from "../../jobs/jobs.module";
import { JournalService } from "../integrations/journal.service";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
import { ChzKmOrderRunnerService } from "./chz-km-order-runner.service";
import { ChzKmOrdersController } from "./chz-km-orders.controller";
import { CHZ_KM_ORDER_QUEUE, ChzKmOrdersService } from "./chz-km-orders.service";
import { ChzOmsTokenService } from "./chz-oms-token.service";
import { OmsClient } from "./oms.client";

/**
 * `OmsClient`'s single constructor parameter is typed as
 * `OmsClientDependencies`, an interface -- TypeScript emits `Object` for it
 * in `design:paramtypes`, so registering the bare class as a provider makes
 * Nest try (and fail) to resolve a provider for `Object`. A factory
 * sidesteps constructor injection entirely and just takes the class's own
 * default (the real `fetch`). Mirrors `ChzExportsModule`'s
 * `provideTrueApiClient`.
 */
function provideOmsClient() {
  return { provide: OmsClient, useFactory: () => new OmsClient() };
}

/**
 * Assembles the ChZ КМ-order cabinet stack: `ChzKmOrdersService` (pre-flight,
 * create/list/get/retry, Task 8), `ChzKmOrdersController` (the cabinet HTTP
 * surface) and `ChzKmOrderRunnerService` (the background state machine,
 * Task 9). The runner instance below serves this module's own consumers; the
 * `run-chz-km-order` worker in `JobsModule` (Task 10) provides a second one
 * for itself, which is how the two modules avoid depending on each other --
 * see the `CHZ_KM_ORDER_QUEUE` binding below.
 */
@Module({})
export class ChzKmOrdersModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: ChzKmOrdersModule,
      controllers: [ChzKmOrdersController],
      providers: [
        provideOmsClient(),
        ChzOmsTokenService,
        JournalService,
        {
          provide: ChzCryptoService,
          useFactory: () => new ChzCryptoService(env.CHZ_TOKEN_ENCRYPTION_KEY),
        },
        // `JobsModule` is `@Global()` and exports `PgBossService`, so this
        // alias needs no import of it -- which is what keeps the dependency
        // one-way: `JobsModule`'s `run-chz-km-order` worker builds its own
        // `ChzKmOrderRunnerService` out of this directory's services rather
        // than importing this module, so neither module imports the other.
        { provide: CHZ_KM_ORDER_QUEUE, useExisting: PgBossService },
        ChzKmOrdersService,
        ChzKmOrderRunnerService,
      ],
      exports: [ChzKmOrdersService, ChzKmOrderRunnerService],
    };
  }
}
