import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiStationAuth,
  ApiZodValidationError,
} from "../../lib/openapi";
import { AllowStationOrPermissions, RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  RequireSubscriptionWrite,
  AllowSubscriptionReadOnly,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  shiftCloseConflictListOpenApiSchema,
  stationShiftCloseOpenApiSchema,
  stationShiftCloseResponseOpenApiSchema,
  stationShiftCloseSchema,
  type ShiftCloseConflictListDto,
  type StationShiftCloseDto,
  type StationShiftCloseResponseDto,
} from "./dto";
import { StationShiftCloseService } from "./station-shift-close.service";

@ApiTags("station-shift-close")
@Controller()
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class StationShiftCloseController {
  constructor(private readonly service: StationShiftCloseService) {}

  @Post("station/shift-closures")
  @HttpCode(200)
  @UseGuards(StationOnlyGuard)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Record a station shift close",
    description:
      "Idempotent by `eventId`; a close raced by another device resolves to the `conflict` outcome instead of an error.",
  })
  @ApiStationAuth()
  @ApiBody({ schema: stationShiftCloseOpenApiSchema })
  @ApiOkResponse({ schema: stationShiftCloseResponseOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409, 429)
  close(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(stationShiftCloseSchema)) body: StationShiftCloseDto,
  ): Promise<StationShiftCloseResponseDto> {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.service.closeStationShift(req.tenantId!, req.deviceId, body);
  }

  @Get("shift-close-conflicts")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "List shift close conflicts" })
  @ApiCabinetAuth()
  @ApiOkResponse({ schema: shiftCloseConflictListOpenApiSchema })
  @ApiHttpErrors(401, 403)
  list(@Req() req: RequestWithTenant): Promise<ShiftCloseConflictListDto> {
    return this.service.listConflicts(req.tenantId!);
  }

  @Post("shift-close-conflicts/:eventId/dismiss")
  @HttpCode(204)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({ summary: "Dismiss a shift close conflict" })
  @ApiCabinetAuth()
  @ApiParam({ name: "eventId", format: "uuid" })
  @ApiResponse({ status: 204, description: "The conflict was dismissed." })
  @ApiHttpErrors(401, 403, 404)
  async dismiss(@Req() req: RequestWithTenant, @Param("eventId") eventId: string): Promise<void> {
    await this.service.dismissConflict(req.tenantId!, eventId, req.userId!);
  }
}
