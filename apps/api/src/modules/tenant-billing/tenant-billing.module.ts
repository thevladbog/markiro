import { Module } from "@nestjs/common";
import { TenantBillingController } from "./tenant-billing.controller";
import { TenantBillingOffersService } from "./tenant-billing-offers.service";
import { TenantBillingReadService } from "./tenant-billing-read.service";
import { TenantBillingRequestsService } from "./tenant-billing-requests.service";

@Module({
  controllers: [TenantBillingController],
  providers: [TenantBillingReadService, TenantBillingRequestsService, TenantBillingOffersService],
})
export class TenantBillingModule {}
