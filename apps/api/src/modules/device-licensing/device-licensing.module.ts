import { DeviceReplacementService } from "./device-replacement.service";
import { DeviceReplacementController } from "./device-replacement.controller";
import { PlatformDeviceReplacementController } from "./platform-device-replacement.controller";
import { Module } from "@nestjs/common";

import { PlatformAuditModule } from "../../platform-auth/platform-audit.module";
import { DeviceLicensingController } from "./device-licensing.controller";
import { DeviceLicensingService } from "./device-licensing.service";
import { PlatformDeviceLicensingController } from "./platform-device-licensing.controller";

@Module({
  imports: [PlatformAuditModule],
  controllers: [
    DeviceReplacementController,
    PlatformDeviceReplacementController,
    DeviceLicensingController,
    PlatformDeviceLicensingController,
  ],
  providers: [DeviceReplacementService, DeviceLicensingService],
})
export class DeviceLicensingModule {}
