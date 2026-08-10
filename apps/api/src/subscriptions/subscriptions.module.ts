import { DynamicModule, Global, Module } from "@nestjs/common";
import { EntitlementsService, SUBSCRIPTION_ENFORCEMENT_MODE } from "./entitlements.service";
import type { SubscriptionEnforcementMode } from "./entitlements.types";
import {
  DatabaseSubscriptionStatusCandidateSource,
  SUBSCRIPTION_STATUS_CANDIDATE_SOURCE,
  SubscriptionStatusJob,
} from "./subscription-status.job";
import { SubscriptionAccessGuard } from "./subscription-access.guard";

@Global()
@Module({})
export class SubscriptionsModule {
  static forRoot(enforcementMode: SubscriptionEnforcementMode): DynamicModule {
    return {
      module: SubscriptionsModule,
      providers: [
        { provide: SUBSCRIPTION_ENFORCEMENT_MODE, useValue: enforcementMode },
        EntitlementsService,
        SubscriptionAccessGuard,
        {
          provide: SUBSCRIPTION_STATUS_CANDIDATE_SOURCE,
          useClass: DatabaseSubscriptionStatusCandidateSource,
        },
        SubscriptionStatusJob,
      ],
      exports: [
        SUBSCRIPTION_ENFORCEMENT_MODE,
        EntitlementsService,
        SubscriptionAccessGuard,
        SubscriptionStatusJob,
      ],
    };
  }
}
