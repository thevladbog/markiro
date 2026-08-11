import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { BillingDocumentsService } from "./billing-documents.service";

@Module({ controllers: [BillingController], providers: [BillingService, BillingDocumentsService] })
export class BillingModule {}
