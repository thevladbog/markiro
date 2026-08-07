import { Module } from "@nestjs/common";
import { StationDevicesController } from "./station-devices.controller";
import { StationDevicesService } from "./station-devices.service";
import { StationPairingModule } from "../station-pairing/station-pairing.module";

@Module({
  imports: [StationPairingModule],
  controllers: [StationDevicesController],
  providers: [StationDevicesService],
})
export class StationDevicesModule {}
