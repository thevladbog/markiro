import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { platformReportContracts, platformErrorSchema } from "@markiro/platform-contracts";
import type { z } from "zod";
import { RequirePlatformCapabilities } from "../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../platform-auth/platform-auth.guard";
import {
  PlatformApiProtectedCreated,
  PlatformApiProtectedOk,
} from "../platform-http/platform-openapi";
import { parsePlatformResponse } from "../platform-http/platform-response";
import { ZodValidationPipe } from "../zod.pipe";
import { PlatformReportsService } from "./platform-reports.service";

@ApiTags("platform-reports")
@Controller("platform/reports")
export class PlatformReportsController {
  constructor(private readonly reports: PlatformReportsService) {}

  @Post()
  @ApiOperation({ summary: "Create an operational report" })
  @RequirePlatformCapabilities("reports.create")
  @PlatformApiProtectedCreated({
    body: platformReportContracts.create.body,
    response: platformReportContracts.create.response,
  })
  async create(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(platformReportContracts.create.body)) body: unknown,
  ) {
    return parsePlatformResponse(
      platformReportContracts.create.response,
      await this.reports.create(request.platformPrincipal!, body),
    );
  }

  @Get()
  @ApiOperation({ summary: "List reports created by the current platform user" })
  @RequirePlatformCapabilities("reports.read")
  @PlatformApiProtectedOk({
    response: platformReportContracts.list.response,
    query: platformReportContracts.list.query,
  })
  async list(
    @Req() request: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(platformReportContracts.list.query))
    query: z.infer<typeof platformReportContracts.list.query>,
  ) {
    return parsePlatformResponse(
      platformReportContracts.list.response,
      await this.reports.list(request.platformPrincipal!, query),
    );
  }

  @Get("options")
  @ApiOperation({ summary: "Search selected tenants' report filter options" })
  @RequirePlatformCapabilities("reports.read")
  @PlatformApiProtectedOk({
    response: platformReportContracts.options.response,
    query: platformReportContracts.options.query,
  })
  async options(
    @Req() request: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(platformReportContracts.options.query)) query: unknown,
  ) {
    return parsePlatformResponse(
      platformReportContracts.options.response,
      await this.reports.options(request.platformPrincipal!, query),
    );
  }

  @Post(":id/download")
  @HttpCode(200)
  @ApiOperation({ summary: "Download a ready report before retention expires" })
  @RequirePlatformCapabilities("reports.download")
  @PlatformApiProtectedOk({
    response: platformReportContracts.download.response,
    errors: [{ status: 410, schema: platformErrorSchema }],
  })
  async download(
    @Req() request: RequestWithPlatformPrincipal,
    @Param(new ZodValidationPipe(platformReportContracts.download.params))
    params: z.infer<typeof platformReportContracts.download.params>,
  ) {
    return parsePlatformResponse(
      platformReportContracts.download.response,
      await this.reports.download(request.platformPrincipal!, params.id),
    );
  }
}
