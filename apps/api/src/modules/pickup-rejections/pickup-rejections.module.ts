import { Module } from "@nestjs/common";
import { PickupRejectionsController } from "./pickup-rejections.controller";
import { PickupRejectionsService } from "./pickup-rejections.service";

@Module({
  controllers: [PickupRejectionsController],
  providers: [PickupRejectionsService],
})
export class PickupRejectionsModule {}
