import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  productTraceabilityProfileSchema,
  putProductTraceabilityProfileSchema,
} from "@markiro/platform-contracts";
import { ApiZodBody, ApiZodResponse } from "../lib/openapi";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

@Controller("traceability/products")
@UseGuards(UsSessionGuard)
@ApiTags("us-product-traceability-profile")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description: "Malformed JSON, product UUID or strict profile input.",
  schema: usMasterDataBadRequestSchema,
})
@ApiResponse({
  status: 401,
  description: "A US session is required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 403,
  description: "Trusted host/origin, verified MFA and current role permissions are required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 404,
  description: "The tenant-owned product was not found.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 413,
  description: "JSON body exceeds 16 KiB.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 415,
  description: "An uncompressed application/json body is required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 503,
  description: "The US profile or database is unavailable or contains invalid data.",
  schema: usMasterDataErrorSchema,
})
export class UsProductProfileController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Get(":productId")
  @ApiOperation({
    summary: "Read a tenant-scoped product description and manual FTL review",
    description:
      "Requires traceability.read. An unsaved profile returns revision 0 and catalog-derived defaults without creating data. Coverage is not a compliance or export-readiness claim.",
  })
  @ApiParam({ name: "productId", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: productTraceabilityProfileSchema })
  get(@Req() request: UsRequest, @Param("productId") productId: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.productProfiles.getProfile(principal.tenantId, principal.userId, productId),
    );
  }

  @Put(":productId")
  @ApiOperation({
    summary: "Save a versioned product description and manual FTL review",
    description:
      "Requires traceability.master_data.write; changes to any coverage field also require traceability.qa.manage. Full editable document plus expectedRevision is mandatory. Tenant, review actor/time, revision and audit request ID are server-owned. Unchanged current saves and identical immediate retries do not create revisions or audit. Generic US tenants cannot store FTL classifications.",
  })
  @ApiParam({ name: "productId", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(putProductTraceabilityProfileSchema)
  @ApiZodResponse({ status: 200, schema: productTraceabilityProfileSchema })
  @ApiResponse({
    status: 409,
    description:
      "product_profile_conflict: reload the latest profile before applying a different revision.",
    schema: usMasterDataErrorSchema,
  })
  put(@Req() request: UsRequest, @Param("productId") productId: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    const requestId = request.usRequestId;
    if (!requestId) throw new UnauthorizedException("us_request_context_required");
    return this.runtime.databaseOperation(() =>
      this.runtime.productProfiles.putProfile(
        principal.tenantId,
        principal.userId,
        productId,
        body,
        requestId,
      ),
    );
  }

  private principal(request: UsRequest) {
    if (!request.usPrincipal) throw new UnauthorizedException("us_session_required");
    return request.usPrincipal;
  }
}
