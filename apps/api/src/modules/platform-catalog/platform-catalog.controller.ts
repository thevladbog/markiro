import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { ZodValidationPipe } from "../../zod.pipe";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import {
  createCatalogVersionSchema,
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
  list(@Req() request: RequestWithPlatformPrincipal) {
    return this.catalog.list(request.platformPrincipal!);
  }

  @Get("items/:id/versions")
  @RequirePlatformCapabilities("catalog.read")
  listVersions(@Req() request: RequestWithPlatformPrincipal, @Param("id") id: string) {
    return this.catalog.listVersions(request.platformPrincipal!, id);
  }

  @Get("items/:id/versions/:versionId")
  @RequirePlatformCapabilities("catalog.read")
  getVersion(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id") id: string,
    @Param("versionId") versionId: string,
  ) {
    return this.catalog.getVersion(request.platformPrincipal!, id, versionId);
  }

  @Post("items/:id/versions")
  @RequirePlatformCapabilities("catalog.write")
  createVersion(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(createCatalogVersionSchema)) body: CreateCatalogVersionDto,
  ) {
    return this.catalog.createVersion(request.platformPrincipal!, id, body);
  }

  @Patch("items/:id/versions/:versionId")
  @RequirePlatformCapabilities("catalog.write")
  updateVersion(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @Body(new ZodValidationPipe(updateCatalogVersionSchema)) body: UpdateCatalogVersionDto,
  ) {
    return this.catalog.updateVersion(request.platformPrincipal!, id, versionId, body);
  }

  @Post("items/:id/versions/:versionId/publish")
  @HttpCode(200)
  @RequirePlatformCapabilities("catalog.write")
  publish(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id") id: string,
    @Param("versionId") versionId: string,
  ) {
    return this.catalog.publish(request.platformPrincipal!, id, versionId);
  }

  @Post("items/:id/versions/:versionId/retire")
  @HttpCode(200)
  @RequirePlatformCapabilities("catalog.write")
  retire(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id") id: string,
    @Param("versionId") versionId: string,
  ) {
    return this.catalog.retire(request.platformPrincipal!, id, versionId);
  }

  @Post("items/:id/archive")
  @HttpCode(200)
  @RequirePlatformCapabilities("catalog.write")
  archive(@Req() request: RequestWithPlatformPrincipal, @Param("id") id: string) {
    return this.catalog.archive(request.platformPrincipal!, id);
  }
}

@Controller("platform/settings")
export class PlatformSettingsController {
  constructor(private readonly catalog: PlatformCatalogService) {}

  @Get("demo-plan")
  @RequirePlatformCapabilities("catalog.read")
  getDefaultDemo(@Req() request: RequestWithPlatformPrincipal) {
    return this.catalog.getDefaultDemo(request.platformPrincipal!);
  }

  @Patch("demo-plan")
  @RequirePlatformCapabilities("catalog.write")
  setDefaultDemo(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(setDefaultDemoPlanSchema)) body: SetDefaultDemoPlanDto,
  ) {
    return this.catalog.setDefaultDemo(request.platformPrincipal!, body);
  }
}
