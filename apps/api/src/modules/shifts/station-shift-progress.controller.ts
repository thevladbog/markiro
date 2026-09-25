import { Controller, ForbiddenException, Get, Param, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { ApiHttpErrors, ApiStationAuth } from "../../lib/openapi";
import { AllowSubscriptionRecovery } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { stationShiftProgressOpenApiSchema, type StationShiftProgressDto } from "./dto";
import { StationShiftProgressService } from "./station-shift-progress.service";

@ApiTags("station")
@Controller("station")
@UseGuards(TenantGuard, StationOnlyGuard, SubscriptionAccessGuard)
@ApiStationAuth()
export class StationShiftProgressController {
  constructor(private readonly service: StationShiftProgressService) {}

  @Get("shifts/:id/progress")
  @AllowSubscriptionRecovery("station")
  @ApiOperation({
    summary: "Read a shift's accepted-unit total",
    description:
      "Counts the shift's current code owners across every device and the calling device's share, so a station can add its own live count to the other devices' last known contribution. A foreign, unknown or malformed shift id answers 404.",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ schema: stationShiftProgressOpenApiSchema })
  @ApiHttpErrors(401, 403, 404, 429)
  async progress(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<StationShiftProgressDto> {
    // TenantGuard and StationOnlyGuard set both; the check narrows them without `!`.
    if (!req.tenantId || !req.deviceId) {
      throw new ForbiddenException("Station device authentication required");
    }
    return this.service.progress(req.tenantId, id, req.deviceId);
  }
}
