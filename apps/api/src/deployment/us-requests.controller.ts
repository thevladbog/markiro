import type { UsBusinessRuntimeView } from "./us-business-runtime-view";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiParam } from "@nestjs/swagger";
import {
  usTraceRequestCreateBodySchema,
  usTraceRequestUpdateBodySchema,
  usTraceRequestCloseBodySchema,
  usRequestListQuerySchema,
  usRequestHistoryQuerySchema,
  usRequestListResponseSchema,
  usRequestDetailResponseSchema,
  usRequestCommandResponseSchema,
  usRequestValidateHttpBodySchema,
  usRequestValidationHttpResponseSchema,
  usRequestWarningAckHttpBodySchema,
  usRequestPrepareHttpBodySchema,
  usRequestPrepareResponseSchema,
  usRequestRunListResponseSchema,
} from "@markiro/platform-contracts";
import { ApiZodBody, ApiZodQuery, ApiZodResponse } from "../lib/openapi";
import { UsRuntime } from "./us-runtime";
import { UsSessionGuard, type UsRequest } from "./us-profile.controller";
import {
  ApiUsRequestBoundary,
  UsRequestsCanonicalRouteGuard,
  usRequestHttpContext,
  usRequestRawQuery,
} from "./us-request-http-routes";

@Controller("traceability/requests")
@UseGuards(UsRequestsCanonicalRouteGuard, UsSessionGuard)
@ApiUsRequestBoundary()
export class UsRequestsController {
  constructor(@Inject(UsRuntime) private readonly runtime: UsBusinessRuntimeView) {}

  @Get()
  @ApiOperation({ summary: "List bounded tenant request summaries" })
  @ApiZodQuery(usRequestListQuerySchema)
  @ApiZodResponse({ status: 200, schema: usRequestListResponseSchema })
  list(@Req() request: UsRequest) {
    const ctx = usRequestHttpContext(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.requestHttp.reads.list(ctx, usRequestRawQuery(request)),
    );
  }

  @Post()
  @ApiOperation({ summary: "Record a trace request without preparing a package" })
  @ApiZodBody(usTraceRequestCreateBodySchema)
  @ApiZodResponse({ status: 201, schema: usRequestCommandResponseSchema })
  create(@Req() request: UsRequest, @Body() body: unknown) {
    const ctx = usRequestHttpContext(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.requestHttp.commands.create(ctx, body),
    );
  }

  @Get(":id")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Read current request, saved validation and descriptive availability" })
  @ApiZodResponse({ status: 200, schema: usRequestDetailResponseSchema })
  get(@Req() request: UsRequest, @Param("id") id: string) {
    const ctx = usRequestHttpContext(request);
    return this.runtime.databaseOperation(() => this.runtime.requestHttp.get(ctx, id));
  }

  @Patch(":id")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Edit a request at its expected revision" })
  @ApiZodBody(usTraceRequestUpdateBodySchema)
  @ApiZodResponse({ status: 200, schema: usRequestCommandResponseSchema })
  update(@Req() request: UsRequest, @Param("id") id: string, @Body() body: unknown) {
    const ctx = usRequestHttpContext(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.requestHttp.commands.update(ctx, id, body),
    );
  }

  @Post(":id/close")
  @HttpCode(200)
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Close a request while preserving accepted run history" })
  @ApiZodBody(usTraceRequestCloseBodySchema)
  @ApiZodResponse({ status: 200, schema: usRequestCommandResponseSchema })
  close(@Req() request: UsRequest, @Param("id") id: string, @Body() body: unknown) {
    const ctx = usRequestHttpContext(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.requestHttp.commands.close(ctx, id, body),
    );
  }

  @Post(":id/validate")
  @HttpCode(200)
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({
    summary: "Validate expected request revision with freshly checked build evidence",
  })
  @ApiZodBody(usRequestValidateHttpBodySchema)
  @ApiZodResponse({ status: 200, schema: usRequestValidationHttpResponseSchema })
  validate(@Req() request: UsRequest, @Param("id") id: string, @Body() body: unknown) {
    const ctx = usRequestHttpContext(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.requestHttp.commands.validate(ctx, id, body),
    );
  }

  @Post(":id/acknowledge-warnings")
  @HttpCode(200)
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Acknowledge saved warnings at the expected revision and digest" })
  @ApiZodBody(usRequestWarningAckHttpBodySchema)
  @ApiZodResponse({ status: 200, schema: usRequestCommandResponseSchema })
  acknowledgeWarnings(@Req() request: UsRequest, @Param("id") id: string, @Body() body: unknown) {
    const ctx = usRequestHttpContext(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.requestHttp.commands.acknowledgeWarnings(ctx, id, body),
    );
  }

  @Post(":id/prepare")
  @HttpCode(200)
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({
    summary: "Freeze bounded evidence and queue an explicit complete or incomplete run",
  })
  @ApiZodBody(usRequestPrepareHttpBodySchema)
  @ApiZodResponse({ status: 200, schema: usRequestPrepareResponseSchema })
  prepare(@Req() request: UsRequest, @Param("id") id: string, @Body() body: unknown) {
    const ctx = usRequestHttpContext(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.requestHttp.commands.prepare(ctx, id, body),
    );
  }

  @Get(":id/runs")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOperation({ summary: "Read bounded immutable run history" })
  @ApiZodQuery(usRequestHistoryQuerySchema)
  @ApiZodResponse({ status: 200, schema: usRequestRunListResponseSchema })
  runs(@Req() request: UsRequest, @Param("id") id: string) {
    const ctx = usRequestHttpContext(request);
    return this.runtime.databaseOperation(() =>
      this.runtime.requestHttp.reads.listRuns(ctx, id, usRequestRawQuery(request)),
    );
  }
}
