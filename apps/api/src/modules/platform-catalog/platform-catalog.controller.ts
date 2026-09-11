import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { platformCatalogContracts, platformCatalogV2Contracts } from "@markiro/platform-contracts";
import {
  isCommercialV2,
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
  @PlatformApiProtectedOk({ response: platformCatalogV2Contracts.editorContext.response })
  @RequirePlatformCapabilities("catalog.read")
  async editorContext(@Req() request: RequestWithPlatformPrincipal) {
    return parsePlatformResponse(
      platformCatalogV2Contracts.editorContext.response,
      await this.catalog.editorContext(request.platformPrincipal!),
    );
  }

  @Post("items/:id/versions/:versionId/review")
  @ApiOperation({ summary: "Review a catalog version against current seller policy" })
  @HttpCode(200)
  @PlatformApiProtectedOk({ response: platformCatalogV2Contracts.reviewVersion.response })
  @RequirePlatformCapabilities("catalog.write")
  async review(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
  ) {
    return parsePlatformResponse(
      platformCatalogV2Contracts.reviewVersion.response,
      await this.catalog.review(request.platformPrincipal!, id, versionId),
    );
  }

  @Get("items")
  @ApiOperation({ summary: "List catalog items" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.list.response,
    commercialV2: platformCatalogV2Contracts.list,
  })
  @RequirePlatformCapabilities("catalog.read")
  async list(@Req() request: RequestWithPlatformPrincipal) {
    return commercialResponse(
      isCommercialV2(request),
      platformCatalogContracts.list.response,
      platformCatalogV2Contracts.list.response,
      await this.catalog.list(request.platformPrincipal!),
    );
  }

  @Get("items/:id/versions")
  @ApiOperation({ summary: "List catalog item versions" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.listVersions.response,
    commercialV2: platformCatalogV2Contracts.listVersions,
  })
  @RequirePlatformCapabilities("catalog.read")
  async listVersions(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
  ) {
    return commercialResponse(
      isCommercialV2(request),
      platformCatalogContracts.listVersions.response,
      platformCatalogV2Contracts.listVersions.response,
      await this.catalog.listVersions(request.platformPrincipal!, id),
    );
  }

  @Get("items/:id/versions/:versionId")
  @ApiOperation({ summary: "Get a catalog item version" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.getVersion.response,
    commercialV2: platformCatalogV2Contracts.getVersion,
  })
  @RequirePlatformCapabilities("catalog.read")
  async getVersion(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
  ) {
    return commercialResponse(
      isCommercialV2(request),
      platformCatalogContracts.getVersion.response,
      platformCatalogV2Contracts.getVersion.response,
      await this.catalog.getVersion(request.platformPrincipal!, id, versionId),
    );
  }

  @Post("items/:id/versions")
  @ApiOperation({ summary: "Create a catalog item version" })
  @PlatformApiProtectedCreated({
    body: platformCatalogContracts.createVersion.body,
    response: platformCatalogContracts.createVersion.response,
    commercialV2: platformCatalogV2Contracts.createVersion,
  })
  @RequirePlatformCapabilities("catalog.write")
  async createVersion(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogMachineCodeSchema)) id: string,
    @Body() body: unknown,
  ) {
    return commercialResponse(
      isCommercialV2(request),
      platformCatalogContracts.createVersion.response,
      platformCatalogV2Contracts.createVersion.response,
      await this.catalog.createVersion(
        request.platformPrincipal!,
        id,
        commercialBody(
          isCommercialV2(request)
            ? platformCatalogV2Contracts.createVersion.body
            : platformCatalogContracts.createVersion.body,
          body,
        ),
        !isCommercialV2(request),
      ),
    );
  }

  @Patch("items/:id/versions/:versionId")
  @ApiOperation({ summary: "Update a catalog item version" })
  @PlatformApiProtectedOk({
    body: platformCatalogContracts.updateVersion.body,
    response: platformCatalogContracts.updateVersion.response,
    commercialV2: platformCatalogV2Contracts.updateVersion,
  })
  @RequirePlatformCapabilities("catalog.write")
  async updateVersion(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
    @Body() body: unknown,
  ) {
    return commercialResponse(
      isCommercialV2(request),
      platformCatalogContracts.updateVersion.response,
      platformCatalogV2Contracts.updateVersion.response,
      await this.catalog.updateVersion(
        request.platformPrincipal!,
        id,
        versionId,
        commercialBody(
          isCommercialV2(request)
            ? platformCatalogV2Contracts.updateVersion.body
            : platformCatalogContracts.updateVersion.body,
          body,
        ),
        !isCommercialV2(request),
      ),
    );
  }

  @Post("items/:id/versions/:versionId/publish")
  @HttpCode(200)
  @ApiOperation({ summary: "Publish a catalog item version" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.publishVersion.response,
    commercialV2: platformCatalogV2Contracts.publishVersion,
  })
  @RequirePlatformCapabilities("catalog.write")
  async publish(
    @Body() body: unknown,
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
  ) {
    return commercialResponse(
      isCommercialV2(request),
      platformCatalogContracts.publishVersion.response,
      platformCatalogV2Contracts.publishVersion.response,
      await this.catalog.publish(
        request.platformPrincipal!,
        id,
        versionId,
        isCommercialV2(request)
          ? commercialBody(platformCatalogV2Contracts.publishVersion.body, body)
          : undefined,
      ),
    );
  }

  @Post("items/:id/versions/:versionId/retire")
  @HttpCode(200)
  @ApiOperation({ summary: "Retire a catalog item version" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.retireVersion.response,
    commercialV2: platformCatalogV2Contracts.retireVersion,
  })
  @RequirePlatformCapabilities("catalog.write")
  async retire(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
  ) {
    return commercialResponse(
      isCommercialV2(request),
      platformCatalogContracts.retireVersion.response,
      platformCatalogV2Contracts.retireVersion.response,
      await this.catalog.retire(
        request.platformPrincipal!,
        id,
        versionId,
        !isCommercialV2(request),
      ),
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
  })
  @RequirePlatformCapabilities("catalog.write")
  async setDefaultDemo(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(setDefaultDemoPlanSchema)) body: SetDefaultDemoPlanDto,
  ) {
    return parsePlatformResponse(
      platformCatalogContracts.setDefaultDemo.response,
      await this.catalog.setDefaultDemo(request.platformPrincipal!, body),
    );
  }
}
