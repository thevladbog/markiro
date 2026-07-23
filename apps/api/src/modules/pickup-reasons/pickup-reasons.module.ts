import { Module } from "@nestjs/common";
import { PickupReasonsController } from "./pickup-reasons.controller";
import { PickupReasonsService } from "./pickup-reasons.service";

@Module({
  controllers: [PickupReasonsController],
  providers: [PickupReasonsService],
})
export class PickupReasonsModule {}
