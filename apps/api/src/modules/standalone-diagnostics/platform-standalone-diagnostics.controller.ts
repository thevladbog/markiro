import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import {
  platformStandaloneDiagnosticsContracts as contracts,
  platformUuidSchema,
  standaloneOpaqueIdSchema,
  type StandaloneDiagnosticsHistoryQuery,
  type StandaloneDiagnosticsIngestRequest,
  type StandaloneDiagnosticsStatisticsQuery,
} from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { STANDALONE_LICENSE_CAPABILITIES } from "../standalone-licenses/standalone-license-authority";
import { StandaloneDiagnosticsService } from "./standalone-diagnostics.service";

const tenantParam = new ZodValidationPipe(standaloneOpaqueIdSchema);

/** Support diagnostics of «Markiro Автоном» per tenant (spec 2026-10-15-standalone-support-diagnostics-ingestion). */
@ApiTags("platform-standalone-diagnostics")
@Controller("platform/tenants/:tenantId/standalone-diagnostics")
export class PlatformStandaloneDiagnosticsController {
  constructor(private readonly diagnostics: StandaloneDiagnosticsService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "Open a pasted support text, store its report and monthly statistics" })
  @PlatformApiProtectedOk({ body: contracts.ingest.body, response: contracts.ingest.response })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async ingest(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Body(new ZodValidationPipe(contracts.ingest.body)) body: StandaloneDiagnosticsIngestRequest,
  ) {
    return parsePlatformResponse(
      contracts.ingest.response,
      await this.diagnostics.ingest(request.platformPrincipal, tenantId, body),
    );
  }

  @Get()
  @ApiOperation({ summary: "List a tenant's support reports, newest first" })
  @PlatformApiProtectedOk({ query: contracts.history.query, response: contracts.history.response })
  @RequirePlatformCapabilities("tenants.read")
  async history(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Query(new ZodValidationPipe(contracts.history.query)) query: StandaloneDiagnosticsHistoryQuery,
  ) {
    return parsePlatformResponse(
      contracts.history.response,
      await this.diagnostics.history(request.platformPrincipal, tenantId, query),
    );
  }

  @Get("overview")
  @ApiOperation({ summary: "Current versions and license use per host, from the last reports" })
  @PlatformApiProtectedOk({ response: contracts.overview.response })
  @RequirePlatformCapabilities("tenants.read")
  async overview(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
  ) {
    return parsePlatformResponse(
      contracts.overview.response,
      await this.diagnostics.overview(request.platformPrincipal, tenantId),
    );
  }

  @Get("statistics")
  @ApiOperation({ summary: "Usage statistics by month, summed over hosts or for one host" })
  @PlatformApiProtectedOk({
    query: contracts.statistics.query,
    response: contracts.statistics.response,
  })
  @RequirePlatformCapabilities("tenants.read")
  async statistics(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Query(new ZodValidationPipe(contracts.statistics.query))
    query: StandaloneDiagnosticsStatisticsQuery,
  ) {
    return parsePlatformResponse(
      contracts.statistics.response,
      await this.diagnostics.statistics(request.platformPrincipal, tenantId, query),
    );
  }

  // Declared last: the static segments above must win over the id parameter.
  @Get(":diagnosticId")
  @ApiOperation({ summary: "One stored report: devices, months and license summary" })
  @ApiParam({ name: "diagnosticId", format: "uuid" })
  @PlatformApiProtectedOk({ response: contracts.detail.response })
  @RequirePlatformCapabilities("tenants.read")
  async detail(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Param("diagnosticId", new ZodValidationPipe(platformUuidSchema)) diagnosticId: string,
  ) {
    return parsePlatformResponse(
      contracts.detail.response,
      await this.diagnostics.detail(request.platformPrincipal, tenantId, diagnosticId),
    );
  }
}
