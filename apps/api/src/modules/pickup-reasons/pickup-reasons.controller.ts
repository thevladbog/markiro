import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createReasonSchema,
  updateReasonSchema,
  type CreateReasonDto,
  type ListReasonsResponseDto,
  type ReasonDto,
  type UpdateReasonDto,
} from "./dto";
import { PickupReasonsService } from "./pickup-reasons.service";

@ApiTags("pickup-reasons")
@Controller("pickup-reasons")
@UseGuards(TenantGuard)
export class PickupReasonsController {
  constructor(private readonly pickupReasonsService: PickupReasonsService) {}

  @Get()
  async listReasons(@Req() req: RequestWithTenant): Promise<ListReasonsResponseDto> {
    return this.pickupReasonsService.listReasons(req.tenantId!);
  }

  @Post()
  async createReason(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createReasonSchema)) body: CreateReasonDto,
  ): Promise<ReasonDto> {
    return this.pickupReasonsService.createReason(req.tenantId!, body);
  }

  @Patch(":id")
  async updateReason(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateReasonSchema)) body: UpdateReasonDto,
  ): Promise<ReasonDto> {
    return this.pickupReasonsService.updateReason(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async archiveReason(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.pickupReasonsService.archiveReason(req.tenantId!, id);
  }
}
