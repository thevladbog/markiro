import { Module } from "@nestjs/common";
import { OrgProfileModule } from "../org-profile/org-profile.module";
import { MediaAssetsReconciler } from "./media-assets.reconciler";
import { MediaAssetsService } from "./media-assets.service";

@Module({
  imports: [OrgProfileModule],
  providers: [MediaAssetsService, MediaAssetsReconciler],
  exports: [MediaAssetsService],
})
export class MediaModule {}
