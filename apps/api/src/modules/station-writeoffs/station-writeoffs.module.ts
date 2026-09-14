import { Module } from "@nestjs/common";
import { KioskModule } from "../kiosk/kiosk.module";
import { PickupOrdersModule } from "../pickup-orders/pickup-orders.module";
import { StationWriteoffsController } from "./station-writeoffs.controller";
import { StationWriteoffsService } from "./station-writeoffs.service";

/**
 * The handheld's write-off contour. Imports `PickupOrdersModule` for the one
 * document service both devices share, and `KioskModule` for `BoxRegistryService`
 * — the registry is tenant-scoped, so serving it to a handheld needs the route
 * and its guard, not a second implementation.
 */
@Module({
  imports: [PickupOrdersModule, KioskModule],
  controllers: [StationWriteoffsController],
  providers: [StationWriteoffsService],
  exports: [StationWriteoffsService],
})
export class StationWriteoffsModule {}
