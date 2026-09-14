import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  platformCatalogContracts,
  platformCatalogV2Contracts,
  platformCatalogV3Contracts,
  platformCatalogV4Contracts,
  platformOfflineGrantPolicyContracts,
  platformUuidSchema,
  type ApproveOfflineGrantPolicy,
  type CreateOfflineGrantPolicy,
} from "@markiro/platform-contracts";
import {
  commercialVersion,
  commercialBody,
  commercialResponse,
  type CommercialVersion,
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

  @Get("lifecycle-policies")
  @ApiOperation({ summary: "List offline grant lifecycle policies" })
  @PlatformApiProtectedOk({ response: platformOfflineGrantPolicyContracts.list.response })
  @RequirePlatformCapabilities("catalog.read")
  async listLifecyclePolicies(@Req() request: RequestWithPlatformPrincipal) {
    return parsePlatformResponse(
      platformOfflineGrantPolicyContracts.list.response,
      await this.catalog.listOfflineGrantPolicies(request.platformPrincipal!),
    );
  }

  @Post("lifecycle-policies")
  @ApiOperation({ summary: "Create an offline grant lifecycle policy draft" })
  @PlatformApiProtectedCreated({
    body: platformOfflineGrantPolicyContracts.create.body,
    response: platformOfflineGrantPolicyContracts.create.response,
  })
  @RequirePlatformCapabilities("catalog.write")
  async createLifecyclePolicy(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(platformOfflineGrantPolicyContracts.create.body))
    body: CreateOfflineGrantPolicy,
  ) {
    return parsePlatformResponse(
      platformOfflineGrantPolicyContracts.create.response,
      await this.catalog.createOfflineGrantPolicy(request.platformPrincipal!, body),
    );
  }

  @Post("lifecycle-policies/:id/approve")
  @HttpCode(200)
  @ApiOperation({ summary: "Approve an offline grant lifecycle policy" })
  @PlatformApiProtectedOk({
    body: platformOfflineGrantPolicyContracts.approve.body,
    response: platformOfflineGrantPolicyContracts.approve.response,
  })
  @RequirePlatformCapabilities("catalog.write")
  async approveLifecyclePolicy(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(platformUuidSchema)) id: string,
    @Body(new ZodValidationPipe(platformOfflineGrantPolicyContracts.approve.body))
    body: ApproveOfflineGrantPolicy,
  ) {
    return parsePlatformResponse(
      platformOfflineGrantPolicyContracts.approve.response,
      await this.catalog.approveOfflineGrantPolicy(request.platformPrincipal!, id, body),
    );
  }

  @Get("editor-context")
  @ApiOperation({ summary: "Get commercial catalog editor context" })
  @PlatformApiProtectedOk({
    response: platformCatalogV2Contracts.editorContext.response,
    commercialV2: platformCatalogV2Contracts.editorContext,
    commercialV3: platformCatalogV3Contracts.editorContext,
    commercialV4: platformCatalogV4Contracts.editorContext,
  })
  @RequirePlatformCapabilities("catalog.read")
  async editorContext(@Req() request: RequestWithPlatformPrincipal) {
    return parsePlatformResponse(
      commercialVersion(request) >= 3
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
    commercialV4: platformCatalogV4Contracts.reviewVersion,
  })
  @RequirePlatformCapabilities("catalog.write")
  async review(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(catalogItemReferenceSchema)) id: string,
    @Param("versionId", new ZodValidationPipe(catalogVersionIdSchema)) versionId: string,
  ) {
    return parsePlatformResponse(
      commercialVersion(request) >= 3
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
    commercialV4: platformCatalogV4Contracts.list,
  })
  @RequirePlatformCapabilities("catalog.read")
  async list(@Req() request: RequestWithPlatformPrincipal) {
    return commercialResponse(
      commercialVersion(request),
      platformCatalogContracts.list.response,
      platformCatalogV2Contracts.list.response,
      await this.catalog.list(request.platformPrincipal!),
      platformCatalogV3Contracts.list.response,
      platformCatalogV4Contracts.list.response,
    );
  }

  @Get("items/:id/versions")
  @ApiOperation({ summary: "List catalog item versions" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.listVersions.response,
    commercialV2: platformCatalogV2Contracts.listVersions,
    commercialV3: platformCatalogV3Contracts.listVersions,
    commercialV4: platformCatalogV4Contracts.listVersions,
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
      platformCatalogV4Contracts.listVersions.response,
    );
  }

  @Get("items/:id/versions/:versionId")
  @ApiOperation({ summary: "Get a catalog item version" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.getVersion.response,
    commercialV2: platformCatalogV2Contracts.getVersion,
    commercialV3: platformCatalogV3Contracts.getVersion,
    commercialV4: platformCatalogV4Contracts.getVersion,
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
      platformCatalogV4Contracts.getVersion.response,
    );
  }

  @Post("items/:id/versions")
  @ApiOperation({ summary: "Create a catalog item version" })
  @PlatformApiProtectedCreated({
    body: platformCatalogContracts.createVersion.body,
    response: platformCatalogContracts.createVersion.response,
    commercialV2: platformCatalogV2Contracts.createVersion,
    commercialV3: platformCatalogV3Contracts.createVersion,
    commercialV4: platformCatalogV4Contracts.createVersion,
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
        createCatalogVersionBody(commercialVersion(request), body),
        commercialVersion(request),
      ),
      platformCatalogV3Contracts.createVersion.response,
      platformCatalogV4Contracts.createVersion.response,
    );
  }

  @Patch("items/:id/versions/:versionId")
  @ApiOperation({ summary: "Update a catalog item version" })
  @PlatformApiProtectedOk({
    body: platformCatalogContracts.updateVersion.body,
    response: platformCatalogContracts.updateVersion.response,
    commercialV2: platformCatalogV2Contracts.updateVersion,
    commercialV3: platformCatalogV3Contracts.updateVersion,
    commercialV4: platformCatalogV4Contracts.updateVersion,
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
        updateCatalogVersionBody(commercialVersion(request), body),
        commercialVersion(request),
      ),
      platformCatalogV3Contracts.updateVersion.response,
      platformCatalogV4Contracts.updateVersion.response,
    );
  }

  @Post("items/:id/versions/:versionId/publish")
  @HttpCode(200)
  @ApiOperation({ summary: "Publish a catalog item version" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.publishVersion.response,
    commercialV2: platformCatalogV2Contracts.publishVersion,
    commercialV3: platformCatalogV3Contracts.publishVersion,
    commercialV4: platformCatalogV4Contracts.publishVersion,
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
        commercialVersion(request) >= 3
          ? commercialBody(platformCatalogV3Contracts.publishVersion.body, body)
          : commercialVersion(request) === 2
            ? commercialBody(platformCatalogV2Contracts.publishVersion.body, body)
            : undefined,
        commercialVersion(request),
      ),
      platformCatalogV3Contracts.publishVersion.response,
      platformCatalogV4Contracts.publishVersion.response,
    );
  }

  @Post("items/:id/versions/:versionId/retire")
  @HttpCode(200)
  @ApiOperation({ summary: "Retire a catalog item version" })
  @PlatformApiProtectedOk({
    response: platformCatalogContracts.retireVersion.response,
    commercialV2: platformCatalogV2Contracts.retireVersion,
    commercialV3: platformCatalogV3Contracts.retireVersion,
    commercialV4: platformCatalogV4Contracts.retireVersion,
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
      platformCatalogV4Contracts.retireVersion.response,
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

function createCatalogVersionBody(version: CommercialVersion, body: unknown) {
  if (version === 4) return commercialBody(platformCatalogV4Contracts.createVersion.body, body, 4);
  if (version === 3) return commercialBody(platformCatalogV3Contracts.createVersion.body, body, 3);
  if (version === 2) return commercialBody(platformCatalogV2Contracts.createVersion.body, body, 2);
  return commercialBody(platformCatalogContracts.createVersion.body, body, 1);
}

function updateCatalogVersionBody(version: CommercialVersion, body: unknown) {
  if (version === 4) return commercialBody(platformCatalogV4Contracts.updateVersion.body, body, 4);
  if (version === 3) return commercialBody(platformCatalogV3Contracts.updateVersion.body, body, 3);
  if (version === 2) return commercialBody(platformCatalogV2Contracts.updateVersion.body, body, 2);
  return commercialBody(platformCatalogContracts.updateVersion.body, body, 1);
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
    commercialV4: platformCatalogV4Contracts.setDefaultDemo,
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
