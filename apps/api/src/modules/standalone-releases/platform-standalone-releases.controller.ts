import {
  platformStandaloneReleaseContracts,
  type StandaloneReleaseChannel,
  type StandaloneReleaseSetLatest,
  type StandaloneReleaseTarget,
} from "@markiro/platform-contracts";
import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { StandaloneReleasesService } from "./standalone-releases.service";

const contracts = platformStandaloneReleaseContracts;

/** «Выпуски автонома» (spec 2026-10-20 §5): nothing here signs; the owner's key stays offline. */
@ApiTags("platform-standalone-releases")
@Controller("platform/standalone-releases")
export class PlatformStandaloneReleasesController {
  constructor(private readonly releases: StandaloneReleasesService) {}

  @Get()
  @ApiOperation({ summary: "List standalone releases by channel with each channel's latest" })
  @PlatformApiProtectedOk({ response: contracts.list.response })
  @RequirePlatformCapabilities("standaloneReleases.manage")
  async list() {
    return parsePlatformResponse(contracts.list.response, await this.releases.list());
  }

  @Post("uploads")
  @HttpCode(200)
  @ApiOperation({
    summary: "Get presigned PUT URLs for a new version's installer and manifest",
    description:
      "Refused for a registered version or one not newer than every registered version in the channel.",
  })
  @PlatformApiProtectedOk({ body: contracts.upload.body, response: contracts.upload.response })
  @RequirePlatformCapabilities("standaloneReleases.manage")
  async upload(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(contracts.upload.body)) body: StandaloneReleaseTarget,
  ) {
    return parsePlatformResponse(
      contracts.upload.response,
      await this.releases.createUpload(request.platformPrincipal!, body),
    );
  }

  @Post("registrations")
  @HttpCode(200)
  @ApiOperation({
    summary: "Verify the uploaded files and register the version",
    description:
      "The API reads both objects back, checks the manifest's signature with the release keys, the channel, the version and the installer's SHA-256 and size. Every refusal is audited.",
  })
  @PlatformApiProtectedOk({ body: contracts.register.body, response: contracts.register.response })
  @RequirePlatformCapabilities("standaloneReleases.manage")
  async register(
    @Req() request: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(contracts.register.body)) body: StandaloneReleaseTarget,
  ) {
    return parsePlatformResponse(
      contracts.register.response,
      await this.releases.register(request.platformPrincipal!, body),
    );
  }

  @Put(":channel/latest")
  @ApiOperation({
    summary: "Point the channel's latest.json at a registered version (promote or roll back)",
  })
  @PlatformApiProtectedOk({
    body: contracts.setLatest.body,
    response: contracts.setLatest.response,
  })
  @RequirePlatformCapabilities("standaloneReleases.manage")
  async setLatest(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("channel", new ZodValidationPipe(contracts.setLatest.params.shape.channel))
    channel: StandaloneReleaseChannel,
    @Body(new ZodValidationPipe(contracts.setLatest.body)) body: StandaloneReleaseSetLatest,
  ) {
    return parsePlatformResponse(
      contracts.setLatest.response,
      await this.releases.setLatest(request.platformPrincipal!, channel, body.version),
    );
  }
}
