import { Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { PgBossService } from "../../jobs/jobs.module";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
import { ChzKmOrdersController } from "./chz-km-orders.controller";
import { CHZ_KM_ORDER_QUEUE, ChzKmOrdersService } from "./chz-km-orders.service";
import { ChzOmsTokenService } from "./chz-oms-token.service";

/**
 * Assembles the ChZ КМ-order cabinet stack: `ChzKmOrdersService` (pre-flight,
 * create/list/get/retry, Task 8) and `ChzKmOrdersController` (the cabinet HTTP
 * surface).
 *
 * `ChzKmOrderRunnerService` (the background state machine, Task 9) is not
 * provided here: nothing in this module injects it, and the only thing that
 * runs it is the `run-chz-km-order` worker in `JobsModule` (Task 10), which
 * builds its own instance -- which is how the two modules avoid depending on
 * each other, see the `CHZ_KM_ORDER_QUEUE` binding below. A second instance
 * here would be a second live СУЗ client and crypto service with no consumer.
 * `OmsClient` and `JournalService` went with it: the runner was their only
 * consumer here, and `JobsModule` provides its own of each.
 */
@Module({})
export class ChzKmOrdersModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: ChzKmOrdersModule,
      controllers: [ChzKmOrdersController],
      providers: [
        ChzOmsTokenService,
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
      ],
      exports: [ChzKmOrdersService],
    };
  }
}
