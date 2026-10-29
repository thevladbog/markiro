import type { UsBusinessRuntimeView } from "./us-business-runtime-view";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse } from "@nestjs/swagger";
import {
  usRequestRunDetailSchema,
  usRequestAttemptListResponseSchema,
  usRequestHistoryQuerySchema,
  usRequestRetryHttpBodySchema,
  usRequestRetryResponseSchema,
} from "@markiro/platform-contracts";
import type { Response } from "express";
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";
import {
  ApiUsRequestBoundary,
  UsRequestsCanonicalRouteGuard,
  usRequestHttpContext,
  usRequestRawQuery,
  usRequestArtifactKinds,
} from "./us-request-http-routes";

@Controller("traceability/export-runs")
@UseGuards(UsRequestsCanonicalRouteGuard, UsSessionGuard)
@ApiUsRequestBoundary()
export class UsExportRunsController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsBusinessRuntimeView) {}
  @Get(":id")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Read safe immutable run detail without private worker state" })
  @ApiZodResponse({ status: 200, schema: usRequestRunDetailSchema })
  get(@Req() request: UsRequest, @Param("id") id: string) {
    const ctx = usRequestHttpContext(request);
    return this.runtime.databaseOperation(() => this.runtime.requestHttp.reads.getRun(ctx, id));
  }

  @Get(":id/attempts")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Read bounded safe attempt history" })
  @ApiZodQuery(usRequestHistoryQuerySchema)
  @ApiZodResponse({ status: 200, schema: usRequestAttemptListResponseSchema })
  attempts(@Req() request: UsRequest, @Param("id") id: string) {
    const ctx = usRequestHttpContext(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.requestHttp.reads.listAttempts(ctx, id, usRequestRawQuery(request)),
    );
  }

  @Post(":id/retry")
  @HttpCode(200)
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Request an authorized retry at the expected lifecycle version" })
  @ApiZodBody(usRequestRetryHttpBodySchema)
  @ApiZodResponse({ status: 200, schema: usRequestRetryResponseSchema })
  retry(@Req() request: UsRequest, @Param("id") id: string, @Body() body: unknown) {
    const ctx = usRequestHttpContext(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.requestHttp.commands.retry(ctx, id, body),
    );
  }

  @Get(":id/artifacts/:kind")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiParam({ name: "kind", enum: usRequestArtifactKinds })
  @ApiOperation({
    summary: "Download full verified private bytes after current authorization and audit",
  })
  @ApiResponse({
    status: 200,
    description: "Exact fixed-name artifact bytes; no partial or conditional release.",
    content: Object.fromEntries(
      [
        "application/zip",
        "application/pdf",
        "application/json",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ].map((media) => [media, { schema: { type: "string", format: "binary" } }]),
    ),
  })
  async download(
    @Req() request: UsRequest,
    @Param("id") id: string,
    @Param("kind") kind: string,
    @Res() response: Response,
  ) {
    const ctx = usRequestHttpContext(request);
    const result = await this.runtime.databaseOperation(() =>
      this.runtime.requestHttp.downloads.download(ctx, id, kind),
    );
    response
      .status(200)
      .set({
        "Content-Type": result.mediaType,
        "Content-Length": String(result.byteSize),
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      })
      .end(result.bytes);
  }
}
