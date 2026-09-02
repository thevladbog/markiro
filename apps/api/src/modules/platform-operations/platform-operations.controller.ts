import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  platformNationalCatalogContracts,
  platformOperationsContracts,
  platformUuidSchema,
} from "@markiro/platform-contracts";

import {
  RequirePlatformCapabilities,
  type PlatformPrincipal,
} from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { PlatformOperationsService } from "./platform-operations.service";
import { ZodValidationPipe } from "../../zod.pipe";
import { NationalCatalogSchemaService } from "../national-catalog/national-catalog-schema.service";
import { z } from "zod";

function requirePlatformPrincipal(request: RequestWithPlatformPrincipal): PlatformPrincipal {
  const principal = request.platformPrincipal;
  if (!principal) throw new UnauthorizedException();
  return principal;
}

@ApiTags("platform-operations")
@Controller("platform/operations")
export class PlatformOperationsController {
  constructor(
    private readonly operations: PlatformOperationsService,
    private readonly nationalCatalogSchemas: NationalCatalogSchemaService,
  ) {}

  @Get("overview")
  @ApiOperation({
    summary: "Get platform operations overview",
    description: "The returned sections depend on the caller's platform role.",
  })
  @PlatformApiProtectedOk({ response: platformOperationsContracts.overview.response })
  @RequirePlatformCapabilities("tenants.read")
  async overview(@Req() request: RequestWithPlatformPrincipal) {
    const principal = request.platformPrincipal;
    if (!principal) throw new UnauthorizedException();
    return parsePlatformResponse(
      platformOperationsContracts.overview.response,
      await this.operations.overview(principal.role),
    );
  }

  @Get("monitoring")
  @ApiOperation({ summary: "Get platform monitoring metrics" })
  @PlatformApiProtectedOk({ response: platformOperationsContracts.monitoring.response })
  @RequirePlatformCapabilities("diagnostics.read")
  async monitoring() {
    return parsePlatformResponse(
      platformOperationsContracts.monitoring.response,
      await this.operations.monitoring(),
    );
  }

  @Post("national-catalog/schema-refresh")
  @HttpCode(200)
  @ApiOperation({ summary: "Discover immutable National Catalog schema observations" })
  @PlatformApiProtectedOk({
    body: platformNationalCatalogContracts.refresh.body,
    response: platformNationalCatalogContracts.refresh.response,
  })
  @RequirePlatformCapabilities("catalog.write")
  async refreshNationalCatalogSchemas(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(platformNationalCatalogContracts.refresh.body))
    body: { sourceTenantId: string },
  ) {
    return parsePlatformResponse(
      platformNationalCatalogContracts.refresh.response,
      await this.nationalCatalogSchemas.refresh(
        body.sourceTenantId,
        requirePlatformPrincipal(request),
      ),
    );
  }

  @Post("national-catalog/schema-versions/:id/activate")
  @HttpCode(200)
  @ApiOperation({ summary: "Activate one reviewed National Catalog schema version" })
  @PlatformApiProtectedOk({ response: platformNationalCatalogContracts.activate.response })
  @RequirePlatformCapabilities("catalog.write")
  async activateNationalCatalogSchema(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformUuidSchema)) schemaVersionId: string,
  ) {
    return parsePlatformResponse(
      platformNationalCatalogContracts.activate.response,
      await this.nationalCatalogSchemas.activate(
        schemaVersionId,
        requirePlatformPrincipal(request),
      ),
    );
  }

  @Post("national-catalog/schema-versions/:id/attribute-mappings/review")
  @HttpCode(200)
  @ApiOperation({ summary: "Review stable-field mappings for one National Catalog schema" })
  @PlatformApiProtectedOk({
    body: platformNationalCatalogContracts.reviewAttributeMappings.body,
    response: platformNationalCatalogContracts.reviewAttributeMappings.response,
  })
  @RequirePlatformCapabilities("catalog.write")
  async reviewNationalCatalogAttributeMappings(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformUuidSchema)) schemaVersionId: string,
    @Body(new ZodValidationPipe(platformNationalCatalogContracts.reviewAttributeMappings.body))
    body: {
      mappings: Array<{
        sourceAttributeId: string;
        targetField: "name" | "print_name" | "shelf_life_days";
        conversion: { kind: "identity" | "string_trim" | "positive_integer" };
        mappingVersion: number;
      }>;
    },
  ) {
    return parsePlatformResponse(
      platformNationalCatalogContracts.reviewAttributeMappings.response,
      await this.nationalCatalogSchemas.reviewAttributeMappings(
        schemaVersionId,
        body.mappings,
        requirePlatformPrincipal(request),
      ),
    );
  }

  @Post("national-catalog/group-mappings/:code/review")
  @HttpCode(200)
  @ApiOperation({ summary: "Review an exact, ambiguous, or unmapped classifier mapping" })
  @PlatformApiProtectedOk({
    body: platformNationalCatalogContracts.reviewGroupMapping.body,
    response: platformNationalCatalogContracts.reviewGroupMapping.response,
  })
  @RequirePlatformCapabilities("catalog.write")
  async reviewNationalCatalogGroupMapping(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("code", new ZodValidationPipe(z.coerce.number().int().positive()))
    chzProductGroupCode: number,
    @Body(new ZodValidationPipe(platformNationalCatalogContracts.reviewGroupMapping.body))
    body: { state: "exact" | "ambiguous" | "unmapped"; schemaVersionIds: string[] },
  ) {
    return parsePlatformResponse(
      platformNationalCatalogContracts.reviewGroupMapping.response,
      await this.nationalCatalogSchemas.reviewGroupMapping(
        chzProductGroupCode,
        body,
        requirePlatformPrincipal(request),
      ),
    );
  }
}
