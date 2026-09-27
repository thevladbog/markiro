import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  amendShippingSchema,
  createShippingDraftSchema,
  finalizeShippingSchema,
  saveShippingDraftSchema,
  shippingDraftRecordSchema,
  shippingFinalizedRecordSchema,
  shippingHttpErrorSchema,
  shippingHistoricalRecordSchema,
  shippingLifecycleReceiptSchema,
  shippingReadinessSchema,
  shippingRevisionListQuerySchema,
  shippingRevisionListSchema,
  voidShippingSchema,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

const readinessHttpQuerySchema = z
  .object({
    expectedDraftVersion: z.union([
      z.number().int().min(1).max(2147483647),
      z
        .string()
        .regex(/^[1-9]\d{0,9}$/)
        .transform(Number)
        .pipe(z.number().int().min(1).max(2147483647)),
    ]),
  })
  .strict();
function readinessQuery(query: unknown): unknown {
  if (
    typeof query !== "object" ||
    query === null ||
    Array.isArray(query) ||
    !("expectedDraftVersion" in query)
  )
    return query;
  const value = query.expectedDraftVersion;
  return typeof value === "string" && /^[1-9]\d{0,9}$/.test(value)
    ? { ...query, expectedDraftVersion: Number(value) }
    : query;
}

const revisionHttpQuerySchema = z
  .object({
    limit: z
      .union([
        z.number(),
        z
          .string()
          .regex(/^(0|[1-9]\d*)$/)
          .transform(Number),
      ])
      .pipe(z.number().int().min(1).max(100)),
    offset: z
      .union([
        z.number(),
        z
          .string()
          .regex(/^(0|[1-9]\d*)$/)
          .transform(Number),
      ])
      .pipe(z.number().int().min(0).max(100000)),
  })
  .strict();
function revisionQuery(query: unknown): unknown {
  const parsed = revisionHttpQuerySchema.safeParse(query);
  return parsed.success ? shippingRevisionListQuerySchema.parse(parsed.data) : query;
}

@Controller("traceability/shipments")
@UseGuards(UsSessionGuard)
@ApiTags("us-traceability-shipping")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description: "Invalid ID, query or strict command.",
  schema: usMasterDataBadRequestSchema,
})
@ApiResponse({
  status: 401,
  description: "Verified US session required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 403,
  description: "Current US membership and capability required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 404,
  description: "Shipping revision or reference not found in tenant.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 413,
  description: "Draft writes exceed 256 KiB or other commands exceed 16 KiB.",
  schema: usMasterDataErrorSchema,
})
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
export class UsShippingController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Post()
  @ApiOperation({ summary: "Create an incomplete Shipping draft with an operation key" })
  @ApiZodBody(createShippingDraftSchema)
  @ApiZodResponse({ status: 201, schema: shippingDraftRecordSchema })
  @ApiZodResponse({ status: 409, schema: shippingHttpErrorSchema })
  create(@Req() request: UsRequest, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.shipping.createDraft(
        principal.tenantId,
        principal.userId,
        body,
        this.requestId(request),
      ),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Read one Shipping draft or frozen historical revision" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: shippingHistoricalRecordSchema })
  get(@Req() request: UsRequest, @Param("id") id: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.shipping.getRecord(principal.tenantId, principal.userId, id),
    );
  }

  @Put(":id")
  @ApiOperation({ summary: "Replace a saved Shipping draft" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(saveShippingDraftSchema)
  @ApiZodResponse({ status: 200, schema: shippingDraftRecordSchema })
  @ApiZodResponse({ status: 409, schema: shippingHttpErrorSchema })
  save(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.shipping.saveDraft(
        principal.tenantId,
        principal.userId,
        id,
        body,
        this.requestId(request),
      ),
    );
  }

  @Get(":id/readiness")
  @ApiOperation({
    summary: "Check saved Shipping draft against current tenant references and balances",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodQuery(readinessHttpQuerySchema)
  @ApiZodResponse({ status: 200, schema: shippingReadinessSchema })
  @ApiZodResponse({ status: 409, schema: shippingHttpErrorSchema })
  readiness(@Req() request: UsRequest, @Param("id") id: unknown, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.shipping.checkReadiness(
        principal.tenantId,
        principal.userId,
        id,
        readinessQuery(query),
      ),
    );
  }

  @Get(":id/revisions")
  @ApiOperation({ summary: "List bounded Shipping revision history" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodQuery(revisionHttpQuerySchema)
  @ApiZodResponse({ status: 200, schema: shippingRevisionListSchema })
  revisions(@Req() request: UsRequest, @Param("id") id: unknown, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.shipping.listRevisions(
        principal.tenantId,
        principal.userId,
        id,
        revisionQuery(query),
      ),
    );
  }

  @Post(":id/finalize")
  @HttpCode(200)
  @ApiOperation({ summary: "Finalize a saved Shipping draft" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(finalizeShippingSchema)
  @ApiZodResponse({ status: 200, schema: shippingFinalizedRecordSchema })
  @ApiZodResponse({ status: 409, schema: shippingHttpErrorSchema })
  finalize(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.shipping.finalize(
        principal.tenantId,
        principal.userId,
        id,
        body,
        this.requestId(request),
      ),
    );
  }

  @Post(":id/amend")
  @HttpCode(200)
  @ApiOperation({ summary: "Open a QA Shipping amendment draft" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(amendShippingSchema)
  @ApiZodResponse({ status: 200, schema: shippingLifecycleReceiptSchema })
  @ApiZodResponse({ status: 409, schema: shippingHttpErrorSchema })
  amend(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.shipping.amend(
        principal.tenantId,
        principal.userId,
        id,
        body,
        this.requestId(request),
      ),
    );
  }

  @Post(":id/void")
  @HttpCode(200)
  @ApiOperation({ summary: "Void a Shipping original or amendment revision" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(voidShippingSchema)
  @ApiZodResponse({ status: 200, schema: shippingLifecycleReceiptSchema })
  @ApiZodResponse({ status: 409, schema: shippingHttpErrorSchema })
  void(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.shipping.void(
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
