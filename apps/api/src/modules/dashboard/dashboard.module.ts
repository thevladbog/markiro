import { Module } from "@nestjs/common";

import { DashboardController } from "./dashboard.controller";
import { DrizzleDashboardRepository, type DashboardRepository } from "./dashboard.repository";
import { DASHBOARD_REPOSITORY, DashboardService } from "./dashboard.service";

@Module({
  controllers: [DashboardController],
  providers: [
    {
      provide: DASHBOARD_REPOSITORY,
      useClass: DrizzleDashboardRepository,
    },
    {
      provide: DashboardService,
      inject: [DASHBOARD_REPOSITORY],
      useFactory: (repository: DashboardRepository) => new DashboardService(repository),
    },
  ],
})
export class DashboardModule {}
