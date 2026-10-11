import { WarehouseEventsService } from "./events.service";
import { Module } from "@nestjs/common";
import { StationWarehouseReprintController } from "./controller";
import { WarehouseLookupService } from "./lookup.service";
import { WarehouseTemplatesService } from "./templates.service";

@Module({
  controllers: [StationWarehouseReprintController],
  providers: [WarehouseLookupService, WarehouseTemplatesService, WarehouseEventsService],
})
export class StationWarehouseReprintModule {}
