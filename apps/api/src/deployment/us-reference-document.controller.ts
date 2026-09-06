import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  listReferenceDocumentsQuerySchema,
  referenceDocumentInputSchema,
  referenceDocumentListSchema,
  referenceDocumentSchema,
} from "@markiro/platform-contracts";
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

@Controller("traceability/reference-documents")
@UseGuards(UsSessionGuard)
@ApiTags("us-traceability-reference-documents")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description: "Malformed JSON or strict input validation failed.",
  schema: usMasterDataBadRequestSchema,
})
@ApiResponse({
  status: 401,
  description: "A verified US session is required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 403,
  description: "Current capability, profile, Host or Origin is not permitted.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 404,
  description: "Tenant-scoped document or active issuer was not found.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 413,
  description: "JSON body exceeds 16 KiB.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 415,
  description: "Uncompressed application/json is required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 503,
  description: "The US profile or database is unavailable.",
  schema: usMasterDataErrorSchema,
})
export class UsReferenceDocumentController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Get()
  @ApiOperation({ summary: "List reference-document metadata in the active US tenant" })
  @ApiZodQuery(listReferenceDocumentsQuerySchema)
  @ApiZodResponse({ status: 200, schema: referenceDocumentListSchema })
  list(@Req() request: UsRequest, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.referenceDocuments.listDocuments(principal.tenantId, principal.userId, query),
    );
  }

  @Post()
  @ApiOperation({
    summary:
      "Create metadata without an attachment; receiving, production or shipping write capability required",
  })
  @ApiZodBody(referenceDocumentInputSchema)
  @ApiZodResponse({ status: 201, schema: referenceDocumentSchema })
  @ApiResponse({
    status: 409,
    description:
      "document_duplicate: number already exists for this tenant, type and issuer, including archived records.",
    schema: usMasterDataErrorSchema,
  })
  create(@Req() request: UsRequest, @Body() body: unknown) {
    const principal = this.principal(request);
    if (!request.usRequestId) throw new UnauthorizedException("us_request_context_required");
    const requestId = request.usRequestId;
    return this.runtime.databaseOperation(() =>
      this.runtime.referenceDocuments.createDocument(
        principal.tenantId,
        principal.userId,
        body,
        requestId,
      ),
    );
  }

  @Get(":id")
  @ApiOperation({
    summary: "Read one tenant-scoped reference document, including archived metadata",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: referenceDocumentSchema })
  get(@Req() request: UsRequest, @Param("id") id: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.referenceDocuments.getDocument(principal.tenantId, principal.userId, id),
    );
  }

  private principal(request: UsRequest) {
    if (!request.usPrincipal) throw new UnauthorizedException("us_session_required");
    return request.usPrincipal;
  }
}
