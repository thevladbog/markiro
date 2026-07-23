import { Module } from "@nestjs/common";
import { OrgProfileController } from "./org-profile.controller";
import { OrgProfileService } from "./org-profile.service";

/**
 * Exports OrgProfileService so later modules (Task 6's products/gtin-check)
 * can inject it for `getPrefixes(tenantId)` without duplicating the query.
 * Depends on the `DB` token from AuthModule (@Global, only available once
 * AppModule.forRoot() has wired it in) -- see app.module.ts.
 */
@Module({
  controllers: [OrgProfileController],
  providers: [OrgProfileService],
  exports: [OrgProfileService],
})
export class OrgProfileModule {}
