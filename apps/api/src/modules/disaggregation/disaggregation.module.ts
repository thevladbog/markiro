import { Module } from "@nestjs/common";
import { DisaggregationController } from "./disaggregation.controller";
import { DisaggregationService } from "./disaggregation.service";

@Module({
  controllers: [DisaggregationController],
  providers: [DisaggregationService],
})
export class DisaggregationModule {}
