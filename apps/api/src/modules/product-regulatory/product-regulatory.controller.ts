import { Body, Controller, Get, Param, Patch, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
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
  productReadinessOpenApiSchema,
  regulatoryCategoryOptionsOpenApiSchema,
  regulatoryProfileOpenApiSchema,
  updateRegulatoryAttributesSchema,
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
}
