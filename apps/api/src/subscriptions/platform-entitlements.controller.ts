import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  entitlementSourceListSchema,
  entitlementSourcePreviewRequestSchema,
  entitlementSourcePreviewSchema,
  entitlementSourceConfirmSchema,
  entitlementSourceConfirmationSchema,
  entitlementImpactSchema,
  platformTenantIdSchema,
  type EntitlementSourcePreviewRequest,
  type EntitlementSourceConfirm,
} from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../platform-http/platform-openapi";
import { parsePlatformResponse } from "../platform-http/platform-response";
import { ZodValidationPipe } from "../zod.pipe";
import { EntitlementSourcesService } from "./entitlement-sources.service";

@ApiTags("platform-entitlements")
@Controller("platform/tenants/:id/entitlements")
export class PlatformEntitlementsController {
  constructor(private readonly sources: EntitlementSourcesService) {}

  @Get()
  @RequirePlatformCapabilities("tenants.read")
  @ApiOperation({ summary: "Read tenant entitlement snapshot and permitted source details" })
  @PlatformApiProtectedOk({ response: entitlementSourceListSchema })
  async get(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformTenantIdSchema)) id: string,
  ) {
    return parsePlatformResponse(
      entitlementSourceListSchema,
      await this.sources.list(request.platformPrincipal!, id),
    );
  }

  @Get("sources")
  @RequirePlatformCapabilities("tenants.read")
  @ApiOperation({ summary: "Read entitlement sources with capability-filtered details" })
  @PlatformApiProtectedOk({ response: entitlementSourceListSchema })
  async list(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformTenantIdSchema)) id: string,
  ) {
    return parsePlatformResponse(
      entitlementSourceListSchema,
      await this.sources.list(request.platformPrincipal!, id),
    );
  }

  @Get("impact")
  @RequirePlatformCapabilities("tenants.read")
  @ApiOperation({ summary: "Read tenant entitlement shadow impact without assigning rights" })
  @PlatformApiProtectedOk({ response: entitlementImpactSchema })
  async impact(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformTenantIdSchema)) id: string,
  ) {
    return parsePlatformResponse(
      entitlementImpactSchema,
      await this.sources.impact(request.platformPrincipal!, id),
    );
  }

  @Post("preview")
  @HttpCode(200)
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @ApiOperation({ summary: "Preview preparation or revocation of an entitlement source" })
  @PlatformApiProtectedOk({
    body: entitlementSourcePreviewRequestSchema,
    response: entitlementSourcePreviewSchema,
  })
  async preview(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformTenantIdSchema)) id: string,
    @Body(new ZodValidationPipe(entitlementSourcePreviewRequestSchema))
    body: EntitlementSourcePreviewRequest,
  ) {
    return parsePlatformResponse(
      entitlementSourcePreviewSchema,
      await this.sources.preview(request.platformPrincipal!, id, body),
    );
  }

  @Post("confirm")
  @HttpCode(200)
  @RequirePlatformCapabilities("tenants.write", "billing.write")
  @ApiOperation({ summary: "Confirm an immutable, fresh entitlement preview" })
  @PlatformApiProtectedOk({
    body: entitlementSourceConfirmSchema,
    response: entitlementSourceConfirmationSchema,
  })
  async confirm(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformTenantIdSchema)) id: string,
    @Body(new ZodValidationPipe(entitlementSourceConfirmSchema)) body: EntitlementSourceConfirm,
  ) {
    return parsePlatformResponse(
      entitlementSourceConfirmationSchema,
      await this.sources.confirm(request.platformPrincipal!, id, body),
    );
  }
}
