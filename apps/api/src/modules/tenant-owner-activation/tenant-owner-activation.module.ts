import { Module } from "@nestjs/common";
import { TenantOwnerActivationController } from "./tenant-owner-activation.controller";
import { TenantOwnerActivationService } from "./tenant-owner-activation.service";

@Module({
  controllers: [TenantOwnerActivationController],
  providers: [TenantOwnerActivationService],
})
export class TenantOwnerActivationModule {}
