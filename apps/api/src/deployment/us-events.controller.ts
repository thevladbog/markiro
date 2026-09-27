import {
  Controller,
  Get,
  Inject,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { usEventListQuerySchema, usEventListSchema } from "@markiro/platform-contracts";
import { ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

@Controller("traceability/events")
@UseGuards(UsSessionGuard)
@ApiTags("us-traceability-events")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description: "Invalid strict query.",
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
  status: 503,
  description: "US storage unavailable or inconsistent.",
  schema: usMasterDataErrorSchema,
})
export class UsEventsController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}
  @Get()
  @ApiOperation({
    summary: "List tenant Receiving and Transformation summaries in one global page",
  })
  @ApiZodQuery(usEventListQuerySchema)
  @ApiZodResponse({ status: 200, schema: usEventListSchema })
  list(@Req() request: UsRequest, @Query() query: unknown) {
    const principal = request.usPrincipal;
    if (!principal) throw new UnauthorizedException("us_session_required");
    return this.runtime.databaseOperation(() =>
      this.runtime.events.list(principal.tenantId, principal.userId, query),
    );
  }
}
