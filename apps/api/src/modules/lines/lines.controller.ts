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
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createLineSchema,
  updateLineSchema,
  type CreateLineDto,
  type LineDto,
  type ListLinesResponseDto,
  type UpdateLineDto,
} from "./dto";
import { LinesService } from "./lines.service";

@ApiTags("lines")
@Controller("lines")
// The station never calls this module. Cabinet authorization keeps a station
// api-key out even though TenantGuard accepts it for tenant resolution.
@UseGuards(TenantGuard, AuthorizationGuard)
export class LinesController {
  constructor(private readonly linesService: LinesService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async listLines(@Req() req: RequestWithTenant): Promise<ListLinesResponseDto> {
    return this.linesService.listLines(req.tenantId!);
  }

  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async getLine(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<LineDto> {
    return this.linesService.getLine(req.tenantId!, id);
  }

  @Post()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async createLine(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createLineSchema)) body: CreateLineDto,
  ): Promise<LineDto> {
    return this.linesService.createLine(req.tenantId!, body);
  }

  @Patch(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async updateLine(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateLineSchema)) body: UpdateLineDto,
  ): Promise<LineDto> {
    return this.linesService.updateLine(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async deleteLine(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.linesService.deleteLine(req.tenantId!, id);
  }
}
