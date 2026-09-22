import { Module } from "@nestjs/common";
import { SsccModule } from "../sscc/sscc.module";
import { StationPalletsController } from "./station-pallets.controller";
import { StationPalletsService } from "./station-pallets.service";

/**
 * The handheld's warehouse-pallet bootstrap. Imports `SsccModule` for the
 * shared issuer-prefix resolution and pallet (extension digit 1) SSCC block
 * allocation, mirroring `ShiftsService.bundleSscc`'s pallet half without a
 * shift.
 */
@Module({
  imports: [SsccModule],
  controllers: [StationPalletsController],
  providers: [StationPalletsService],
  exports: [StationPalletsService],
})
export class StationPalletsModule {}
