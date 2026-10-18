import { WarehouseUnifiedService } from "./unified.service";
import { WarehousePalletRenderingsService } from "./pallet-renderings.service";
import { WarehousePalletResolutionsService } from "./pallet-resolutions.service";
import { WarehousePalletService } from "./pallet.service";
import { WarehouseLabelFactsService } from "./label-facts.service";
import { WarehouseEventsService } from "./events.service";
import { Module } from "@nestjs/common";
import { StationWarehouseReprintController } from "./controller";
import { WarehouseLookupService } from "./lookup.service";
import { WarehouseTemplatesService } from "./templates.service";

@Module({
  controllers: [StationWarehouseReprintController],
  providers: [
    WarehouseUnifiedService,
    WarehouseLookupService,
    WarehouseTemplatesService,
    WarehouseEventsService,
    WarehouseLabelFactsService,
    WarehousePalletService,
    WarehousePalletRenderingsService,
    WarehousePalletResolutionsService,
  ],
})
export class StationWarehouseReprintModule {}
