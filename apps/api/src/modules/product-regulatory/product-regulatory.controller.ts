import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";

import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodValidationError,
} from "../../lib/openapi";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  applyRegulatoryProposalSchema,
  categoryChangePreviewSchema,
  egaisCodesBodySchema,
  productReadinessOpenApiSchema,
  regulatoryCategoryOptionsOpenApiSchema,
  regulatoryProfileOpenApiSchema,
  regulatoryProposalOpenApiSchema,
  regulatoryProposalPreviewOpenApiSchema,
  updateRegulatoryAttributesSchema,
  type ApplyRegulatoryProposalDto,
  type CategoryChangePreviewDto,
  type EgaisCodesBodyDto,
  type UpdateRegulatoryAttributesDto,
} from "./dto";
import { ProductReadinessService } from "./readiness.service";
import { ProductRegulatoryService } from "./product-regulatory.service";

@ApiTags("product-regulatory")
@Controller("products/:id")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class ProductRegulatoryController {
  constructor(
    private readonly regulatory: ProductRegulatoryService,
    private readonly readiness: ProductReadinessService,
  ) {}

  @Get("regulatory-profile")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Read a product regulatory profile" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: regulatoryProfileOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  @ApiCabinetAuth()
  getProfile(@Req() req: RequestWithTenant, @Param("id") id: string) {
    return this.regulatory.getProfile(req.tenantId!, id);
  }

  @Get("regulatory-category-options")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "List compatible active National Catalog categories" })
  @ApiOkResponse({ schema: regulatoryCategoryOptionsOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  @ApiCabinetAuth()
  getCategoryOptions(@Req() req: RequestWithTenant, @Param("id") id: string) {
    return this.regulatory.getCategoryOptions(req.tenantId!, id);
  }

  @Get("readiness")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Evaluate independent product readiness dimensions" })
  @ApiOkResponse({ schema: productReadinessOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  @ApiCabinetAuth()
  getReadiness(@Req() req: RequestWithTenant, @Param("id") id: string) {
    return this.readiness.getReadiness(req.tenantId!, id);
  }

  @Patch("regulatory-attributes")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Replace manual product regulatory attribute values" })
  @ApiZodBody(updateRegulatoryAttributesSchema)
  @ApiOkResponse({ schema: regulatoryProfileOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  @ApiCabinetAuth()
  updateAttributes(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateRegulatoryAttributesSchema))
    body: UpdateRegulatoryAttributesDto,
  ) {
    return this.regulatory.updateAttributes(req.tenantId!, req.userId!, id, body);
  }

  @Post("category-change-previews")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Preview and persist a product category change" })
  @ApiZodBody(categoryChangePreviewSchema)
  @ApiCreatedResponse({ schema: regulatoryProposalPreviewOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  @ApiCabinetAuth()
  previewCategoryChange(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(categoryChangePreviewSchema)) body: CategoryChangePreviewDto,
  ) {
    return this.regulatory.previewCategoryChange(req.tenantId!, req.userId!, id, body);
  }

  @Post("category-binding-previews")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Preview and persist an initial product category binding" })
  @ApiZodBody(categoryChangePreviewSchema)
  @ApiCreatedResponse({ schema: regulatoryProposalPreviewOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  @ApiCabinetAuth()
  previewCategoryBinding(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(categoryChangePreviewSchema)) body: CategoryChangePreviewDto,
  ) {
    return this.regulatory.previewCategoryBinding(req.tenantId!, req.userId!, id, body);
  }

  @Get("regulatory-proposals/:proposalId")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Read a persisted product regulatory proposal" })
  @ApiOkResponse({ schema: regulatoryProposalOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  @ApiCabinetAuth()
  getProposal(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Param("proposalId") proposalId: string,
  ) {
    return this.regulatory.getProposal(req.tenantId!, id, proposalId);
  }

  @Post("regulatory-proposals/:proposalId/reject")
  @HttpCode(200)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Reject a persisted product regulatory proposal" })
  @ApiOkResponse({ schema: regulatoryProposalOpenApiSchema })
  @ApiHttpErrors(401, 403, 404, 409)
  @ApiCabinetAuth()
  rejectProposal(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Param("proposalId") proposalId: string,
  ) {
    return this.regulatory.rejectProposal(req.tenantId!, req.userId!, id, proposalId);
  }

  @Post("regulatory-proposals/:proposalId/apply")
  @HttpCode(200)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Apply a persisted product regulatory proposal" })
  @ApiZodBody(applyRegulatoryProposalSchema)
  @ApiOkResponse({ schema: regulatoryProfileOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  @ApiCabinetAuth()
  applyProposal(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Param("proposalId") proposalId: string,
    @Body(new ZodValidationPipe(applyRegulatoryProposalSchema)) body: ApplyRegulatoryProposalDto,
  ) {
    return this.regulatory.applyProposal(req.tenantId!, req.userId!, id, proposalId, body);
  }

  @Put("egais-codes")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Replace the product EGAIS AP code collection" })
  @ApiZodBody(egaisCodesBodySchema)
  @ApiOkResponse({ schema: regulatoryProfileOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  @ApiCabinetAuth()
  replaceEgaisCodes(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(egaisCodesBodySchema)) body: EgaisCodesBodyDto,
  ) {
    return this.regulatory.replaceEgaisCodes(req.tenantId!, req.userId!, id, body);
  }
}
