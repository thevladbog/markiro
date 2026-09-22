import {
  Body,
  Headers,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Query,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiHeader, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  stationDeviceReplacementContracts,
  type DeviceReplacementReadinessRequest,
  type DeviceReplacementClosureAcknowledgementRequest,
} from "@markiro/platform-contracts";
import {
  ApiHttpErrors,
  ApiStationAuth,
  ApiZodBody,
  ApiZodResponse,
  ApiZodQuery,
} from "../../lib/openapi";
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
  @ApiHeader({
    name: "x-station-capabilities",
    required: false,
    description:
      "Includes replacement-readiness-v1 to receive a supported drain intent; otherwise returns null.",
  })
  currentIntent(
    @Req() req: RequestWithTenant,
    @Headers("x-station-capabilities") capabilities?: string,
  ) {
    return this.readiness.currentIntent(identity(req), capabilities);
  }

  @Get("device-replacement-intent/v1")
  @ApiOperation({ summary: "Read a versioned drain or explicit source closure tombstone" })
  @ApiZodResponse({
    status: 200,
    schema: stationDeviceReplacementContracts.currentIntentV1.response,
  })
  @ApiZodQuery(stationDeviceReplacementContracts.currentIntentV1.query)
  @ApiHttpErrors(400, 401, 403, 429)
  @ApiHeader({
    name: "x-station-capabilities",
    required: false,
    description:
      "Explicit replacement-readiness-v1 records capability evidence for this authenticated tenant/device/current credential epoch for five minutes. Missing capability replaces previous support and returns none.",
  })
  currentIntentV1(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(stationDeviceReplacementContracts.currentIntentV1.query))
    query: { knownIntentId?: string },
    @Headers("x-station-capabilities") capabilities?: string,
  ) {
    return this.readiness.currentIntentProjection(identity(req), query.knownIntentId, capabilities);
  }
  @Post("device-replacement-intent/v1/acknowledge")
  @AllowSubscriptionRecovery("replacement_readiness")
  @HttpCode(200)
  @ApiOperation({
    summary: "Acknowledge an exact replacement closure from the authenticated source",
  })
  @ApiZodBody(stationDeviceReplacementContracts.acknowledgeClosure.body)
  @ApiZodResponse({
    status: 200,
    schema: stationDeviceReplacementContracts.acknowledgeClosure.response,
  })
  @ApiHttpErrors(400, 401, 403, 404, 409, 429)
  acknowledgeClosure(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(stationDeviceReplacementContracts.acknowledgeClosure.body))
    body: DeviceReplacementClosureAcknowledgementRequest,
  ) {
    return this.readiness.acknowledgeClosure(identity(req), body);
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
