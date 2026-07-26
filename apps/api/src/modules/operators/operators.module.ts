import { Module } from "@nestjs/common";
import { OperatorsController } from "./operators.controller";
import { OperatorsService } from "./operators.service";
import { StationOperatorsController } from "./station-operators.controller";

@Module({
  controllers: [OperatorsController, StationOperatorsController],
  providers: [OperatorsService],
  // Exported so ShiftsModule can reuse `buildRoster` for the shift bundle.
  exports: [OperatorsService],
})
export class OperatorsModule {}
