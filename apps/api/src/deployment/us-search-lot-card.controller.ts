import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  usTraceSearchQuerySchema,
  usTraceSearchPageSchema,
  usLotCardSchema,
  usLotCardEvidenceQuerySchema,
  usLotCardEvidencePageSchema,
} from "@markiro/platform-contracts";
import { ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

@Controller("traceability")
@UseGuards(UsSessionGuard)
@ApiTags("us-search-lot-card")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description: "Invalid UUID, strict query or cursor.",
  schema: usMasterDataBadRequestSchema,
})
@ApiResponse({
  status: 401,
  description: "Verified US session required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 403,
  description: "Current US read capability required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 404,
  description: "Lot not found in the active tenant.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 503,
  description: "US storage unavailable or inconsistent.",
  schema: usMasterDataErrorSchema,
})
export class UsSearchLotCardController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Get("search")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Search source-qualified US lots using bounded filters" })
  @ApiZodQuery(usTraceSearchQuerySchema)
  @ApiZodResponse({ status: 200, schema: usTraceSearchPageSchema })
  search(@Req() request: UsRequest) {
    const { principal, query } = this.readRequest(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.trace.search(principal.tenantId, principal.userId, query),
    );
  }

  @Get("lots/:id/card")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Read current lot identity, origin descriptions and operational balance",
  })
  @ApiZodResponse({ status: 200, schema: usLotCardSchema })
  card(@Req() request: UsRequest, @Param("id") id: string) {
    const { principal, query } = this.readRequest(request);
    if (Object.keys(query).length) throw new BadRequestException({ code: "us_invalid_query" });
    return this.runtime.databaseOperation(() =>
      this.runtime.trace.card(principal.tenantId, principal.userId, id),
    );
  }

  @Get("lots/:id/card/evidence")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Read a bounded page of current frozen lot event evidence" })
  @ApiZodQuery(usLotCardEvidenceQuerySchema)
  @ApiZodResponse({ status: 200, schema: usLotCardEvidencePageSchema })
  evidence(@Req() request: UsRequest, @Param("id") id: string) {
    const { principal, query } = this.readRequest(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.trace.cardEvidence(principal.tenantId, principal.userId, id, query),
    );
  }

  private readRequest(request: UsRequest) {
    if (!request.usPrincipal) throw new UnauthorizedException("us_session_required");
    // Parse the raw URL once so framework parsing cannot flatten duplicate/encoded keys.
    const raw = new URL(request.originalUrl, "http://localhost").searchParams;
    const seen = new Set<string>();
    for (const key of raw.keys()) {
      if (seen.has(key)) throw new BadRequestException({ code: "us_invalid_query" });
      seen.add(key);
    }
    // The store owns strict schema/cursor decoding inside its authorized transaction.
    return { principal: request.usPrincipal, query: Object.fromEntries(raw) };
  }
}
