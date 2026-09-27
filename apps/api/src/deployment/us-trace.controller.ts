import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  usCurrentTraceQuerySchema,
  usCurrentTraceResultSchema,
  usTraceHistoryQuerySchema,
  usTraceHistoryPageSchema,
} from "@markiro/platform-contracts";
import { ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

@Controller("traceability/lots/:id/trace")
@UseGuards(UsSessionGuard)
@ApiTags("us-current-trace")
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
export class UsTraceController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Get()
  @ApiOperation({ summary: "Read bounded current lot trace evidence" })
  @ApiZodQuery(usCurrentTraceQuerySchema)
  @ApiZodResponse({ status: 200, schema: usCurrentTraceResultSchema })
  read(@Req() request: UsRequest, @Param("id") id: string, @Query() query: unknown) {
    const principal = this.principal(request, query);
    return this.runtime.databaseOperation(() =>
      this.runtime.trace.read(principal.tenantId, principal.userId, id, query),
    );
  }

  @Get("history")
  @ApiOperation({ summary: "Read excluded lot trace revisions as a bounded live cursor page" })
  @ApiZodQuery(usTraceHistoryQuerySchema)
  @ApiZodResponse({ status: 200, schema: usTraceHistoryPageSchema })
  history(@Req() request: UsRequest, @Param("id") id: string, @Query() query: unknown) {
    const principal = this.principal(request, query);
    return this.runtime.databaseOperation(() =>
      this.runtime.trace.history(principal.tenantId, principal.userId, id, query),
    );
  }

  private principal(request: UsRequest, query: unknown) {
    if (!request.usPrincipal) throw new UnauthorizedException("us_session_required");
    // Check the raw URL too: a query parser may flatten duplicate or encoded keys.
    const seen = new Set<string>();
    const raw = new URL(request.originalUrl, "http://localhost").searchParams;
    for (const key of raw.keys()) {
      if (seen.has(key)) throw new BadRequestException({ code: "us_invalid_query" });
      seen.add(key);
    }
    if (typeof query === "object" && query !== null && Object.values(query).some(Array.isArray))
      throw new BadRequestException({ code: "us_invalid_query" });
    return request.usPrincipal;
  }
}
