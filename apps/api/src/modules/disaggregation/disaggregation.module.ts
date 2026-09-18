import { Module } from "@nestjs/common";
import { OrgProfileModule } from "../org-profile/org-profile.module";
import { DisaggregationController } from "./disaggregation.controller";
import { DisaggregationService } from "./disaggregation.service";

@Module({
  // The printed report carries the organisation's uploaded logo, which lives
  // behind OrgProfileService (object storage), not in a column.
  imports: [OrgProfileModule],
  controllers: [DisaggregationController],
  providers: [DisaggregationService],
})
export class DisaggregationModule {}
