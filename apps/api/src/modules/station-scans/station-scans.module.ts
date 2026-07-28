import { Module } from "@nestjs/common";
import { StationScansController } from "./station-scans.controller";
import { StationScansService } from "./station-scans.service";

@Module({
  controllers: [StationScansController],
  providers: [StationScansService],
})
export class StationScansModule {}
