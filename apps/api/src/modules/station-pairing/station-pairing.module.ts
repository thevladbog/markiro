import { Module } from "@nestjs/common";
import { DevicePairingModule } from "../device-pairing/device-pairing.module";
import { OperatorsModule } from "../operators/operators.module";
import { StationHeartbeatController } from "./station-heartbeat.controller";
import { StationPairController } from "./station-pair.controller";
import { StationPairingService } from "./station-pairing.service";

@Module({
  imports: [DevicePairingModule, OperatorsModule],
  controllers: [StationPairController, StationHeartbeatController],
  providers: [StationPairingService],
  exports: [StationPairingService],
})
export class StationPairingModule {}
