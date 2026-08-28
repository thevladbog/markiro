import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  ApiCabinetAuth,
  ApiCabinetOrStationAuth,
  ApiHttpErrors,
  ApiStationAuth,
  ApiZodBody,
  ApiZodQuery,
  ApiZodValidationError,
} from "../../lib/openapi";
import { AllowStationOrPermissions, RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  AllowSubscriptionReadOnly,
  AllowSubscriptionRecovery,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import {
  closeShiftSchema,
  createShiftOpenApiSchema,
  createShiftSchema,
  listShiftsQuerySchema,
  listShiftsOpenApiSchema,
  shiftBoxLabelTemplatesOpenApiSchema,
  shiftBundleOpenApiSchema,
  shiftOpenApiSchema,
  shiftPlanningConfigOpenApiSchema,
  shiftReferenceBundleOpenApiSchema,
  updateShiftOpenApiSchema,
  updateShiftSchema,
  type CloseShiftDto,
  type CreateShiftDto,
  type ListShiftsQueryDto,
  type ListShiftsResponseDto,
  type ShiftBoxLabelTemplatesDto,
  type ShiftBundleDto,
  type ShiftDto,
  type ShiftPlanningConfigDto,
  type ShiftReferenceBundleDto,
  type UpdateShiftDto,
} from "./dto";
import { ShiftsService, type EffectiveListShiftsQuery } from "./shifts.service";

@ApiTags("shifts")
@Controller("shifts")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class ShiftsController {
  constructor(private readonly shiftsService: ShiftsService) {}

  @Get()
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "List shifts",
    description:
      "A station credential that omits `lineId` is scoped to its own line, including unassigned shifts.",
  })
  @ApiCabinetOrStationAuth()
  @ApiZodQuery(listShiftsQuerySchema)
  @ApiOkResponse({ schema: listShiftsOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 429)
  async listShifts(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listShiftsQuerySchema)) query: ListShiftsQueryDto,
  ): Promise<ListShiftsResponseDto> {
    const effectiveQuery: EffectiveListShiftsQuery =
      req.authKind === "station" && query.lineId === undefined && req.deviceLineId
        ? { ...query, lineId: req.deviceLineId, includeUnassigned: true }
        : query;
    return this.shiftsService.listShifts(req.tenantId!, effectiveQuery);
  }

  @Get("planning-config")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Read the shift planning configuration" })
  @ApiCabinetAuth()
  @ApiOkResponse({ schema: shiftPlanningConfigOpenApiSchema })
  @ApiHttpErrors(401, 403)
  async getPlanningConfig(@Req() req: RequestWithTenant): Promise<ShiftPlanningConfigDto> {
    return this.shiftsService.getPlanningConfig(req.tenantId!);
  }

  // Station-readable template summaries for the NewShift picker. Specs stay
  // cabinet-only; the station receives a spec exclusively through the shift
  // bundle after the snapshot exists (see docs/device-key-surface.md).
  @Get("box-label-templates")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "List box label template options",
    description:
      "Template summaries only; a station receives a template spec exclusively through the shift bundle.",
  })
  @ApiCabinetOrStationAuth()
  @ApiOkResponse({ schema: shiftBoxLabelTemplatesOpenApiSchema })
  @ApiHttpErrors(401, 403, 429)
  async listBoxLabelTemplates(@Req() req: RequestWithTenant): Promise<ShiftBoxLabelTemplatesDto> {
    return this.shiftsService.listBoxLabelTemplates(req.tenantId!);
  }

  // Cabinet-only: not one of the station's six routes (list, create, open,
  // bundle, reference bundle, box-label-templates) here. A device reading an
  // arbitrary shift by id has no legitimate use once it can already
  // list/open/bundle its own.
  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Read a shift" })
  @ApiCabinetAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ schema: shiftOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  async getShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ShiftDto> {
    return this.shiftsService.getShift(req.tenantId!, id);
  }

  @Post()
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Create a shift",
    description:
      "Omitted capacities and counterparty are prefilled from the product; a station-created shift is pinned to the device's line.",
  })
  @ApiCabinetOrStationAuth()
  @ApiBody({ schema: createShiftOpenApiSchema })
  @ApiCreatedResponse({ schema: shiftOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 409, 422, 429)
  async createShift(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createShiftSchema)) body: CreateShiftDto,
  ): Promise<ShiftDto> {
    if (req.authKind === "station") {
      return this.shiftsService.createShift(
        req.tenantId!,
        {
          ...body,
          lineId: req.deviceLineId ?? null,
        },
        "station",
      );
    }
    return this.shiftsService.createShift(req.tenantId!, body, "admin");
  }

  @Patch(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Update a shift",
    description:
      "Planned shifts accept the full shape; active shifts accept only line/date/quantity/box-template metadata.",
  })
  @ApiCabinetAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ schema: updateShiftOpenApiSchema })
  @ApiOkResponse({ schema: shiftOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409, 422)
  async updateShift(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateShiftSchema)) body: UpdateShiftDto,
  ): Promise<ShiftDto> {
    return this.shiftsService.updateShift(req.tenantId!, req.userId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({ summary: "Delete a planned shift" })
  @ApiCabinetAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiResponse({ status: 204, description: "The shift was deleted." })
  @ApiHttpErrors(401, 403, 404, 409)
  async deleteShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.shiftsService.deleteShift(req.tenantId!, id);
  }

  // Cabinet-only: closing a shift from the station is deliberately not a
  // station action (see docs/device-key-surface.md).
  @Post(":id/close")
  @HttpCode(200)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @AllowSubscriptionRecovery("shift")
  @ApiOperation({
    summary: "Close a shift",
    description: "Cabinet-only: closing a shift is deliberately not a station action.",
  })
  @ApiCabinetAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiZodBody(closeShiftSchema)
  @ApiOkResponse({ schema: shiftOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  async closeShift(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(closeShiftSchema)) body: CloseShiftDto,
  ): Promise<ShiftDto> {
    return this.shiftsService.closeShift(req.tenantId!, id, body);
  }

  @Post(":id/open")
  @HttpCode(200)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({ summary: "Open a shift" })
  @ApiCabinetOrStationAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ schema: shiftOpenApiSchema })
  @ApiHttpErrors(401, 403, 404, 409, 429)
  async openShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ShiftDto> {
    return this.shiftsService.openShift(req.tenantId!, id, req.deviceId);
  }

  @Post(":id/enter")
  @HttpCode(200)
  @UseGuards(StationOnlyGuard)
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Enter an active shift from a station",
    description: "Station-only: records the calling device as a participant of an open shift.",
  })
  @ApiStationAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ schema: shiftOpenApiSchema })
  @ApiHttpErrors(401, 403, 404, 409, 429)
  async enterShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ShiftDto> {
    if (!req.deviceId) throw new Error("Station device identity is missing");
    return this.shiftsService.enterShift(req.tenantId!, id, req.deviceId);
  }

  @Get(":id/bundle")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @AllowSubscriptionRecovery("shift")
  @ApiOperation({
    summary: "Download the shift bundle",
    description:
      "Everything the station needs offline. On aggregation shifts a station caller also allocates or reconciles its SSCC serial block.",
  })
  @ApiCabinetOrStationAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ schema: shiftBundleOpenApiSchema })
  @ApiHttpErrors(400, 401, 403, 404, 429)
  async getBundle(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ShiftBundleDto> {
    return this.shiftsService.getBundle(req.tenantId!, id, req.deviceId ?? null);
  }

  @Get(":id/reference-bundle")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @AllowSubscriptionRecovery("shift")
  @ApiOperation({
    summary: "Download the reference shift bundle",
    description: "Mirrored reference data only; never allocates or reconciles an SSCC block.",
  })
  @ApiCabinetOrStationAuth()
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ schema: shiftReferenceBundleOpenApiSchema })
  @ApiHttpErrors(401, 403, 404, 429)
  async getReferenceBundle(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<ShiftReferenceBundleDto> {
    return this.shiftsService.getReferenceBundle(req.tenantId!, id);
  }
}
