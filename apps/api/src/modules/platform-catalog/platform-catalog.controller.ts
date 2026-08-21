import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { platformCatalogContracts } from "@markiro/platform-contracts";
import { parsePlatformResponse } from "../../platform-http/platform-response";
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

@Controller("platform/catalog")
export class PlatformCatalogController {
  constructor(private readonly catalog: PlatformCatalogService) {}

  @Get("items")
  @RequirePlatformCapabilities("catalog.read")
  async list(@Req() request: RequestWithPlatformPrincipal) {
    return parsePlatformResponse(
      platformCatalogContracts.list.response,
      await this.catalog.list(request.platformPrincipal!),
    );
  }

  @Get("items/:id/versions")
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

@Controller("platform/settings")
export class PlatformSettingsController {
  constructor(private readonly catalog: PlatformCatalogService) {}

  @Get("demo-plan")
  @RequirePlatformCapabilities("catalog.read")
  async getDefaultDemo(@Req() request: RequestWithPlatformPrincipal) {
    return parsePlatformResponse(
      platformCatalogContracts.getDefaultDemo.response,
      await this.catalog.getDefaultDemo(request.platformPrincipal!),
    );
  }

  @Patch("demo-plan")
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
