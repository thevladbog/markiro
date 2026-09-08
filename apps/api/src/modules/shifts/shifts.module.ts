import { Module, type DynamicModule } from "@nestjs/common";
import { OperatorsModule } from "../operators/operators.module";
import { SsccModule } from "../sscc/sscc.module";
import { ShiftsController } from "./shifts.controller";
import { ShiftsService } from "./shifts.service";
import { StationProductImagesController } from "./station-product-images.controller";
import { ProductsModule } from "../products/products.module";
import { StorageModule } from "../storage/storage.module";

import { VALIDATION_DM_DUPLICATE_ENABLED } from "./validation-print-policy";

@Module({
  imports: [OperatorsModule, SsccModule, ProductsModule, StorageModule],
  controllers: [ShiftsController, StationProductImagesController],
  providers: [ShiftsService],
})
export class ShiftsModule {
  static forRoot(duplicateEnabled: boolean): DynamicModule {
    return {
      module: ShiftsModule,
      providers: [{ provide: VALIDATION_DM_DUPLICATE_ENABLED, useValue: duplicateEnabled }],
    };
  }
}
