import { Module } from "@nestjs/common";
import { BillingActsController } from "./billing-acts.controller";
import { BillingActsService } from "./billing-acts.service";

@Module({
  controllers: [BillingActsController],
  providers: [BillingActsService],
})
export class BillingActsModule {}
