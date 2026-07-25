import { Module } from "@nestjs/common";
import { OperatorsController } from "./operators.controller";
import { OperatorsService } from "./operators.service";

@Module({
  controllers: [OperatorsController],
  providers: [OperatorsService],
  // Exported so ShiftsModule can reuse `buildRoster` for the shift bundle.
  exports: [OperatorsService],
})
export class OperatorsModule {}
