import { Module } from "@nestjs/common";

import { InventoriesController } from "./inventories.controller";
import { InventoriesService } from "./inventories.service";
import { InventorySnapshotService } from "./inventory-snapshot.service";

@Module({
  controllers: [InventoriesController],
  providers: [InventoriesService, InventorySnapshotService],
  exports: [InventoriesService],
})
export class InventoriesModule {}
