import { Module } from "@nestjs/common";
import { BillingPaymentsController } from "./billing-payments.controller";
import { BillingPaymentsService } from "./billing-payments.service";
import { BillingModule } from "../billing/billing.module";

@Module({
  imports: [BillingModule],
  controllers: [BillingPaymentsController],
  providers: [BillingPaymentsService],
})
export class BillingPaymentsModule {}
