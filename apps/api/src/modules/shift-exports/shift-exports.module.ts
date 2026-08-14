import { Module } from "@nestjs/common";
import { ShiftExportsController } from "./shift-exports.controller";
import { ShiftExportsService } from "./shift-exports.service";

@Module({
  controllers: [ShiftExportsController],
  providers: [ShiftExportsService],
})
export class ShiftExportsModule {}
