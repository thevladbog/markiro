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
  AllowSubscriptionReadOnly,
  RequireFeature,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
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
// The station never calls this module. Cabinet authorization keeps a station
// api-key out even though TenantGuard accepts it for tenant resolution.
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class LabelTemplatesController {
  constructor(private readonly labelTemplatesService: LabelTemplatesService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async listLabelTemplates(@Req() req: RequestWithTenant): Promise<ListLabelTemplatesResponseDto> {
    return this.labelTemplatesService.listLabelTemplates(req.tenantId!);
  }

  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async getLabelTemplate(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<LabelTemplateDto> {
    return this.labelTemplatesService.getLabelTemplate(req.tenantId!, id);
  }

  @Post()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireFeature("labelEditor")
  async createLabelTemplate(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createLabelTemplateSchema)) body: CreateLabelTemplateDto,
  ): Promise<LabelTemplateDto> {
    return this.labelTemplatesService.createLabelTemplate(req.tenantId!, body);
  }

  @Patch(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireFeature("labelEditor")
  async updateLabelTemplate(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateLabelTemplateSchema)) body: UpdateLabelTemplateDto,
  ): Promise<LabelTemplateDto> {
    return this.labelTemplatesService.updateLabelTemplate(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireFeature("labelEditor")
  async deleteLabelTemplate(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.labelTemplatesService.deleteLabelTemplate(req.tenantId!, id);
  }
}
