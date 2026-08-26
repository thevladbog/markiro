import { Module } from "@nestjs/common";

import { InventoriesController } from "./inventories.controller";
import { InventoriesService } from "./inventories.service";
import { InventorySnapshotService } from "./inventory-snapshot.service";
import { InventoryLifecycleService } from "./inventory-lifecycle.service";
import { SsccModule } from "../sscc/sscc.module";
import { StationInventoriesController } from "./station-inventories.controller";
import { StationInventoryAccessService } from "./station-inventory-access.service";
import { StationInventoryBundleService } from "./station-inventory-bundle.service";
import { StationInventorySyncService } from "./station-inventory-sync.service";
import { InventoryReconciliationService } from "./inventory-reconciliation.service";
import { InventoryResultSourceService } from "./inventory-result-source.service";
import { InventoryCorrectionsService } from "./inventory-corrections.service";
import { InventoryCloseService } from "./inventory-close.service";
import { InventoryDocumentFormatsController } from "./inventory-document-formats.controller";
import { InventoryDocumentFormatsService } from "./inventory-document-formats.service";

@Module({
  imports: [SsccModule],
  controllers: [
    InventoriesController,
    InventoryDocumentFormatsController,
    StationInventoriesController,
  ],
  providers: [
    InventoriesService,
    InventorySnapshotService,
    InventoryLifecycleService,
    StationInventoryAccessService,
    StationInventoryBundleService,
    StationInventorySyncService,
    InventoryReconciliationService,
    InventoryResultSourceService,
    InventoryCorrectionsService,
    InventoryCloseService,
    InventoryDocumentFormatsService,
  ],
  exports: [InventoriesService, InventoryResultSourceService],
})
export class InventoriesModule {}
