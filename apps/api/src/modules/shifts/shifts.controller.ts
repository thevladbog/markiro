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
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { SessionOnlyGuard } from "../../tenancy/session-only.guard";
import { ZodValidationPipe } from "../../zod.pipe";
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
  type UpdateShiftDto,
} from "./dto";
import { ShiftsService } from "./shifts.service";

@ApiTags("shifts")
@Controller("shifts")
@UseGuards(TenantGuard)
export class ShiftsController {
  constructor(private readonly shiftsService: ShiftsService) {}

  @Get()
  async listShifts(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listShiftsQuerySchema)) query: ListShiftsQueryDto,
  ): Promise<ListShiftsResponseDto> {
    return this.shiftsService.listShifts(req.tenantId!, query);
  }

  // Session-only: not one of the station's four routes (list, create, open,
  // bundle) below. A device reading an arbitrary shift by id has no
  // legitimate use once it can already list/open/bundle its own.
  @Get(":id")
  @UseGuards(SessionOnlyGuard)
  async getShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ShiftDto> {
    return this.shiftsService.getShift(req.tenantId!, id);
  }

  @Post()
  async createShift(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createShiftSchema)) body: CreateShiftDto,
  ): Promise<ShiftDto> {
    return this.shiftsService.createShift(req.tenantId!, body);
  }

  @Patch(":id")
  @UseGuards(SessionOnlyGuard)
  async updateShift(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateShiftSchema)) body: UpdateShiftDto,
  ): Promise<ShiftDto> {
    return this.shiftsService.updateShift(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @UseGuards(SessionOnlyGuard)
  async deleteShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.shiftsService.deleteShift(req.tenantId!, id);
  }

  // Session-only: closing a shift from the station is deliberately not a
  // station action (see docs/device-key-surface.md).
  @Post(":id/close")
  @HttpCode(200)
  @UseGuards(SessionOnlyGuard)
  async closeShift(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(closeShiftSchema)) body: CloseShiftDto,
  ): Promise<ShiftDto> {
    return this.shiftsService.closeShift(req.tenantId!, id, body);
  }

  @Post(":id/open")
  @HttpCode(200)
  async openShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ShiftDto> {
    return this.shiftsService.openShift(req.tenantId!, id);
  }

  @Get(":id/bundle")
  async getBundle(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<ShiftBundleDto> {
    return this.shiftsService.getBundle(req.tenantId!, id, req.deviceId ?? null);
  }
}
