import { Module } from "@nestjs/common";
import { PlatformOffersController } from "./platform-offers.controller";
import { PlatformOffersService } from "./platform-offers.service";

@Module({ controllers: [PlatformOffersController], providers: [PlatformOffersService] })
export class PlatformOffersModule {}
