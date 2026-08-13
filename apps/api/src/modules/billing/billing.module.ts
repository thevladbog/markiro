import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { BillingDocumentsService } from "./billing-documents.service";
import { BillingApplicationService } from "./billing-application.service";
import { SubscriptionLifecycleService } from "../../subscriptions/subscription-lifecycle.service";
import { TenantBillingController } from "./tenant-billing.controller";
import { TenantBillingService } from "./tenant-billing.service";

@Module({
  controllers: [BillingController, TenantBillingController],
  providers: [
    BillingService,
    BillingDocumentsService,
    BillingApplicationService,
    SubscriptionLifecycleService,
    TenantBillingService,
  ],
})
export class BillingModule {}
