import { Module } from "@nestjs/common";
import { SsccService } from "./sscc.service";

@Module({
  providers: [SsccService],
  exports: [SsccService],
})
export class SsccModule {}
