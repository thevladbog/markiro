import { Body, Controller, Get, HttpCode, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  platformGrantReadinessContracts,
  type PlatformGrantReadinessListQuery,
  type PlatformGrantReadinessPreviewRequest,
} from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { PlatformGrantReadinessService } from "./platform-grant-readiness.service";

@ApiTags("platform-offline-grants")
@Controller("platform/offline-grants")
export class PlatformGrantReadinessController {
  constructor(private readonly readiness: PlatformGrantReadinessService) {}

  @Get("readiness")
  @ApiOperation({ summary: "List native offline grant rollout readiness" })
  @PlatformApiProtectedOk({
    query: platformGrantReadinessContracts.list.query,
    response: platformGrantReadinessContracts.list.response,
  })
  @RequirePlatformCapabilities("tenants.read", "catalog.read")
  async list(
    @Req() request: RequestWithPlatformPrincipal,
    @Query(new ZodValidationPipe(platformGrantReadinessContracts.list.query))
    query: PlatformGrantReadinessListQuery,
  ) {
    return parsePlatformResponse(
      platformGrantReadinessContracts.list.response,
      await this.readiness.list(request.platformPrincipal!, query),
    );
  }

  @Post("readiness/preview")
  @HttpCode(200)
  @ApiOperation({ summary: "Preview a strict offline grant pilot cohort" })
  @PlatformApiProtectedOk({
    body: platformGrantReadinessContracts.preview.body,
    response: platformGrantReadinessContracts.preview.response,
  })
  @RequirePlatformCapabilities("tenants.read", "catalog.read", "catalog.write")
  async preview(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(platformGrantReadinessContracts.preview.body))
    body: PlatformGrantReadinessPreviewRequest,
  ) {
    return parsePlatformResponse(
      platformGrantReadinessContracts.preview.response,
      await this.readiness.preview(request.platformPrincipal!, body),
    );
  }
}
