import { Module } from "@nestjs/common";

import { InventoriesController } from "./inventories.controller";
import { InventoriesService } from "./inventories.service";

@Module({
  controllers: [InventoriesController],
  providers: [InventoriesService],
  exports: [InventoriesService],
})
export class InventoriesModule {}
