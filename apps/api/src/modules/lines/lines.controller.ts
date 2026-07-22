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

@Controller("lines")
@UseGuards(TenantGuard)
export class LinesController {
  constructor(private readonly linesService: LinesService) {}

  @Get()
  async listLines(@Req() req: RequestWithTenant): Promise<ListLinesResponseDto> {
    return this.linesService.listLines(req.tenantId!);
  }

  @Get(":id")
  async getLine(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<LineDto> {
    return this.linesService.getLine(req.tenantId!, id);
  }

  @Post()
  async createLine(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createLineSchema)) body: CreateLineDto,
  ): Promise<LineDto> {
    return this.linesService.createLine(req.tenantId!, body);
  }

  @Patch(":id")
  async updateLine(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateLineSchema)) body: UpdateLineDto,
  ): Promise<LineDto> {
    return this.linesService.updateLine(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async deleteLine(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.linesService.deleteLine(req.tenantId!, id);
  }
}
