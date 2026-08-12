import { Module } from "@nestjs/common";
import { BillingProfilesController } from "./billing-profiles.controller";
import { BillingProfilesService } from "./billing-profiles.service";

@Module({
  controllers: [BillingProfilesController],
  providers: [BillingProfilesService],
})
export class BillingProfilesModule {}
