import { Module } from "@nestjs/common";

import { ProductRegulatoryController } from "./product-regulatory.controller";
import { ProductRegulatoryService } from "./product-regulatory.service";
import { ProductReadinessService } from "./readiness.service";

@Module({
  controllers: [ProductRegulatoryController],
  providers: [ProductRegulatoryService, ProductReadinessService],
  exports: [ProductRegulatoryService, ProductReadinessService],
})
export class ProductRegulatoryModule {}
