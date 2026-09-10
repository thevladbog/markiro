import { Module } from "@nestjs/common";
import { PlatformOffersController } from "./platform-offers.controller";
import { PlatformOffersService } from "./platform-offers.service";
import { OfferDocumentsService } from "./offer-documents.service";
import { OfferWorkspaceService } from "./offer-workspace.service";
import { OfferPreviewService } from "./offer-preview.service";

@Module({
  controllers: [PlatformOffersController],
  providers: [
    PlatformOffersService,
    OfferDocumentsService,
    OfferWorkspaceService,
    OfferPreviewService,
  ],
})
export class PlatformOffersModule {}
