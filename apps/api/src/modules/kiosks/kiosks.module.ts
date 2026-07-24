import { Module } from "@nestjs/common";
import { KiosksController } from "./kiosks.controller";
import { KiosksService } from "./kiosks.service";

@Module({
  controllers: [KiosksController],
  providers: [KiosksService],
})
export class KiosksModule {}
