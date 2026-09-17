import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  deviceReplacementReadinessRequestSchema,
  deviceReplacementReadinessResponseSchema,
  type DeviceReplacementReadinessRequest,
} from "@markiro/platform-contracts";
import { ApiHttpErrors, ApiStationAuth, ApiZodBody, ApiZodResponse } from "../../lib/openapi";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { AllowSubscriptionRecovery } from "../../subscriptions/subscription-access-policy";
import { ZodValidationPipe } from "../../zod.pipe";
import { AllowReplacementEvidenceRecovery } from "./replacement-recovery-policy";
import { DeviceReplacementRecoveryService } from "./device-replacement-recovery.service";
@ApiTags("station")
@ApiStationAuth()
@Controller("station/replacement-recovery")
@UseGuards(TenantGuard, StationOnlyGuard, SubscriptionAccessGuard)
export class ReplacementRecoveryReadinessController {
  constructor(private readonly recovery: DeviceReplacementRecoveryService) {}
  @Post("readiness")
  @HttpCode(200)
  @AllowReplacementEvidenceRecovery()
  @AllowSubscriptionRecovery("replacement_readiness")
  @ApiOperation({ summary: "Report source evidence recovery; fresh zero revokes this credential" })
  @ApiZodBody(deviceReplacementReadinessRequestSchema)
  @ApiZodResponse({ status: 200, schema: deviceReplacementReadinessResponseSchema })
  @ApiHttpErrors(400, 401, 403, 409)
  report(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(deviceReplacementReadinessRequestSchema))
    body: DeviceReplacementReadinessRequest,
  ) {
    if (
      !req.replacementRecoveryExecutionId ||
      !req.deviceApiKeyId ||
      !req.deviceId ||
      !req.deviceKind ||
      !req.tenantId
    )
      throw new UnauthorizedException();
    return this.recovery.report(
      {
        tenantId: req.tenantId,
        deviceId: req.deviceId,
        kind: req.deviceKind,
        apiKeyId: req.deviceApiKeyId,
      },
      req.replacementRecoveryExecutionId,
      body,
    );
  }
}
