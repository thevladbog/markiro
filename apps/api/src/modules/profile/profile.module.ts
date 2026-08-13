import { Module } from "@nestjs/common";
import { ProfileController } from "./profile.controller";
import { ProfileService } from "./profile.service";
import { ProfileSessionGuard } from "./profile-session.guard";
import { ProfileAssetsReconciler } from "./profile-assets.reconciler";
import { OrgProfileModule } from "../org-profile/org-profile.module";

@Module({
  imports: [OrgProfileModule],
  controllers: [ProfileController],
  providers: [ProfileService, ProfileSessionGuard, ProfileAssetsReconciler],
  exports: [ProfileService],
})
export class ProfileModule {}
