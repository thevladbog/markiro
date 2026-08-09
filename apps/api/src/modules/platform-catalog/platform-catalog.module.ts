import { Module } from "@nestjs/common";
import {
  PlatformCatalogController,
  PlatformSettingsController,
} from "./platform-catalog.controller";
import { PlatformCatalogService } from "./platform-catalog.service";

@Module({
  controllers: [PlatformCatalogController, PlatformSettingsController],
  providers: [PlatformCatalogService],
})
export class PlatformCatalogModule {}
