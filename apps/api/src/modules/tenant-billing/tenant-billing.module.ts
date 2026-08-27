import { Module } from "@nestjs/common";
import { TenantBillingController } from "./tenant-billing.controller";
import { TenantBillingReadService } from "./tenant-billing-read.service";

@Module({
  controllers: [TenantBillingController],
  providers: [TenantBillingReadService],
})
export class TenantBillingModule {}
