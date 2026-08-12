import { Module } from "@nestjs/common";
import { BillingPaymentsController } from "./billing-payments.controller";
import { BillingPaymentsService } from "./billing-payments.service";

@Module({ controllers: [BillingPaymentsController], providers: [BillingPaymentsService] })
export class BillingPaymentsModule {}
