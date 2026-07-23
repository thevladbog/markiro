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
  createLabelTemplateSchema,
  updateLabelTemplateSchema,
  type CreateLabelTemplateDto,
  type LabelTemplateDto,
  type ListLabelTemplatesResponseDto,
  type UpdateLabelTemplateDto,
} from "./dto";
import { LabelTemplatesService } from "./label-templates.service";

@ApiTags("label-templates")
@Controller("label-templates")
@UseGuards(TenantGuard)
export class LabelTemplatesController {
  constructor(private readonly labelTemplatesService: LabelTemplatesService) {}

  @Get()
  async listLabelTemplates(@Req() req: RequestWithTenant): Promise<ListLabelTemplatesResponseDto> {
    return this.labelTemplatesService.listLabelTemplates(req.tenantId!);
  }

  @Get(":id")
  async getLabelTemplate(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<LabelTemplateDto> {
    return this.labelTemplatesService.getLabelTemplate(req.tenantId!, id);
  }

  @Post()
  async createLabelTemplate(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createLabelTemplateSchema)) body: CreateLabelTemplateDto,
  ): Promise<LabelTemplateDto> {
    return this.labelTemplatesService.createLabelTemplate(req.tenantId!, body);
  }

  @Patch(":id")
  async updateLabelTemplate(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateLabelTemplateSchema)) body: UpdateLabelTemplateDto,
  ): Promise<LabelTemplateDto> {
    return this.labelTemplatesService.updateLabelTemplate(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async deleteLabelTemplate(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.labelTemplatesService.deleteLabelTemplate(req.tenantId!, id);
  }
}
