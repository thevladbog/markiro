import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  amendTransformationSchema,
  createTransformationDraftSchema,
  finalizeTransformationSchema,
  saveTransformationDraftSchema,
  transformationDraftRecordSchema,
  transformationFinalizedRecordSchema,
  transformationGenealogyRequestSchema,
  transformationGenealogyResultSchema,
  transformationHttpErrorSchema,
  transformationHttpRecordSchema,
  transformationLifecycleReceiptSchema,
  transformationReadinessSchema,
  transformationRevisionListQuerySchema,
  transformationRevisionListSchema,
  voidTransformationSchema,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

function readinessQuery(query: unknown): unknown {
  if (typeof query !== "object" || query === null || Array.isArray(query)) return query;
  if (!("expectedDraftVersion" in query)) return query;
  const value = query.expectedDraftVersion;
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value)) return query;
  return { ...query, expectedDraftVersion: Number(value) };
}
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

@Controller("traceability/transformation")
@UseGuards(UsSessionGuard)
@ApiTags("us-traceability-transformation")
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
  description: "Transformation revision or reference not found in tenant.",
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
export class UsTransformationController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  @Post("genealogy/query")
  @HttpCode(200)
  @ApiOperation({ summary: "Read current or pinned tenant lot genealogy" })
  @ApiZodBody(transformationGenealogyRequestSchema)
  @ApiZodResponse({ status: 200, schema: transformationGenealogyResultSchema })
  genealogy(@Req() request: UsRequest, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.transformation.getGenealogy(principal.tenantId, principal.userId, body),
    );
  }

  @Post()
  @ApiOperation({ summary: "Create an incomplete Transformation draft with an operation key" })
  @ApiZodBody(createTransformationDraftSchema)
  @ApiZodResponse({ status: 201, schema: transformationDraftRecordSchema })
  @ApiZodResponse({ status: 409, schema: transformationHttpErrorSchema })
  create(@Req() request: UsRequest, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.transformation.createDraft(
        principal.tenantId,
        principal.userId,
        body,
        this.requestId(request),
      ),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Read one current or historical Transformation revision" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodResponse({ status: 200, schema: transformationHttpRecordSchema })
  get(@Req() request: UsRequest, @Param("id") id: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.transformation.getRecord(principal.tenantId, principal.userId, id),
    );
  }

  @Put(":id")
  @ApiOperation({ summary: "Replace a saved Transformation draft" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(saveTransformationDraftSchema)
  @ApiZodResponse({ status: 200, schema: transformationDraftRecordSchema })
  @ApiZodResponse({ status: 409, schema: transformationHttpErrorSchema })
  save(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.transformation.saveDraft(
        principal.tenantId,
        principal.userId,
        id,
        body,
        this.requestId(request),
      ),
    );
  }

  @Get(":id/readiness")
  @ApiOperation({ summary: "Check saved Transformation draft against current tenant references" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodQuery(readinessHttpQuerySchema)
  @ApiZodResponse({ status: 200, schema: transformationReadinessSchema })
  @ApiZodResponse({ status: 409, schema: transformationHttpErrorSchema })
  readiness(@Req() request: UsRequest, @Param("id") id: unknown, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.transformation.checkReadiness(
        principal.tenantId,
        principal.userId,
        id,
        readinessQuery(query),
      ),
    );
  }

  @Get(":id/revisions")
  @ApiOperation({ summary: "List bounded Transformation revision history" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodQuery(transformationRevisionListQuerySchema)
  @ApiZodResponse({ status: 200, schema: transformationRevisionListSchema })
  revisions(@Req() request: UsRequest, @Param("id") id: unknown, @Query() query: unknown) {
    const principal = this.principal(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.transformation.listRevisions(principal.tenantId, principal.userId, id, query),
    );
  }

  @Post(":id/finalize")
  @HttpCode(200)
  @ApiOperation({ summary: "Finalize a saved Transformation draft" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(finalizeTransformationSchema)
  @ApiZodResponse({ status: 200, schema: transformationFinalizedRecordSchema })
  @ApiZodResponse({ status: 409, schema: transformationHttpErrorSchema })
  finalize(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.withBoundedBlockers(() =>
      this.runtime.transformation.finalize(
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
  @ApiOperation({ summary: "Open a QA amendment draft" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(amendTransformationSchema)
  @ApiZodResponse({ status: 200, schema: transformationLifecycleReceiptSchema })
  @ApiZodResponse({ status: 409, schema: transformationHttpErrorSchema })
  amend(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.withBoundedBlockers(() =>
      this.runtime.transformation.amend(
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
  @ApiOperation({ summary: "Void a Transformation original or amendment revision" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(voidTransformationSchema)
  @ApiZodResponse({ status: 200, schema: transformationLifecycleReceiptSchema })
  @ApiZodResponse({ status: 409, schema: transformationHttpErrorSchema })
  void(@Req() request: UsRequest, @Param("id") id: unknown, @Body() body: unknown) {
    const principal = this.principal(request);
    return this.withBoundedBlockers(() =>
      this.runtime.transformation.void(
        principal.tenantId,
        principal.userId,
        id,
        body,
        this.requestId(request),
      ),
    );
  }

  private async withBoundedBlockers<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await this.runtime.databaseOperation(operation);
    } catch (error) {
      if (error instanceof ConflictException) {
        const response = error.getResponse();
        if (
          typeof response === "object" &&
          response !== null &&
          "code" in response &&
          response.code === "traceability_downstream_blocked" &&
          "blockers" in response &&
          Array.isArray(response.blockers)
        ) {
          const bounded = transformationHttpErrorSchema.safeParse({
            code: response.code,
            blockers: response.blockers.slice(0, 100),
            hasMore: response.blockers.length > 100,
          });
          if (!bounded.success)
            throw new ServiceUnavailableException({ code: "us_database_unavailable" });
          throw new ConflictException(bounded.data);
        }
      }
      throw error;
    }
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
