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
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
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
  type ShiftDto,
  type UpdateShiftDto,
} from "./dto";
import { ShiftsService } from "./shifts.service";

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

  @Get(":id")
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
  async updateShift(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateShiftSchema)) body: UpdateShiftDto,
  ): Promise<ShiftDto> {
    return this.shiftsService.updateShift(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async deleteShift(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.shiftsService.deleteShift(req.tenantId!, id);
  }

  @Post(":id/close")
  @HttpCode(200)
  async closeShift(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(closeShiftSchema)) body: CloseShiftDto,
  ): Promise<ShiftDto> {
    return this.shiftsService.closeShift(req.tenantId!, id, body);
  }
}
