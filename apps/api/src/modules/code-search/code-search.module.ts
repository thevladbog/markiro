import { Module } from "@nestjs/common";
import { OrgProfileModule } from "../org-profile/org-profile.module";
import { CodeSearchController } from "./code-search.controller";
import { CodeSearchService } from "./code-search.service";

@Module({
  // The printed forms carry the organisation's uploaded logo, which lives
  // behind OrgProfileService (object storage), not in a column.
  imports: [OrgProfileModule],
  controllers: [CodeSearchController],
  providers: [CodeSearchService],
})
export class CodeSearchModule {}
