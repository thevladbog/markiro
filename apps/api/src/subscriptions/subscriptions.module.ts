import { EntitlementAdmissionService } from "./entitlement-admission.service";
import { EntitlementSourcesService } from "./entitlement-sources.service";
import { PlatformAuditModule } from "../platform-auth/platform-audit.module";
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
      imports: [PlatformAuditModule],
      providers: [
        { provide: SUBSCRIPTION_ENFORCEMENT_MODE, useValue: enforcementMode },
        EntitlementsService,
        EntitlementSourcesService,
        EntitlementAdmissionService,
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
        EntitlementSourcesService,
        EntitlementAdmissionService,
        SubscriptionAccessGuard,
        SubscriptionStatusJob,
      ],
    };
  }
}
