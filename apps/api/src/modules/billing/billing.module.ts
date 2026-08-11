import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { BillingDocumentsService } from "./billing-documents.service";
import { BillingApplicationService } from "./billing-application.service";
import { SubscriptionLifecycleService } from "../../subscriptions/subscription-lifecycle.service";

@Module({ controllers: [BillingController], providers: [BillingService, BillingDocumentsService, BillingApplicationService, SubscriptionLifecycleService] })
export class BillingModule {}
