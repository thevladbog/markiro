import { DynamicModule, Global, Module } from "@nestjs/common";
import { EntitlementsService, SUBSCRIPTION_ENFORCEMENT_MODE } from "./entitlements.service";
import type { SubscriptionEnforcementMode } from "./entitlements.types";
import { SubscriptionStatusJob } from "./subscription-status.job";

@Global()
@Module({})
export class SubscriptionsModule {
  static forRoot(enforcementMode: SubscriptionEnforcementMode): DynamicModule {
    return {
      module: SubscriptionsModule,
      providers: [
        { provide: SUBSCRIPTION_ENFORCEMENT_MODE, useValue: enforcementMode },
        EntitlementsService,
        SubscriptionStatusJob,
      ],
      exports: [EntitlementsService, SubscriptionStatusJob],
    };
  }
}
