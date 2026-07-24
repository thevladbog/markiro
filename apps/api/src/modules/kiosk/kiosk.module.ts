import { Module } from "@nestjs/common";
import { PickupOrdersModule } from "../pickup-orders/pickup-orders.module";
import { KioskController } from "./kiosk.controller";

@Module({
  imports: [PickupOrdersModule],
  controllers: [KioskController],
})
export class KioskModule {}
