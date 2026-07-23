import { Module } from "@nestjs/common";
import { StationDevicesController } from "./station-devices.controller";
import { StationDevicesService } from "./station-devices.service";

@Module({
  controllers: [StationDevicesController],
  providers: [StationDevicesService],
})
export class StationDevicesModule {}
