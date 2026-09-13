import { Module } from "@nestjs/common";
import { SsccModule } from "../sscc/sscc.module";
import { StationScansController } from "./station-scans.controller";
import { StationScansService } from "./station-scans.service";

@Module({
  imports: [SsccModule],
  controllers: [StationScansController],
  exports: [StationScansService],
  providers: [StationScansService],
})
export class StationScansModule {}
