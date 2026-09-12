import { Module } from "@nestjs/common";

import { PlatformAuditModule } from "../../platform-auth/platform-audit.module";
import { DeviceLicensingController } from "./device-licensing.controller";
import { DeviceLicensingService } from "./device-licensing.service";
import { PlatformDeviceLicensingController } from "./platform-device-licensing.controller";

@Module({
  imports: [PlatformAuditModule],
  controllers: [DeviceLicensingController, PlatformDeviceLicensingController],
  providers: [DeviceLicensingService],
})
export class DeviceLicensingModule {}
