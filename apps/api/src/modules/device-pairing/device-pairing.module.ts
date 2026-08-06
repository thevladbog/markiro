import { Module } from "@nestjs/common";
import { PairAttemptsService } from "./pair-attempts.service";

@Module({
  providers: [PairAttemptsService],
  exports: [PairAttemptsService],
})
export class DevicePairingModule {}
