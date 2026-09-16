import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  stationDeviceReplacementContracts,
  type DeviceReplacementReadinessRequest,
} from "@markiro/platform-contracts";
import { ApiHttpErrors, ApiStationAuth, ApiZodBody, ApiZodResponse } from "../../lib/openapi";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { AllowSubscriptionRecovery } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { DeviceReplacementReadinessService } from "./device-replacement-readiness.service";
function identity(req: RequestWithTenant) {
  if (
    req.authKind !== "station" ||
    !req.deviceKind ||
    !req.deviceId ||
    !req.tenantId ||
    !req.deviceApiKeyId
  )
    throw new UnauthorizedException();
  return {
    tenantId: req.tenantId,
    deviceId: req.deviceId,
    kind: req.deviceKind,
    apiKeyId: req.deviceApiKeyId,
  };
}
@ApiTags("station")
@ApiStationAuth()
@Controller("station")
@UseGuards(TenantGuard, StationOnlyGuard, SubscriptionAccessGuard)
@AllowSubscriptionRecovery("replacement_readiness")
export class DeviceReplacementReadinessController {
  constructor(private readonly readiness: DeviceReplacementReadinessService) {}
  @Get("device-replacement-intent")
  @ApiOperation({ summary: "Read the authenticated device replacement drain intent" })
  @ApiZodResponse({ status: 200, schema: stationDeviceReplacementContracts.currentIntent.response })
  @ApiHttpErrors(401, 403, 429)
  currentIntent(@Req() req: RequestWithTenant) {
    return this.readiness.currentIntent(identity(req));
  }
  @Post("device-replacement-readiness")
  @AllowSubscriptionRecovery("replacement_readiness")
  @HttpCode(200)
  @ApiOperation({ summary: "Report bounded device replacement readiness evidence" })
  @ApiZodBody(stationDeviceReplacementContracts.report.body)
  @ApiZodResponse({ status: 200, schema: stationDeviceReplacementContracts.report.response })
  @ApiHttpErrors(400, 401, 403, 404, 409, 429)
  report(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(stationDeviceReplacementContracts.report.body))
    body: DeviceReplacementReadinessRequest,
  ) {
    return this.readiness.report(identity(req), body);
  }
}
