import { Module } from "@nestjs/common";
import { PlatformOffersController } from "./platform-offers.controller";
import { PlatformOffersService } from "./platform-offers.service";
import { OfferDocumentsService } from "./offer-documents.service";

@Module({
  controllers: [PlatformOffersController],
  providers: [PlatformOffersService, OfferDocumentsService],
})
export class PlatformOffersModule {}
