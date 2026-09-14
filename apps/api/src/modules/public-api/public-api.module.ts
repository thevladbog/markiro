import { InventoriesModule } from "../inventories/inventories.module";
import { PublicProductsController } from "./public-products.controller";
import { PublicInventoriesController } from "./public-inventories.controller";
import { PublicApiReadService } from "./public-api-read.service";
import { PublicApiRequestService } from "./public-api-request.service";
import { PublicApiAdmissionService } from "./public-api-admission.service";
import { Module } from "@nestjs/common";
import { PublicApiAuthService } from "./public-api-auth.service";
import { PublicApiGuard } from "./public-api.guard";

@Module({
  imports: [InventoriesModule],
  controllers: [PublicProductsController, PublicInventoriesController],
  providers: [
    PublicApiReadService,
    PublicApiAuthService,
    PublicApiGuard,
    PublicApiRequestService,
    PublicApiAdmissionService,
  ],
  exports: [
    PublicApiAuthService,
    PublicApiGuard,
    PublicApiRequestService,
    PublicApiAdmissionService,
  ],
})
export class PublicApiModule {}
