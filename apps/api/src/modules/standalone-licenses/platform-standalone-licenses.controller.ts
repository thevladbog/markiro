import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import {
  platformStandaloneLicenseContracts as contracts,
  platformUuidSchema,
  standaloneOpaqueIdSchema,
  type StandaloneIssuanceConfirm,
  type StandaloneIssuancePreviewRequest,
  type StandaloneSiteInspectRequest,
  type StandaloneSiteRegister,
} from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { STANDALONE_LICENSE_CAPABILITIES } from "./standalone-license-authority";
import { StandaloneLicenseIssuanceService } from "./standalone-license-issuance.service";
import { StandaloneSitesService } from "./standalone-sites.service";

/**
 * The tenant id travels into the signed file as the counterparty's opaque id
 * (owner decision 2026-10-13): 1-64 of `A-Za-z0-9._:-`, refused before any query
 * otherwise — no whitespace, control character or Unicode look-alike.
 */
export const standaloneTenantParam = new ZodValidationPipe(standaloneOpaqueIdSchema);
const tenantParam = standaloneTenantParam;
const uuidParam = new ZodValidationPipe(platformUuidSchema);

/** «Markiro Автоном» sites and their signed offline licenses (spec 2026-10-13 §6.2). */
@ApiTags("platform-standalone-licenses")
@Controller("platform/tenants/:tenantId/standalone-sites")
export class PlatformStandaloneLicensesController {
  constructor(
    private readonly sites: StandaloneSitesService,
    private readonly issuances: StandaloneLicenseIssuanceService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List a tenant's standalone sites with their latest offline license" })
  @PlatformApiProtectedOk({ response: contracts.list.response })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async list(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
  ) {
    return parsePlatformResponse(
      contracts.list.response,
      await this.sites.list(request.platformPrincipal, tenantId),
    );
  }

  @Post("inspect")
  @HttpCode(200)
  @ApiOperation({ summary: "Inspect an activation request: INN facts, warnings, host binding" })
  @PlatformApiProtectedOk({ body: contracts.inspect.body, response: contracts.inspect.response })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async inspect(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Body(new ZodValidationPipe(contracts.inspect.body)) body: StandaloneSiteInspectRequest,
  ) {
    return parsePlatformResponse(
      contracts.inspect.response,
      await this.sites.inspect(request.platformPrincipal, tenantId, body),
    );
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "Register a standalone site or bind a new host id to an existing one" })
  @PlatformApiProtectedOk({ body: contracts.register.body, response: contracts.register.response })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async register(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Body(new ZodValidationPipe(contracts.register.body)) body: StandaloneSiteRegister,
  ) {
    return parsePlatformResponse(
      contracts.register.response,
      await this.sites.register(request.platformPrincipal, tenantId, body),
    );
  }

  @Post(":siteId/issuances/preview")
  @HttpCode(200)
  @ApiOperation({ summary: "Preview the next offline license of a site without issuing it" })
  @ApiParam({ name: "siteId", format: "uuid" })
  @PlatformApiProtectedOk({
    body: contracts.previewIssuance.body,
    response: contracts.previewIssuance.response,
  })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async previewIssuance(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Param("siteId", uuidParam) siteId: string,
    @Body(new ZodValidationPipe(contracts.previewIssuance.body))
    body: StandaloneIssuancePreviewRequest,
  ) {
    return parsePlatformResponse(
      contracts.previewIssuance.response,
      await this.issuances.preview(request.platformPrincipal, tenantId, siteId, body),
    );
  }

  @Post(":siteId/issuances")
  @HttpCode(200)
  @ApiOperation({ summary: "Issue the previewed offline license and return the signed file" })
  @ApiParam({ name: "siteId", format: "uuid" })
  @PlatformApiProtectedOk({
    body: contracts.confirmIssuance.body,
    response: contracts.confirmIssuance.response,
  })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async confirmIssuance(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Param("siteId", uuidParam) siteId: string,
    @Body(new ZodValidationPipe(contracts.confirmIssuance.body)) body: StandaloneIssuanceConfirm,
  ) {
    return parsePlatformResponse(
      contracts.confirmIssuance.response,
      await this.issuances.confirm(request.platformPrincipal, tenantId, siteId, body),
    );
  }

  @Get(":siteId/issuances")
  @ApiOperation({ summary: "List every offline license issued for a site" })
  @ApiParam({ name: "siteId", format: "uuid" })
  @PlatformApiProtectedOk({ response: contracts.listIssuances.response })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async listIssuances(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Param("siteId", uuidParam) siteId: string,
  ) {
    return parsePlatformResponse(
      contracts.listIssuances.response,
      await this.issuances.listIssuances(request.platformPrincipal, tenantId, siteId),
    );
  }

  @Get(":siteId/issuances/:licenseId/file")
  @ApiOperation({ summary: "Download an issued offline license file again" })
  @ApiParam({ name: "siteId", format: "uuid" })
  @ApiParam({ name: "licenseId", format: "uuid" })
  @PlatformApiProtectedOk({ response: contracts.download.response })
  @RequirePlatformCapabilities(...STANDALONE_LICENSE_CAPABILITIES)
  async download(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("tenantId", tenantParam) tenantId: string,
    @Param("siteId", uuidParam) siteId: string,
    @Param("licenseId", uuidParam) licenseId: string,
  ) {
    return parsePlatformResponse(
      contracts.download.response,
      await this.issuances.download(request.platformPrincipal, tenantId, siteId, licenseId),
    );
  }
}
