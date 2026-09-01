import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
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
import { ApiCabinetAuth, ApiHttpErrors } from "../../lib/openapi";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import {
  nationalCatalogImportPreviewOpenApiSchema,
  nationalCatalogImportPreviewSchema,
  nationalCatalogLookupOpenApiSchema,
  type NationalCatalogImportPreviewDto,
} from "./dto";
import { NationalCatalogProductsService } from "./national-catalog-products.service";
import { NationalCatalogProposalService } from "./national-catalog-proposal.service";
import { ZodValidationPipe } from "../../zod.pipe";
import { ApiZodBody, ApiZodValidationError } from "../../lib/openapi";

@ApiTags("national-catalog")
@Controller("products/:id/national-catalog")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class NationalCatalogController {
  constructor(
    private readonly products: NationalCatalogProductsService,
    private readonly proposals: NationalCatalogProposalService,
  ) {}

  @Post("lookups")
  @HttpCode(200)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiOperation({ summary: "Read and snapshot National Catalog cards for a tenant product" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: nationalCatalogLookupOpenApiSchema })
  @ApiHttpErrors(401, 403, 404)
  @ApiCabinetAuth()
  lookup(@Req() request: RequestWithTenant, @Param("id", new ParseUUIDPipe()) productId: string) {
    return this.products.lookup(request.tenantId!, productId);
  }

  @Post("import-previews")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @ApiOperation({ summary: "Create a snapshot-backed National Catalog import proposal" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(nationalCatalogImportPreviewSchema)
  @ApiCreatedResponse({ schema: nationalCatalogImportPreviewOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  @ApiCabinetAuth()
  previewImport(
    @Req() request: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) productId: string,
    @Body(new ZodValidationPipe(nationalCatalogImportPreviewSchema))
    body: NationalCatalogImportPreviewDto,
  ) {
    return this.proposals.preview(request.tenantId!, request.userId!, productId, body.snapshotId);
  }
}
