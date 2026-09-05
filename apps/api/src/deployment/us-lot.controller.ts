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
  createTraceabilityLotSchema,
  listTraceabilityLotsQuerySchema,
  platformUuidSchema,
  postLotStatusSchema,
  traceabilityLotListSchema,
  traceabilityLotSchema,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

const conflictSchema = z.union([
  z.object({ code: z.literal("LOT_DUPLICATE"), existingId: platformUuidSchema }).strict(),
  z.object({ code: z.enum(["lot_revision_conflict", "lot_reference_archived"]) }).strict(),
]);

@Controller("traceability/lots")
@UseGuards(UsSessionGuard)
@ApiTags("us-traceability-lots")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description: "Malformed JSON, ID or strict request fields.",
  schema: usMasterDataBadRequestSchema,
})
@ApiResponse({
  status: 401,
  description: "A verified US session is required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 403,
  description: "Current US membership or capability is insufficient.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 404,
  description: "Lot, product or source is not in the active tenant.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({ status: 413, description: "Body exceeds 16 KiB.", schema: usMasterDataErrorSchema })
@ApiResponse({
  status: 415,
  description: "An uncompressed application/json body is required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 422,
  description: "Assignment basis or manual status transition is not permitted.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 503,
  description: "US profile or storage is unavailable.",
  schema: usMasterDataErrorSchema,
})
export class UsLotController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Get()
  @ApiOperation({
    summary: "List lots in the active US tenant",
    description: "Record lookup only; does not assert event origin or export readiness.",
  })
  @ApiZodQuery(listTraceabilityLotsQuerySchema)
  @ApiZodResponse({ status: 200, schema: traceabilityLotListSchema })
  list(@Req() request: UsRequest, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.lots.listLots(principal.tenantId, principal.userId, query),
    );
  }

  @Post()
  @ApiOperation({
    summary: "Enter an imported lot",
    description:
      "Manual entry permits imported assignment only. A missing source is an incomplete record; references are stored without fetching their URLs.",
  })
  @ApiZodBody(createTraceabilityLotSchema)
  @ApiZodResponse({ status: 201, schema: traceabilityLotSchema })
  @ApiZodResponse({ status: 409, schema: conflictSchema })
  create(@Req() request: UsRequest, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.lots.createLot(
        principal.tenantId,
        principal.userId,
        body,
        this.requestId(request),
      ),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Read a tenant-scoped lot" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: traceabilityLotSchema })
  get(@Req() request: UsRequest, @Param("id") id: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.lots.getLot(principal.tenantId, principal.userId, id),
    );
  }

  @Post(":id/status")
  @HttpCode(200)
  @ApiOperation({
    summary: "Change lot status with QA permission",
    description:
      "Requires the current revision and a reason. No balance recalculation or system context can be requested.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(postLotStatusSchema)
  @ApiZodResponse({ status: 200, schema: traceabilityLotSchema })
  @ApiZodResponse({ status: 409, schema: conflictSchema })
  status(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.lots.changeStatus(
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
