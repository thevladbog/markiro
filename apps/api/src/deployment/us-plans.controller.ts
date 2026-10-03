import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  usPlanApproveBodySchema,
  usPlanApprovalResponseSchema,
  usPlanDetailResponseSchema,
  usPlanDraftCommandResponseSchema,
  usPlanDraftCreateBodySchema,
  usPlanDraftDiscardBodySchema,
  usPlanDraftSaveBodySchema,
  usPlanListResponseSchema,
  usPlanPreviewBodySchema,
  usPlanValidateBodySchema,
  usPlanValidationResponseSchema,
} from "@markiro/platform-contracts";
import type { Response } from "express";
import { ApiZodBody, ApiZodResponse, zodApiSchema } from "../lib/openapi";
import { parseMasterDataInput } from "../modules/traceability/master-data/us-master-data-support";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";

const root = "/traceability/plans";
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const item = new RegExp(`^${root}/${uuid}$`);
const command = new RegExp(`^${root}/${uuid}/(validate|preview|approve|discard)$`);
const pdf = new RegExp(`^${root}/${uuid}/pdf$`);

@Injectable()
export class UsPlansCanonicalRouteGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<UsRequest>();
    const valid =
      (request.path === root && ["GET", "POST"].includes(request.method)) ||
      (item.test(request.path) && ["GET", "PUT"].includes(request.method)) ||
      (command.test(request.path) && request.method === "POST") ||
      (pdf.test(request.path) && request.method === "GET");
    if (!valid) throw new NotFoundException();
    if (new URL(request.originalUrl, "http://localhost").searchParams.size)
      throw new BadRequestException({ code: "us_invalid_query" });
    return true;
  }
}

const binaryResponse = {
  status: 200,
  description: "Bounded English PDF bytes; never a public artifact URL.",
  content: { "application/pdf": { schema: { type: "string", format: "binary" } } },
};

@Controller("traceability/plans")
@UseGuards(UsPlansCanonicalRouteGuard, UsSessionGuard)
@ApiTags("us-plans")
@ApiCookieAuth("markiro-us.session_token")
@ApiResponse({
  status: 400,
  description: "Invalid strict body or forbidden query.",
  schema: {
    oneOf: [
      usMasterDataBadRequestSchema,
      {
        type: "object",
        required: ["code"],
        additionalProperties: false,
        properties: { code: { type: "string", enum: ["us_invalid_query"] } },
      },
    ],
  },
})
@ApiResponse({
  status: 401,
  description: "Verified US session required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 403,
  description: "Current capability, processor profile and trusted host/origin required.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 404,
  description: "Canonical route or tenant version not found.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 409,
  description: "Stale revision, invalid draft, or conflicting approval.",
  schema: {
    type: "object",
    required: ["code"],
    properties: {
      code: { type: "string" },
      issues: zodApiSchema(usPlanValidationResponseSchema.shape.issues),
    },
  },
})
@ApiResponse({
  status: 413,
  description: "Body exceeds the route limit.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 415,
  description: "Uncompressed JSON required for commands.",
  schema: usMasterDataErrorSchema,
})
@ApiResponse({
  status: 503,
  description: "US database/artifact unavailable; drafts do not require artifact storage.",
  schema: usMasterDataErrorSchema,
})
export class UsPlansController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsRuntime) {}

  private context(request: UsRequest) {
    if (!request.usPrincipal || !request.usRequestId)
      throw new UnauthorizedException("us_session_required");
    return { ...request.usPrincipal, requestId: request.usRequestId };
  }
  private sendPdf(response: Response, bytes: Buffer) {
    if (!bytes.length || bytes.length > 8_000_000)
      throw new ServiceUnavailableException({ code: "us_plan_pdf_invalid" });
    response.set({
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": 'attachment; filename="traceability-plan.pdf"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.send(bytes);
  }

  @Get()
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "List current tenant Plan versions and configuration impact" })
  @ApiZodResponse({ status: 200, schema: usPlanListResponseSchema })
  list(@Req() request: UsRequest) {
    const p = this.context(request);
    return this.runtime.databaseOperation(() => this.runtime.planRead.list(p.tenantId, p.userId));
  }

  @Post()
  @ApiOperation({ summary: "Create a saved Plan draft" })
  @ApiZodBody(usPlanDraftCreateBodySchema)
  @ApiZodResponse({ status: 201, schema: usPlanDraftCommandResponseSchema })
  create(@Req() request: UsRequest, @Body() body: unknown) {
    const p = this.context(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.planDrafts.createDraft(p.tenantId, p.userId, body, p.requestId),
    );
  }

  @Get(":id")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Read a tenant Plan draft or immutable published detail" })
  @ApiZodResponse({ status: 200, schema: usPlanDetailResponseSchema })
  get(@Req() request: UsRequest, @Param("id") id: string) {
    const p = this.context(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.planRead.get(p.tenantId, p.userId, id),
    );
  }

  @Put(":id")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Replace a saved Plan draft at its expected revision" })
  @ApiZodBody(usPlanDraftSaveBodySchema)
  @ApiZodResponse({ status: 200, schema: usPlanDraftCommandResponseSchema })
  save(@Req() request: UsRequest, @Param("id") id: string, @Body() body: unknown) {
    const p = this.context(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.planDrafts.saveDraft(p.tenantId, p.userId, id, body, p.requestId),
    );
  }

  @Post(":id/validate")
  @HttpCode(200)
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Validate saved Plan revision without writing" })
  @ApiZodBody(usPlanValidateBodySchema)
  @ApiZodResponse({ status: 200, schema: usPlanValidationResponseSchema })
  validate(@Req() request: UsRequest, @Param("id") id: string, @Body() body: unknown) {
    const p = this.context(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.planInspection.validate(p.tenantId, p.userId, id, body),
    );
  }

  @Post(":id/preview")
  @HttpCode(200)
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Render an ephemeral watermarked saved Plan draft" })
  @ApiZodBody(usPlanPreviewBodySchema)
  @ApiResponse({
    ...binaryResponse,
    headers: {
      "X-Plan-Draft-Revision": {
        schema: { type: "integer", minimum: 1 },
        description: "Captured saved revision",
      },
    },
  })
  async preview(
    @Req() request: UsRequest,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    const p = this.context(request);
    const result = await this.runtime.databaseOperation(() =>
      this.runtime.planInspection.preview(p.tenantId, p.userId, id, body),
    );
    response.setHeader("X-Plan-Draft-Revision", String(result.draftRevision));
    this.sendPdf(response, result.bytes);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({
    summary: "Atomically publish the saved Plan with an idempotent approval receipt",
  })
  @ApiZodBody(usPlanApproveBodySchema)
  @ApiZodResponse({ status: 200, schema: usPlanApprovalResponseSchema })
  async approve(@Req() request: UsRequest, @Param("id") id: string, @Body() body: unknown) {
    const p = this.context(request);
    const input = parseMasterDataInput(usPlanApproveBodySchema, body);
    const result = await this.runtime.databaseOperation(() =>
      this.runtime.planApproval.approve(
        p.tenantId,
        p.userId,
        { ...input, versionId: id },
        p.requestId,
      ),
    );
    return usPlanApprovalResponseSchema.parse({
      id: result.id,
      versionNumber: result.versionNumber,
      status: "effective",
      approvedAt: result.approvedAt,
      sha256: result.artifact.sha256,
    });
  }

  @Post(":id/discard")
  @HttpCode(204)
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Discard only a saved draft at its expected revision" })
  @ApiZodBody(usPlanDraftDiscardBodySchema)
  @ApiResponse({ status: 204, description: "Draft discarded; no response body." })
  discard(@Req() request: UsRequest, @Param("id") id: string, @Body() body: unknown) {
    const p = this.context(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.planDrafts.discardDraft(p.tenantId, p.userId, id, body, p.requestId),
    );
  }

  @Get(":id/pdf")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Download exact stored and hash-verified Plan PDF bytes" })
  @ApiResponse(binaryResponse)
  async pdf(@Req() request: UsRequest, @Param("id") id: string, @Res() response: Response) {
    const p = this.context(request);
    const bytes = await this.runtime.databaseOperation(() =>
      this.runtime.planApproval.readPdf(p.tenantId, p.userId, id, p.requestId),
    );
    this.sendPdf(response, bytes);
  }
}
