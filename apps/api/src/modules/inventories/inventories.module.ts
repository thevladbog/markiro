import { Module } from "@nestjs/common";

import { InventoriesController } from "./inventories.controller";
import { InventoriesService } from "./inventories.service";
import { InventorySnapshotService } from "./inventory-snapshot.service";
import { InventoryLifecycleService } from "./inventory-lifecycle.service";
import { SsccModule } from "../sscc/sscc.module";
import { StationInventoriesController } from "./station-inventories.controller";
import { StationInventoryAccessService } from "./station-inventory-access.service";
import { StationInventoryBundleService } from "./station-inventory-bundle.service";

@Module({
  imports: [SsccModule],
  controllers: [InventoriesController, StationInventoriesController],
  providers: [
    InventoriesService,
    InventorySnapshotService,
    InventoryLifecycleService,
    StationInventoryAccessService,
    StationInventoryBundleService,
  ],
  exports: [InventoriesService],
})
export class InventoriesModule {}
