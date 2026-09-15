import { Module } from "@nestjs/common";
import { PlatformServicePeriodsController } from "./platform-service-periods.controller";
import { ServicePeriodsService } from "./service-periods.service";
import { ServicePeriodObservability } from "./service-period-observability";

@Module({
  controllers: [PlatformServicePeriodsController],
  providers: [ServicePeriodsService, ServicePeriodObservability],
  exports: [ServicePeriodsService],
})
export class PlatformServicePeriodsModule {}
