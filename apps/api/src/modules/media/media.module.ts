import { Module } from "@nestjs/common";
import { MediaAssetsReconciler } from "./media-assets.reconciler";
import { MediaAssetsService } from "./media-assets.service";

@Module({
  providers: [MediaAssetsService, MediaAssetsReconciler],
  exports: [MediaAssetsService],
})
export class MediaModule {}
