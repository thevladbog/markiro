import { DeviceReplacementTargetPairingService } from "./device-replacement-target-pairing.service";
import { DeviceReplacementRecoveryService } from "./device-replacement-recovery.service";
import { ReplacementRecoveryReadinessController } from "./replacement-recovery-readiness.controller";
import { DeviceReplacementExecutionService } from "./device-replacement-execution.service";
import { DeviceReplacementExecutionRepairService } from "./device-replacement-execution-repair.service";
import { DeviceReplacementReadinessController } from "./device-replacement-readiness.controller";
import { DeviceReplacementReadinessService } from "./device-replacement-readiness.service";
import { DeviceRetentionService } from "./device-retention.service";
import { DeviceRetentionController } from "./device-retention.controller";
import { PlatformDeviceRetentionController } from "./platform-device-retention.controller";
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
    ReplacementRecoveryReadinessController,
    DeviceRetentionController,
    PlatformDeviceRetentionController,
    DeviceReplacementController,
    DeviceReplacementReadinessController,
    PlatformDeviceReplacementController,
    DeviceLicensingController,
    PlatformDeviceLicensingController,
  ],
  providers: [
    DeviceReplacementTargetPairingService,
    DeviceReplacementRecoveryService,
    DeviceReplacementExecutionService,
    DeviceReplacementExecutionRepairService,
    DeviceReplacementReadinessService,
    DeviceRetentionService,
    DeviceReplacementService,
    DeviceLicensingService,
  ],
})
export class DeviceLicensingModule {}
