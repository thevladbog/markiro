import { Module } from "@nestjs/common";
import { SubscriptionLifecycleService } from "../../subscriptions/subscription-lifecycle.service";
import { TenantOwnerActivationController } from "./tenant-owner-activation.controller";
import { TenantOwnerActivationService } from "./tenant-owner-activation.service";

@Module({
  controllers: [TenantOwnerActivationController],
  providers: [TenantOwnerActivationService, SubscriptionLifecycleService],
})
export class TenantOwnerActivationModule {}
