import { Module } from "@nestjs/common";

import { InventoriesController } from "./inventories.controller";
import { InventoriesService } from "./inventories.service";
import { InventorySnapshotService } from "./inventory-snapshot.service";
import { InventoryLifecycleService } from "./inventory-lifecycle.service";

@Module({
  controllers: [InventoriesController],
  providers: [InventoriesService, InventorySnapshotService, InventoryLifecycleService],
  exports: [InventoriesService],
})
export class InventoriesModule {}
