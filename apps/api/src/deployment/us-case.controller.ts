import {
  Body,
  Controller,
  Get,
  HttpCode,
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
  caseLinkCommandSchema,
  caseLinkResultSchema,
  caseListQuerySchema,
  caseListResultSchema,
  caseLookupQuerySchema,
  caseLookupResultSchema,
  caseUnlinkCommandSchema,
  caseUnlinkResultSchema,
} from "@markiro/platform-contracts";
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

@Controller("traceability")
@UseGuards(UsSessionGuard)
@ApiTags("us-traceability-cases")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description: "Invalid ID, query or strict body.",
  schema: usMasterDataBadRequestSchema,
})
@ApiResponse({
  status: 401,
  description: "Verified US session required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 403,
  description: "Current US membership or capability required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 404,
  description: "Case or lot not found in tenant.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 409,
  description: "Case link, origin, stale target or operation conflict.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({ status: 413, description: "Body exceeds 16 KiB.", schema: usMasterDataErrorSchema })
@ApiResponse({
  status: 415,
  description: "Uncompressed JSON required for writes.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 503,
  description: "US storage unavailable.",
  schema: usMasterDataErrorSchema,
})
export class UsCaseController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Get("cases/lookup")
  @ApiOperation({ summary: "Look up one tenant case by current normalized SSCC" })
  @ApiZodQuery(caseLookupQuerySchema)
  @ApiZodResponse({ status: 200, schema: caseLookupResultSchema })
  lookup(@Req() request: UsRequest, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.cases.lookup(principal.tenantId, principal.userId, query),
    );
  }

  @Get("lots/:lotId/cases")
  @ApiOperation({
    summary: "List tenant lot cases and active count",
    description:
      "Cursor pagination reads live link history; concurrent inserts may appear on later pages.",
  })
  @ApiParam({ name: "lotId", schema: { type: "string", format: "uuid" } })
  @ApiZodQuery(caseListQuerySchema)
  @ApiZodResponse({ status: 200, schema: caseListResultSchema })
  list(@Req() request: UsRequest, @Param("lotId") lotId: unknown, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.cases.list(principal.tenantId, principal.userId, lotId, query),
    );
  }

  @Post("lots/:lotId/cases")
  @HttpCode(200)
  @ApiOperation({ summary: "Link 1–100 eligible tenant cases to a current output lot" })
  @ApiParam({ name: "lotId", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(caseLinkCommandSchema)
  @ApiZodResponse({ status: 200, schema: caseLinkResultSchema })
  link(@Req() request: UsRequest, @Param("lotId") lotId: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.cases.link(
        principal.tenantId,
        principal.userId,
        lotId,
        body,
        this.requestId(request),
      ),
    );
  }

  @Post("lots/:lotId/cases/:linkId/unlink")
  @HttpCode(200)
  @ApiOperation({ summary: "Unlink one exact active case link with a reason" })
  @ApiParam({ name: "lotId", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "linkId", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(caseUnlinkCommandSchema)
  @ApiZodResponse({ status: 200, schema: caseUnlinkResultSchema })
  unlink(
    @Req() request: UsRequest,
    @Param("lotId") lotId: unknown,
    @Param("linkId") linkId: unknown,
    @Body() body: unknown,
  ) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.cases.unlink(
        principal.tenantId,
        principal.userId,
        lotId,
        linkId,
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
