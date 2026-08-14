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
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { AllowStationOrPermissions, RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  AllowSubscriptionReadOnly,
  AllowSubscriptionRecovery,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import {
  closeShiftSchema,
  createShiftSchema,
  listShiftsQuerySchema,
  updateShiftSchema,
  type CloseShiftDto,
  type CreateShiftDto,
  type ListShiftsQueryDto,
  type ListShiftsResponseDto,
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
  async getPlanningConfig(@Req() req: RequestWithTenant): Promise<ShiftPlanningConfigDto> {
    return this.shiftsService.getPlanningConfig(req.tenantId!);
  }

  // Cabinet-only: not one of the station's five routes (list, create, open,
  // bundle, reference bundle) below. A device reading an arbitrary shift by id has no
  // legitimate use once it can already list/open/bundle its own.
  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async getShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ShiftDto> {
    return this.shiftsService.getShift(req.tenantId!, id);
  }

  @Post()
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  async createShift(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createShiftSchema)) body: CreateShiftDto,
  ): Promise<ShiftDto> {
    return this.shiftsService.createShift(req.tenantId!, body);
  }

  @Patch(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  async updateShift(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateShiftSchema)) body: UpdateShiftDto,
  ): Promise<ShiftDto> {
    return this.shiftsService.updateShift(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  async deleteShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.shiftsService.deleteShift(req.tenantId!, id);
  }

  // Cabinet-only: closing a shift from the station is deliberately not a
  // station action (see docs/device-key-surface.md).
  @Post(":id/close")
  @HttpCode(200)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @AllowSubscriptionRecovery("shift")
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
  async openShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ShiftDto> {
    return this.shiftsService.openShift(req.tenantId!, id);
  }

  @Get(":id/bundle")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @AllowSubscriptionRecovery("shift")
  async getBundle(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ShiftBundleDto> {
    return this.shiftsService.getBundle(req.tenantId!, id, req.deviceId ?? null);
  }

  @Get(":id/reference-bundle")
  @AllowStationOrPermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @AllowSubscriptionRecovery("shift")
  async getReferenceBundle(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<ShiftReferenceBundleDto> {
    return this.shiftsService.getReferenceBundle(req.tenantId!, id);
  }
}
