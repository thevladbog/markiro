import { Module } from "@nestjs/common";
import { KioskModule } from "../kiosk/kiosk.module";
import { KiosksController } from "./kiosks.controller";
import { KiosksService } from "./kiosks.service";

@Module({
  imports: [KioskModule],
  controllers: [KiosksController],
  providers: [KiosksService],
})
export class KiosksModule {}
