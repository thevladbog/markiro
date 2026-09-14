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
  platformGrantRollbackContracts,
  type PlatformGrantRollbackCancelRequest,
  type PlatformGrantRollbackCandidatesQuery,
  type PlatformGrantRollbackConfirmRequest,
  type PlatformGrantRollbackListQuery,
  type PlatformGrantRollbackPrepareRequest,
} from "@markiro/platform-contracts";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { PlatformGrantRollbackService } from "./platform-grant-rollback.service";

const MUTATION_CAPABILITIES = [
  "tenants.read",
  "catalog.read",
  "catalog.write",
  "offlineGrants.activate",
] as const;

@ApiTags("platform-offline-grants")
@Controller("platform/offline-grants/rollbacks")
export class PlatformGrantRollbackController {
  constructor(private readonly rollbacks: PlatformGrantRollbackService) {}

  @Get("candidates")
  @ApiOperation({ summary: "List active strict activations eligible for rollback selection" })
  @PlatformApiProtectedOk({
    query: platformGrantRollbackContracts.candidates.query,
    response: platformGrantRollbackContracts.candidates.response,
  })
  @RequirePlatformCapabilities("tenants.read", "catalog.read")
  async candidates(
    @Query(new ZodValidationPipe(platformGrantRollbackContracts.candidates.query))
    query: PlatformGrantRollbackCandidatesQuery,
  ) {
    return parsePlatformResponse(
      platformGrantRollbackContracts.candidates.response,
      await this.rollbacks.candidates(query),
    );
  }

  @Get()
  @ApiOperation({ summary: "List offline grant rollback preparations" })
  @PlatformApiProtectedOk({
    query: platformGrantRollbackContracts.list.query,
    response: platformGrantRollbackContracts.list.response,
  })
  @RequirePlatformCapabilities("tenants.read", "catalog.read")
  async list(
    @Query(new ZodValidationPipe(platformGrantRollbackContracts.list.query))
    query: PlatformGrantRollbackListQuery,
  ) {
    return parsePlatformResponse(
      platformGrantRollbackContracts.list.response,
      await this.rollbacks.list(query),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Read one offline grant rollback" })
  @PlatformApiProtectedOk({ response: platformGrantRollbackContracts.detail.response })
  @RequirePlatformCapabilities("tenants.read", "catalog.read")
  async detail(@Param("id", new ParseUUIDPipe({ version: "4" })) id: string) {
    return parsePlatformResponse(
      platformGrantRollbackContracts.detail.response,
      await this.rollbacks.detail(id),
    );
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "Prepare an exact selective offline grant rollback" })
  @PlatformApiProtectedOk({
    body: platformGrantRollbackContracts.prepare.body,
    response: platformGrantRollbackContracts.prepare.response,
  })
  @RequirePlatformCapabilities(...MUTATION_CAPABILITIES)
  async prepare(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(platformGrantRollbackContracts.prepare.body))
    body: PlatformGrantRollbackPrepareRequest,
  ) {
    return parsePlatformResponse(
      platformGrantRollbackContracts.prepare.response,
      await this.rollbacks.prepare(request.platformPrincipal!, body),
    );
  }

  @Post(":id/confirm")
  @HttpCode(200)
  @ApiOperation({ summary: "Confirm a selective rollback with a second operator" })
  @PlatformApiProtectedOk({
    body: platformGrantRollbackContracts.confirm.body,
    response: platformGrantRollbackContracts.confirm.response,
  })
  @RequirePlatformCapabilities(...MUTATION_CAPABILITIES)
  async confirm(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body(new ZodValidationPipe(platformGrantRollbackContracts.confirm.body))
    body: PlatformGrantRollbackConfirmRequest,
  ) {
    return parsePlatformResponse(
      platformGrantRollbackContracts.confirm.response,
      await this.rollbacks.confirm(id, request.platformPrincipal!, body),
    );
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel an unconfirmed selective rollback" })
  @PlatformApiProtectedOk({
    body: platformGrantRollbackContracts.cancel.body,
    response: platformGrantRollbackContracts.cancel.response,
  })
  @RequirePlatformCapabilities(...MUTATION_CAPABILITIES)
  async cancel(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ParseUUIDPipe({ version: "4" })) id: string,
    @Body(new ZodValidationPipe(platformGrantRollbackContracts.cancel.body))
    body: PlatformGrantRollbackCancelRequest,
  ) {
    return parsePlatformResponse(
      platformGrantRollbackContracts.cancel.response,
      await this.rollbacks.cancel(id, request.platformPrincipal!, body),
    );
  }
}
