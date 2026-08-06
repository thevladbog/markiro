import { Module } from "@nestjs/common";
import { DevicePairingModule } from "../device-pairing/device-pairing.module";
import { OperatorsModule } from "../operators/operators.module";
import { StationPairController } from "./station-pair.controller";
import { StationPairingService } from "./station-pairing.service";

@Module({
  imports: [DevicePairingModule, OperatorsModule],
  controllers: [StationPairController],
  providers: [StationPairingService],
  exports: [StationPairingService],
})
export class StationPairingModule {}
