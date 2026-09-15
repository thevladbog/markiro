import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { BillingDocumentsService } from "./billing-documents.service";
import { BillingApplicationService } from "./billing-application.service";
import { SubscriptionLifecycleService } from "../../subscriptions/subscription-lifecycle.service";
import { ServicePeriodObservability } from "../service-periods/service-period-observability";

@Module({
  controllers: [BillingController],
  providers: [
    BillingService,
    BillingDocumentsService,
    BillingApplicationService,
    ServicePeriodObservability,
    SubscriptionLifecycleService,
  ],
  exports: [BillingApplicationService],
})
export class BillingModule {}
