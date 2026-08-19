import { Module } from "@nestjs/common";
import { DisaggregationReasonsController } from "./disaggregation-reasons.controller";
import { DisaggregationReasonsService } from "./disaggregation-reasons.service";

@Module({
  controllers: [DisaggregationReasonsController],
  providers: [DisaggregationReasonsService],
})
export class DisaggregationReasonsModule {}
