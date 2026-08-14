import { Module } from "@nestjs/common";
import { StationShiftCloseController } from "./station-shift-close.controller";
import { StationShiftCloseService } from "./station-shift-close.service";

@Module({ controllers: [StationShiftCloseController], providers: [StationShiftCloseService] })
export class StationShiftCloseModule {}
