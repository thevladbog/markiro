import { GrantEvidenceService } from "./grant-evidence.service";
import { GrantEvidenceNativeService } from "./grant-evidence-native.service";
import { StationScansModule } from "../station-scans/station-scans.module";
import { StationShiftCloseModule } from "../station-shift-close/station-shift-close.module";
import { InventoriesModule } from "../inventories/inventories.module";
import { Module, type DynamicModule } from "@nestjs/common";
import type { Env } from "../../env";
import { PickupOrdersModule } from "../pickup-orders/pickup-orders.module";
import { DeviceGrantsController } from "./device-grants.controller";
import { KioskGrantsController } from "./kiosk-grants.controller";
import { GrantIssuerService } from "./grant-issuer.service";
import { configureGrantSigning, GRANT_SIGNING_CONFIGURATION } from "./grant-keyset";
@Module({})
export class DeviceGrantsModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: DeviceGrantsModule,
      imports: [PickupOrdersModule, StationScansModule, StationShiftCloseModule, InventoriesModule],
      controllers: [DeviceGrantsController, KioskGrantsController],
      providers: [
        { provide: GRANT_SIGNING_CONFIGURATION, useValue: configureGrantSigning(env) },
        GrantIssuerService,
        GrantEvidenceService,
        GrantEvidenceNativeService,
      ],
      exports: [GrantIssuerService],
    };
  }
}
