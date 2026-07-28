import { Module } from "@nestjs/common";
import { PickupOrdersModule } from "../pickup-orders/pickup-orders.module";
import { KioskController } from "./kiosk.controller";
import { KioskPairController } from "./kiosk-pair.controller";
import { PairingService } from "./pairing.service";

/**
 * `PairingService` lives here (its file is under this module) and is
 * exported so `KiosksModule` (the cabinet-facing `/kiosks` controller) can
 * import this module and reuse the same instance instead of re-providing
 * the class, which would silently give each controller its own instance.
 */
@Module({
  imports: [PickupOrdersModule],
  controllers: [KioskController, KioskPairController],
  providers: [PairingService],
  exports: [PairingService],
})
export class KioskModule {}
