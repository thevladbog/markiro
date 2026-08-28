import { Body, Controller, Get, Header, Headers, Ip, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  ApiHttpErrors,
  ApiStationAuth,
  ApiZodBody,
  ApiZodValidationError,
} from "../../lib/openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import { StationOnlyGuard } from "../../tenancy/station-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import {
  pairStationSchema,
  stationPairErrorOpenApiSchema,
  type PairStationDto,
  type PairStationResultDto,
  type StationIdentityResultDto,
} from "./dto";
import { StationPairingService } from "./station-pairing.service";
import {
  ApiStationPairSecretResponse,
  subscriptionAccessSchema,
} from "../device-pairing/secret-response.openapi";

/**
 * `pair` is deliberately unauthenticated because an unpaired station has no
 * credential; its code limiter is the boundary. `identity` carries explicit
 * method guards because only an existing station key may bootstrap itself.
 */
@ApiTags("station")
@Controller("station")
export class StationPairController {
  constructor(private readonly pairing: StationPairingService) {}

  @Get("identity")
  @UseGuards(TenantGuard, StationOnlyGuard)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Read station identity",
    description:
      "Authenticated bootstrap for an already-paired station; carries no credential material. `subscription` is present only when the x-station-capabilities header includes subscription-state-v1.",
  })
  @ApiStationAuth()
  @ApiHttpErrors(401, 403, 429)
  @ApiOkResponse({
    headers: {
      "Cache-Control": { schema: { type: "string", enum: ["no-store"] } },
    },
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["device"],
      properties: {
        device: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "tenantId", "organizationName", "line"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            tenantId: { type: "string" },
            organizationName: { type: "string" },
            line: {
              type: "object",
              nullable: true,
              additionalProperties: false,
              required: ["id", "name"],
              properties: { id: { type: "string" }, name: { type: "string" } },
            },
          },
        },
        subscription: {
          ...subscriptionAccessSchema,
          description: "Present only when the client sends subscription-state-v1.",
        },
      },
    },
  })
  identity(
    @Req() req: RequestWithTenant,
    @Headers("x-station-capabilities") capabilities: string | undefined,
  ): Promise<StationIdentityResultDto> {
    return this.pairing.identity(
      req.tenantId!,
      req.deviceId!,
      hasCapability(capabilities, "subscription-state-v1"),
    );
  }

  @Post("pair")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Pair a station by code",
    description:
      "Unauthenticated by design: an unpaired station has no credential, so the single-use code and its rate limiter are the boundary.",
  })
  @ApiZodBody(pairStationSchema)
  @ApiStationPairSecretResponse()
  @ApiZodValidationError()
  @ApiResponse({
    status: 401,
    schema: stationPairErrorOpenApiSchema,
    description:
      "Pairing rejected; `code` distinguishes invalid, expired, locked, and rate-limited attempts.",
  })
  async pair(
    @Body(new ZodValidationPipe(pairStationSchema)) body: PairStationDto,
    @Ip() ip: string,
    @Headers("x-station-capabilities") capabilities: string | undefined,
  ): Promise<PairStationResultDto> {
    return this.pairing.redeem(body.code, ip, hasCapability(capabilities, "subscription-state-v1"));
  }
}

function hasCapability(value: string | undefined, capability: string): boolean {
  return value?.split(",").some((candidate) => candidate.trim() === capability) ?? false;
}
