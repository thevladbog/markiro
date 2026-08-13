import { Module } from "@nestjs/common";
import { DevicePairingModule } from "../device-pairing/device-pairing.module";
import { PickupOrdersModule } from "../pickup-orders/pickup-orders.module";
import { KioskController } from "./kiosk.controller";
import { KioskPairController } from "./kiosk-pair.controller";
import { PairingService } from "./pairing.service";
import { OrgProfileModule } from "../org-profile/org-profile.module";
import { BoxRegistryService } from "./box-registry.service";

/**
 * `PairingService` lives here (its file is under this module) and is
 * exported so `KiosksModule` (the cabinet-facing `/kiosks` controller) can
 * import this module and reuse the same instance instead of re-providing
 * the class, which would silently give each controller its own instance.
 */
@Module({
  imports: [DevicePairingModule, PickupOrdersModule, OrgProfileModule],
  controllers: [KioskController, KioskPairController],
  providers: [PairingService, BoxRegistryService],
  exports: [PairingService, BoxRegistryService],
})
export class KioskModule {}
