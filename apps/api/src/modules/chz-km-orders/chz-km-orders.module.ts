import { Injectable, Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { JournalService } from "../integrations/journal.service";
import { ChzCryptoService } from "../signer-agents/chz-crypto.service";
import { ChzKmOrdersController } from "./chz-km-orders.controller";
import {
  CHZ_KM_ORDER_QUEUE,
  ChzKmOrdersService,
  type ChzKmOrderQueue,
} from "./chz-km-orders.service";
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
 * Placeholder for `CHZ_KM_ORDER_QUEUE` until Task 10 adds
 * `PgBossService.enqueueChzKmOrder` and its `run-chz-km-order` worker.
 *
 * `PgBossService` (`../../jobs/jobs.module`) is already reachable here
 * without a circular import -- `JobsModule` is `@Global()` and exports it,
 * the same way `ChzExportsService` injects it directly -- but it does not
 * yet implement `ChzKmOrderQueue.enqueueChzKmOrder`. Binding
 * `{ provide: CHZ_KM_ORDER_QUEUE, useExisting: PgBossService }` today would
 * compile (the token aliasing is untyped) and then fail at runtime the
 * moment `ChzKmOrdersService.create`/`retry` called the missing method. This
 * no-op stands in until that method exists.
 *
 * Task 10 must replace this provider with
 * `{ provide: CHZ_KM_ORDER_QUEUE, useExisting: PgBossService }` once
 * `PgBossService.enqueueChzKmOrder` is implemented, and delete this class.
 */
@Injectable()
class NoopChzKmOrderQueue implements ChzKmOrderQueue {
  enqueueChzKmOrder(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

/**
 * Assembles the ChZ КМ-order cabinet stack: `ChzKmOrdersService` (pre-flight,
 * create/list/get/retry, Task 8) and `ChzKmOrdersController` (the cabinet
 * HTTP surface). The order runner and its pg-boss queue (Task 10) will join
 * this module's providers the same way `ChzExportRunnerService` joins
 * `ChzExportsModule` -- see `NoopChzKmOrderQueue` above for what that task
 * must change.
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
        { provide: CHZ_KM_ORDER_QUEUE, useClass: NoopChzKmOrderQueue },
        ChzKmOrdersService,
      ],
      exports: [ChzKmOrdersService],
    };
  }
}
