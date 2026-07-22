import { Module } from "@nestjs/common";
import { OrgProfileModule } from "../org-profile/org-profile.module";
import { ProductsController } from "./products.controller";
import { ProductsService } from "./products.service";

/**
 * Imports OrgProfileModule to inject its exported OrgProfileService
 * (`getPrefixes(tenantId)`) for the gtin-check owner-detection endpoint.
 */
@Module({
  imports: [OrgProfileModule],
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
