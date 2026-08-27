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
import {
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
  ApiHttpErrors,
  ApiZodBody,
  ApiZodValidationError,
} from "../../lib/openapi";
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
  labelTemplateOpenApiSchema,
  listLabelTemplatesOpenApiSchema,
  updateLabelTemplateSchema,
  type CreateLabelTemplateDto,
  type LabelTemplateDto,
  type ListLabelTemplatesResponseDto,
  type UpdateLabelTemplateDto,
} from "./dto";
import { LabelTemplatesService } from "./label-templates.service";

@ApiTags("label-templates")
@ApiCabinetAuth()
@Controller("label-templates")
// The station never calls this module. Cabinet authorization keeps a station
// api-key out even though TenantGuard accepts it for tenant resolution.
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class LabelTemplatesController {
  constructor(private readonly labelTemplatesService: LabelTemplatesService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({
    summary: "List label templates",
    description: "Size/DPI/language summaries without the full spec, most recently updated first.",
  })
  @ApiOkResponse({ schema: listLabelTemplatesOpenApiSchema })
  @ApiHttpErrors(401, 403)
  async listLabelTemplates(@Req() req: RequestWithTenant): Promise<ListLabelTemplatesResponseDto> {
    return this.labelTemplatesService.listLabelTemplates(req.tenantId!);
  }

  @Get(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Get a label template" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: labelTemplateOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  async getLabelTemplate(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<LabelTemplateDto> {
    return this.labelTemplatesService.getLabelTemplate(req.tenantId!, id);
  }

  @Post()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireFeature("labelEditor")
  @ApiOperation({
    summary: "Create a label template",
    description:
      "spec is validated against the @markiro/domain label model; every issue is reported in the 400 body's message list.",
  })
  @ApiZodBody(createLabelTemplateSchema)
  @ApiCreatedResponse({ schema: labelTemplateOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  async createLabelTemplate(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createLabelTemplateSchema)) body: CreateLabelTemplateDto,
  ): Promise<LabelTemplateDto> {
    return this.labelTemplatesService.createLabelTemplate(req.tenantId!, body);
  }

  @Patch(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireFeature("labelEditor")
  @ApiOperation({
    summary: "Update a label template",
    description: "Partial update; untouched fields are preserved.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(updateLabelTemplateSchema)
  @ApiOkResponse({ schema: labelTemplateOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
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
  @ApiOperation({ summary: "Delete a label template" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 204, description: "Label template deleted." })
  @ApiHttpErrors(401, 403, 404, 409)
  async deleteLabelTemplate(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.labelTemplatesService.deleteLabelTemplate(req.tenantId!, id);
  }
}
