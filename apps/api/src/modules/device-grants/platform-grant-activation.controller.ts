import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  platformGrantActivationContracts,
  type PlatformGrantActivationCancelRequest,
  type PlatformGrantActivationConfirmRequest,
  type PlatformGrantActivationListQuery,
  type PlatformGrantActivationPrepareRequest,
} from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { PlatformGrantActivationService } from "./platform-grant-activation.service";

const MUTATION_CAPABILITIES = [
  "tenants.read",
  "catalog.read",
  "catalog.write",
  "offlineGrants.activate",
] as const;

@ApiTags("platform-offline-grants")
@Controller("platform/offline-grants/activations")
export class PlatformGrantActivationController {
  constructor(private readonly activations: PlatformGrantActivationService) {}

  @Get()
  @ApiOperation({ summary: "List prepared offline grant activations" })
  @PlatformApiProtectedOk({
    query: platformGrantActivationContracts.list.query,
    response: platformGrantActivationContracts.list.response,
  })
  @RequirePlatformCapabilities("tenants.read", "catalog.read")
  async list(
    @Query(new ZodValidationPipe(platformGrantActivationContracts.list.query))
    query: PlatformGrantActivationListQuery,
  ) {
    return parsePlatformResponse(
      platformGrantActivationContracts.list.response,
      await this.activations.list(query),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Read one offline grant activation" })
  @PlatformApiProtectedOk({ response: platformGrantActivationContracts.detail.response })
  @RequirePlatformCapabilities("tenants.read", "catalog.read")
  async detail(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    return parsePlatformResponse(
      platformGrantActivationContracts.detail.response,
      await this.activations.detail(id),
    );
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "Prepare an exact offline grant pilot cohort" })
  @PlatformApiProtectedOk({
    body: platformGrantActivationContracts.prepare.body,
    response: platformGrantActivationContracts.prepare.response,
  })
  @RequirePlatformCapabilities(...MUTATION_CAPABILITIES)
  async prepare(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(platformGrantActivationContracts.prepare.body))
    body: PlatformGrantActivationPrepareRequest,
  ) {
    return parsePlatformResponse(
      platformGrantActivationContracts.prepare.response,
      await this.activations.prepare(request.platformPrincipal!, body),
    );
  }

  @Post(":id/confirm")
  @HttpCode(200)
  @ApiOperation({ summary: "Confirm an offline grant pilot with a second operator" })
  @PlatformApiProtectedOk({
    body: platformGrantActivationContracts.confirm.body,
    response: platformGrantActivationContracts.confirm.response,
  })
  @RequirePlatformCapabilities(...MUTATION_CAPABILITIES)
  async confirm(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body(new ZodValidationPipe(platformGrantActivationContracts.confirm.body))
    body: PlatformGrantActivationConfirmRequest,
  ) {
    return parsePlatformResponse(
      platformGrantActivationContracts.confirm.response,
      await this.activations.confirm(id, request.platformPrincipal!, body),
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel an unconfirmed offline grant pilot" })
  @PlatformApiProtectedOk({
    body: platformGrantActivationContracts.cancel.body,
    response: platformGrantActivationContracts.cancel.response,
  })
  @RequirePlatformCapabilities(...MUTATION_CAPABILITIES)
  async cancel(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body(new ZodValidationPipe(platformGrantActivationContracts.cancel.body))
    body: PlatformGrantActivationCancelRequest,
  ) {
    return parsePlatformResponse(
      platformGrantActivationContracts.cancel.response,
      await this.activations.cancel(id, request.platformPrincipal!, body),
    );
  }
}
