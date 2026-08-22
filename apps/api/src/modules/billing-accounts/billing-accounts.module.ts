import { Module } from "@nestjs/common";

import { BillingAccountsController } from "./billing-accounts.controller";
import { BillingAccountsService } from "./billing-accounts.service";

@Module({
  controllers: [BillingAccountsController],
  providers: [BillingAccountsService],
})
export class BillingAccountsModule {}
