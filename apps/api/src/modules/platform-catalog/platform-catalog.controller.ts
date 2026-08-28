import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { platformCatalogContracts } from "@markiro/platform-contracts";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import {
  PlatformApiProtectedCreated,
  PlatformApiProtectedOk,
} from "../../platform-http/platform-openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import {
  createCatalogVersionSchema,
  catalogItemReferenceSchema,
  catalogMachineCodeSchema,
  catalogVersionIdSchema,
  setDefaultDemoPlanSchema,
  updateCatalogVersionSchema,
  type CreateCatalogVersionDto,
  type SetDefaultDemoPlanDto,
  type UpdateCatalogVersionDto,
} from "./dto";
import { PlatformCatalogService } from "./platform-catalog.service";

@ApiTags("platform-catalog")
@Controller("platform/catalog")
export class PlatformCatalogController {
  constructor(private readonly catalog: PlatformCatalogService) {}

  @Get("items")
  @ApiOperation({ summary: "List catalog items" })
  @PlatformApiProtectedOk({ response: platformCatalogContracts.list.response })
  @RequirePlatformCapabilities("catalog.read")
  async list(@Req() request: RequestWithPlatformPrincipal) {
    return parsePlatformResponse(
      platformCatalogContracts.list.response,
      await this.catalog.list(request.platformPrincipal!),
    );
  }

  @Get("items/:id/versions")
  @ApiOperation({ summary: "List catalog item versions" })
  @PlatformApiProtectedOk({ response: platformCatalogContracts.listVersions.response })
  @RequirePlatformCapabilities("catalog.read")
  async listVersions(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
  ) {
    return parsePlatformResponse(
      platformCatalogContracts.listVersions.response,
      await this.catalog.listVersions(request.platformPrincipal!, id),
    );
  }

  @Get("items/:id/versions/:versionId")
  @ApiOperation({ summary: "Get a catalog item version" })
  @PlatformApiProtectedOk({ response: platformCatalogContracts.getVersion.response })
  @RequirePlatformCapabilities("catalog.read")
  async getVersion(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
  ) {
    return parsePlatformResponse(
      platformCatalogContracts.getVersion.response,
      await this.catalog.getVersion(request.platformPrincipal!, id, versionId),
    );
  }

  @Post("items/:id/versions")
  @ApiOperation({ summary: "Create a catalog item version" })
  @PlatformApiProtectedCreated({
    body: platformCatalogContracts.createVersion.body,
    response: platformCatalogContracts.createVersion.response,
  })
  @RequirePlatformCapabilities("catalog.write")
  async createVersion(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogMachineCodeSchema)) id: string,
    @Body(new ZodValidationPipe(createCatalogVersionSchema)) body: CreateCatalogVersionDto,
  ) {
    return parsePlatformResponse(
      platformCatalogContracts.createVersion.response,
      await this.catalog.createVersion(request.platformPrincipal!, id, body),
    );
  }

  @Patch("items/:id/versions/:versionId")
  @ApiOperation({ summary: "Update a catalog item version" })
  @PlatformApiProtectedOk({
    body: platformCatalogContracts.updateVersion.body,
    response: platformCatalogContracts.updateVersion.response,
  })
  @RequirePlatformCapabilities("catalog.write")
  async updateVersion(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
    @Body(new ZodValidationPipe(updateCatalogVersionSchema)) body: UpdateCatalogVersionDto,
  ) {
    return parsePlatformResponse(
      platformCatalogContracts.updateVersion.response,
      await this.catalog.updateVersion(request.platformPrincipal!, id, versionId, body),
    );
  }

  @Post("items/:id/versions/:versionId/publish")
  @HttpCode(200)
  @ApiOperation({ summary: "Publish a catalog item version" })
  @PlatformApiProtectedOk({ response: platformCatalogContracts.publishVersion.response })
  @RequirePlatformCapabilities("catalog.write")
  async publish(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
  ) {
    return parsePlatformResponse(
      platformCatalogContracts.publishVersion.response,
      await this.catalog.publish(request.platformPrincipal!, id, versionId),
    );
  }

  @Post("items/:id/versions/:versionId/retire")
  @HttpCode(200)
  @ApiOperation({ summary: "Retire a catalog item version" })
  @PlatformApiProtectedOk({ response: platformCatalogContracts.retireVersion.response })
  @RequirePlatformCapabilities("catalog.write")
  async retire(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
  ) {
    return parsePlatformResponse(
      platformCatalogContracts.retireVersion.response,
      await this.catalog.retire(request.platformPrincipal!, id, versionId),
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
