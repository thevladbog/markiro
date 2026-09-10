import { Module } from "@nestjs/common";
import { PlatformAuditModule } from "../platform-auth/platform-audit.module";
import { PlatformReportsController } from "./platform-reports.controller";
import { PlatformReportsService } from "./platform-reports.service";

@Module({
  imports: [PlatformAuditModule],
  controllers: [PlatformReportsController],
  providers: [PlatformReportsService],
})
export class PlatformReportsModule {}
