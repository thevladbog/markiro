import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  NotFoundException,
  Req,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { usReadinessQuerySchema, usReadinessResultSchema } from "@markiro/platform-contracts";
import { ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

@Injectable()
class UsReadinessRouteGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<UsRequest>();
    // Express aliases HEAD, case variants and trailing slash to GET; reject before auth.
    if (request.method !== "GET" || request.path !== "/traceability/readiness")
      throw new NotFoundException();
    return true;
  }
}

@Controller("traceability")
@UseGuards(UsReadinessRouteGuard, UsSessionGuard)
@ApiTags("us-readiness")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description: "Invalid strict date/UUID scope or duplicate query key.",
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
  description: "Explicit lot or product not found in the active tenant.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 503,
  description:
    "Retryable storage inconsistency, unavailability or timeout (us_database_unavailable); narrow an oversized scope (us_readiness_scope_too_large). No partial assessment is returned.",
  schema: usMasterDataErrorSchema,
})
export class UsReadinessController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Get("readiness")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Assess a complete bounded scope of current frozen US traceability evidence",
  })
  @ApiZodQuery(usReadinessQuerySchema)
  @ApiZodResponse({ status: 200, schema: usReadinessResultSchema })
  read(@Req() request: UsRequest) {
    const url = new URL(request.originalUrl, "http://localhost");
    if (!request.usPrincipal) throw new UnauthorizedException("us_session_required");
    const seen = new Set<string>();
    for (const key of url.searchParams.keys()) {
      if (seen.has(key)) throw new BadRequestException({ code: "us_invalid_query" });
      seen.add(key);
    }
    const principal = request.usPrincipal;
    const query = Object.fromEntries(url.searchParams);
    // Strict scope parsing and fresh capability/profile authorization share the store transaction.
    return this.runtime.databaseOperation(() =>
      this.runtime.trace.readiness(principal.tenantId, principal.userId, query),
    );
  }
}
