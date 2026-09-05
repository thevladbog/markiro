import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  createUsProductSchema,
  listUsProductsQuerySchema,
  updateUsProductSchema,
  usProductListSchema,
  usProductSchema,
} from "@markiro/platform-contracts";
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

@Controller("traceability/catalog/products")
@UseGuards(UsSessionGuard)
@ApiTags("us-traceability-catalog")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description: "Malformed JSON or strict request validation failed.",
  schema: usMasterDataBadRequestSchema,
})
@ApiResponse({
  status: 401,
  description: "A US session is required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 403,
  description: "The current US role is not permitted.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 404,
  description: "The tenant-scoped product was not found.",
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
  description: "The US profile or database is unavailable.",
  schema: usMasterDataErrorSchema,
})
export class UsCatalogController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Get()
  @ApiOperation({ summary: "List products in the active US tenant" })
  @ApiZodQuery(listUsProductsQuerySchema)
  @ApiZodResponse({ status: 200, schema: usProductListSchema })
  list(@Req() request: UsRequest, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.catalog.listProducts(principal.tenantId, principal.userId, query),
    );
  }

  @Post()
  @ApiOperation({ summary: "Create a product in the active US tenant" })
  @ApiZodBody(createUsProductSchema)
  @ApiZodResponse({ status: 201, schema: usProductSchema })
  @ApiResponse({
    status: 409,
    description: "The requested active GTIN is taken.",
    schema: usMasterDataErrorSchema,
  })
  create(@Req() request: UsRequest, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.catalog.createProduct(
        principal.tenantId,
        principal.userId,
        body,
        this.requestId(request),
      ),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Read one tenant-scoped US product" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: usProductSchema })
  get(@Req() request: UsRequest, @Param("id") id: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.catalog.getProduct(principal.tenantId, principal.userId, id),
    );
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update, archive or restore a tenant-scoped US product" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(updateUsProductSchema)
  @ApiZodResponse({ status: 200, schema: usProductSchema })
  @ApiResponse({
    status: 409,
    description: "The GTIN is taken or locked by operational references.",
    schema: usMasterDataErrorSchema,
  })
  update(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.catalog.updateProduct(
        principal.tenantId,
        principal.userId,
        id,
        body,
        this.requestId(request),
      ),
    );
  }

  private principal(request: UsRequest) {
    if (!request.usPrincipal) throw new UnauthorizedException("us_session_required");
    return request.usPrincipal;
  }

  private requestId(request: UsRequest): string {
    if (!request.usRequestId) throw new UnauthorizedException("us_request_context_required");
    return request.usRequestId;
  }
}
