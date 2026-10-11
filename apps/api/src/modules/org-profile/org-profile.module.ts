import { Module } from "@nestjs/common";
import { SsccModule } from "../sscc/sscc.module";
import { OrgProfileController } from "./org-profile.controller";
import { OrgProfileService } from "./org-profile.service";
import { StationBrandingController } from "./station-branding.controller";
import { CabinetPrintBrandingController } from "./cabinet-print-branding.controller";

/**
 * Exports OrgProfileService so later modules (Task 6's products/gtin-check)
 * can inject it for `getPrefixes(tenantId)` without duplicating the query.
 * Depends on the `DB` token from AuthModule (@Global, only available once
 * AppModule.forRoot() has wired it in) -- see app.module.ts.
 */
@Module({
  imports: [SsccModule],
  controllers: [OrgProfileController, StationBrandingController, CabinetPrintBrandingController],
  providers: [OrgProfileService],
  exports: [OrgProfileService],
})
export class OrgProfileModule {}
