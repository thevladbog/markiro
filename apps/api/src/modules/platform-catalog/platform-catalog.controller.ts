import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  platformCatalogContracts,
  platformCatalogV2Contracts,
  platformCatalogV3Contracts,
} from "@markiro/platform-contracts";
import {
  commercialVersion,
  commercialBody,
  commercialResponse,
} from "../../platform-http/commercial-version";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import {
  PlatformApiProtectedCreated,
  PlatformApiProtectedOk,
} from "../../platform-http/platform-openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import {
  catalogItemReferenceSchema,
  catalogMachineCodeSchema,
  catalogVersionIdSchema,
  setDefaultDemoPlanSchema,
  type SetDefaultDemoPlanDto,
} from "./dto";
import { PlatformCatalogService } from "./platform-catalog.service";

@ApiTags("platform-catalog")
@Controller("platform/catalog")
export class PlatformCatalogController {
  constructor(private readonly catalog: PlatformCatalogService) {}

  @Get("editor-context")
  @ApiOperation({ summary: "Get commercial catalog editor context" })
  @PlatformApiProtectedOk({
    response: platformCatalogV2Contracts.editorContext.response,
    commercialV2: platformCatalogV2Contracts.editorContext,
    commercialV3: platformCatalogV3Contracts.editorContext,
  })
  @RequirePlatformCapabilities("catalog.read")
  async editorContext(@Req() request: RequestWithPlatformPrincipal) {
    return parsePlatformResponse(
      commercialVersion(request) === 3
        ? platformCatalogV3Contracts.editorContext.response
        : platformCatalogV2Contracts.editorContext.response,
      await this.catalog.editorContext(request.platformPrincipal!, commercialVersion(request)),
    );
  }

  @Post("items/:id/versions/:versionId/review")
  @ApiOperation({ summary: "Review a catalog version against current seller policy" })
  @HttpCode(200)
  @PlatformApiProtectedOk({
    response: platformCatalogV2Contracts.reviewVersion.response,
    commercialV2: platformCatalogV2Contracts.reviewVersion,
    commercialV3: platformCatalogV3Contracts.reviewVersion,
  })
  @RequirePlatformCapabilities("catalog.write")
  async review(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
  ) {
    return parsePlatformResponse(
      commercialVersion(request) === 3
        ? platformCatalogV3Contracts.reviewVersion.response
        : platformCatalogV2Contracts.reviewVersion.response,
      await this.catalog.review(
        request.platformPrincipal!,
        id,
        versionId,
        commercialVersion(request),
      ),
    );
  }

  @Get("items")
  @ApiOperation({ summary: "List catalog items" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.list.response,
    commercialV2: platformCatalogV2Contracts.list,
    commercialV3: platformCatalogV3Contracts.list,
  })
  @RequirePlatformCapabilities("catalog.read")
  async list(@Req() request: RequestWithPlatformPrincipal) {
    return commercialResponse(
      commercialVersion(request),
      platformCatalogContracts.list.response,
      platformCatalogV2Contracts.list.response,
      await this.catalog.list(request.platformPrincipal!),
      platformCatalogV3Contracts.list.response,
    );
  }

  @Get("items/:id/versions")
  @ApiOperation({ summary: "List catalog item versions" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.listVersions.response,
    commercialV2: platformCatalogV2Contracts.listVersions,
    commercialV3: platformCatalogV3Contracts.listVersions,
  })
  @RequirePlatformCapabilities("catalog.read")
  async listVersions(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
  ) {
    return commercialResponse(
      commercialVersion(request),
      platformCatalogContracts.listVersions.response,
      platformCatalogV2Contracts.listVersions.response,
      await this.catalog.listVersions(request.platformPrincipal!, id),
      platformCatalogV3Contracts.listVersions.response,
    );
  }

  @Get("items/:id/versions/:versionId")
  @ApiOperation({ summary: "Get a catalog item version" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.getVersion.response,
    commercialV2: platformCatalogV2Contracts.getVersion,
    commercialV3: platformCatalogV3Contracts.getVersion,
  })
  @RequirePlatformCapabilities("catalog.read")
  async getVersion(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
  ) {
    return commercialResponse(
      commercialVersion(request),
      platformCatalogContracts.getVersion.response,
      platformCatalogV2Contracts.getVersion.response,
      await this.catalog.getVersion(request.platformPrincipal!, id, versionId),
      platformCatalogV3Contracts.getVersion.response,
    );
  }

  @Post("items/:id/versions")
  @ApiOperation({ summary: "Create a catalog item version" })
  @PlatformApiProtectedCreated({
    body: platformCatalogContracts.createVersion.body,
    response: platformCatalogContracts.createVersion.response,
    commercialV2: platformCatalogV2Contracts.createVersion,
    commercialV3: platformCatalogV3Contracts.createVersion,
  })
  @RequirePlatformCapabilities("catalog.write")
  async createVersion(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogMachineCodeSchema)) id: string,
    @Body() body: unknown,
  ) {
    return commercialResponse(
      commercialVersion(request),
      platformCatalogContracts.createVersion.response,
      platformCatalogV2Contracts.createVersion.response,
      await this.catalog.createVersion(
        request.platformPrincipal!,
        id,
        commercialBody(
          commercialVersion(request) === 3
            ? platformCatalogV3Contracts.createVersion.body
            : commercialVersion(request) === 2
              ? platformCatalogV2Contracts.createVersion.body
              : platformCatalogContracts.createVersion.body,
          body,
          commercialVersion(request),
        ),
        commercialVersion(request),
      ),
      platformCatalogV3Contracts.createVersion.response,
    );
  }

  @Patch("items/:id/versions/:versionId")
  @ApiOperation({ summary: "Update a catalog item version" })
  @PlatformApiProtectedOk({
    body: platformCatalogContracts.updateVersion.body,
    response: platformCatalogContracts.updateVersion.response,
    commercialV2: platformCatalogV2Contracts.updateVersion,
    commercialV3: platformCatalogV3Contracts.updateVersion,
  })
  @RequirePlatformCapabilities("catalog.write")
  async updateVersion(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
    @Body() body: unknown,
  ) {
    return commercialResponse(
      commercialVersion(request),
      platformCatalogContracts.updateVersion.response,
      platformCatalogV2Contracts.updateVersion.response,
      await this.catalog.updateVersion(
        request.platformPrincipal!,
        id,
        versionId,
        commercialBody(
          commercialVersion(request) === 3
            ? platformCatalogV3Contracts.updateVersion.body
            : commercialVersion(request) === 2
              ? platformCatalogV2Contracts.updateVersion.body
              : platformCatalogContracts.updateVersion.body,
          body,
          commercialVersion(request),
        ),
        commercialVersion(request),
      ),
      platformCatalogV3Contracts.updateVersion.response,
    );
  }

  @Post("items/:id/versions/:versionId/publish")
  @HttpCode(200)
  @ApiOperation({ summary: "Publish a catalog item version" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.publishVersion.response,
    commercialV2: platformCatalogV2Contracts.publishVersion,
    commercialV3: platformCatalogV3Contracts.publishVersion,
  })
  @RequirePlatformCapabilities("catalog.write")
  async publish(
    @Body() body: unknown,
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
  ) {
    return commercialResponse(
      commercialVersion(request),
      platformCatalogContracts.publishVersion.response,
      platformCatalogV2Contracts.publishVersion.response,
      await this.catalog.publish(
        request.platformPrincipal!,
        id,
        versionId,
        commercialVersion(request) === 3
          ? commercialBody(platformCatalogV3Contracts.publishVersion.body, body)
          : commercialVersion(request) === 2
            ? commercialBody(platformCatalogV2Contracts.publishVersion.body, body)
            : undefined,
        commercialVersion(request),
      ),
      platformCatalogV3Contracts.publishVersion.response,
    );
  }

  @Post("items/:id/versions/:versionId/retire")
  @HttpCode(200)
  @ApiOperation({ summary: "Retire a catalog item version" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.retireVersion.response,
    commercialV2: platformCatalogV2Contracts.retireVersion,
    commercialV3: platformCatalogV3Contracts.retireVersion,
  })
  @RequirePlatformCapabilities("catalog.write")
  async retire(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
  ) {
    return commercialResponse(
      commercialVersion(request),
      platformCatalogContracts.retireVersion.response,
      platformCatalogV2Contracts.retireVersion.response,
      await this.catalog.retire(
        request.platformPrincipal!,
        id,
        versionId,
        commercialVersion(request),
      ),
      platformCatalogV3Contracts.retireVersion.response,
    );
  }

  @Post("items/:id/archive")
  @HttpCode(200)
  @ApiOperation({ summary: "Archive a catalog item" })
  @PlatformApiProtectedOk({ response: platformCatalogContracts.archiveItem.response })
  @RequirePlatformCapabilities("catalog.write")
  async archive(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
  ) {
    return parsePlatformResponse(
      platformCatalogContracts.archiveItem.response,
      await this.catalog.archive(request.platformPrincipal!, id),
    );
  }
}

@ApiTags("platform-catalog")
@Controller("platform/settings")
export class PlatformSettingsController {
  constructor(private readonly catalog: PlatformCatalogService) {}

  @Get("demo-plan")
  @ApiOperation({ summary: "Get the default demo plan" })
  @PlatformApiProtectedOk({ response: platformCatalogContracts.getDefaultDemo.response })
  @RequirePlatformCapabilities("catalog.read")
  async getDefaultDemo(@Req() request: RequestWithPlatformPrincipal) {
    return parsePlatformResponse(
      platformCatalogContracts.getDefaultDemo.response,
      await this.catalog.getDefaultDemo(request.platformPrincipal!),
    );
  }

  @Patch("demo-plan")
  @ApiOperation({
    summary: "Set the default demo plan",
    description: "Selects the catalog plan version assigned to newly provisioned demo tenants.",
  })
  @PlatformApiProtectedOk({
    body: platformCatalogContracts.setDefaultDemo.body,
    response: platformCatalogContracts.setDefaultDemo.response,
    commercialV2: platformCatalogV2Contracts.setDefaultDemo,
    commercialV3: platformCatalogV3Contracts.setDefaultDemo,
  })
  @RequirePlatformCapabilities("catalog.write")
  async setDefaultDemo(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(setDefaultDemoPlanSchema)) body: SetDefaultDemoPlanDto,
  ) {
    return parsePlatformResponse(
      platformCatalogContracts.setDefaultDemo.response,
      await this.catalog.setDefaultDemo(
        request.platformPrincipal!,
        body,
        commercialVersion(request),
      ),
    );
  }
}
