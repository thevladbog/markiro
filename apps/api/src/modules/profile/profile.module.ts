import { Module } from "@nestjs/common";
import { ProfileController } from "./profile.controller";
import { ProfileService } from "./profile.service";
import { ProfileSessionGuard } from "./profile-session.guard";
import { ProfileAssetsReconciler } from "./profile-assets.reconciler";

@Module({
  controllers: [ProfileController],
  providers: [ProfileService, ProfileSessionGuard, ProfileAssetsReconciler],
  exports: [ProfileService],
})
export class ProfileModule {}
