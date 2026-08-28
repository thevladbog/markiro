import { Module } from "@nestjs/common";
import { MediaModule } from "../media/media.module";
import { OrgProfileModule } from "../org-profile/org-profile.module";
import { ProductsController } from "./products.controller";
import { ProductsService } from "./products.service";
import { ProductImageUploadFilter } from "./product-image-upload.filter";
import { ProductGroupsController } from "./product-groups.controller";
import { ProductGroupsService } from "./product-groups.service";

/**
 * Imports OrgProfileModule to inject its exported OrgProfileService
 * (`getPrefixes(tenantId)`) for the gtin-check owner-detection endpoint.
 */
@Module({
  imports: [MediaModule, OrgProfileModule],
  controllers: [ProductsController, ProductGroupsController],
  providers: [ProductsService, ProductImageUploadFilter, ProductGroupsService],
  exports: [ProductsService],
})
export class ProductsModule {}
