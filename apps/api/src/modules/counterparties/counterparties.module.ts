import { Module } from "@nestjs/common";
import { SsccModule } from "../sscc/sscc.module";
import { CounterpartiesController } from "./counterparties.controller";
import { CounterpartiesService } from "./counterparties.service";

@Module({
  imports: [SsccModule],
  controllers: [CounterpartiesController],
  providers: [CounterpartiesService],
})
export class CounterpartiesModule {}
