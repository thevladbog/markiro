import { Module } from "@nestjs/common";
import { PlatformBillingRequestsController } from "./platform-billing-requests.controller";
import { PlatformBillingRequestsService } from "./platform-billing-requests.service";

@Module({
  controllers: [PlatformBillingRequestsController],
  providers: [PlatformBillingRequestsService],
})
export class PlatformBillingRequestsModule {}
