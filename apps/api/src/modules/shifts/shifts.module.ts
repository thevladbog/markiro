import { Module } from "@nestjs/common";
import { OperatorsModule } from "../operators/operators.module";
import { SsccModule } from "../sscc/sscc.module";
import { ShiftsController } from "./shifts.controller";
import { ShiftsService } from "./shifts.service";
import { StationProductImagesController } from "./station-product-images.controller";
import { ProductsModule } from "../products/products.module";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [OperatorsModule, SsccModule, ProductsModule, StorageModule],
  controllers: [ShiftsController, StationProductImagesController],
  providers: [ShiftsService],
})
export class ShiftsModule {}
