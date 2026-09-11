import {
  stationRecoveryRequestSchema,
  stationRecoveryResponseSchema,
  type StationRecoveryRequest,
  type StationRecoveryResponse,
} from "@markiro/platform-contracts";
import { Body, Controller, Get, Header, Headers, Ip, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  ApiHttpErrors,
  ApiStationAuth,
  ApiZodBody,
  ApiZodValidationError,
  zodApiSchema,
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
          required: ["id", "name", "kind", "tenantId", "organizationName", "line"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            kind: { type: "string", enum: ["station", "handheld"] },
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

  @Post("pair/recovery")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Recover the same station identity by code",
    description:
      "Unauthenticated by design: the authorized single-use code and shared rate limiter authenticate recovery. The expected tenant/device/kind must match the code's device before any credential is changed. Mismatch is a generic 401 and leaves the code live. Existing subscription write access and restoration quota checks apply; subscription is present only with subscription-state-v1, and handheld clients send handheld-v1.",
  })
  @ApiZodBody(stationRecoveryRequestSchema)
  @ApiResponse({
    status: 201,
    headers: { "Cache-Control": { schema: { type: "string", enum: ["no-store"] } } },
    schema: zodApiSchema(stationRecoveryResponseSchema),
  })
  @ApiZodValidationError()
  @ApiResponse({
    status: 403,
    description: "The authoritative tenant subscription denies write access.",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: { code: { type: "string", enum: ["subscription_read_only"] } },
    },
  })
  @ApiResponse({
    status: 409,
    description:
      "Subscription enforcement requires a managed subscription, or restoring a revoked device exceeds the stations quota.",
    schema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["code"],
          properties: { code: { type: "string", enum: ["subscription_unmanaged"] } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["code", "entitlement", "used", "limit"],
          properties: {
            code: { type: "string", enum: ["subscription_limit_reached"] },
            entitlement: { type: "string", enum: ["stations"] },
            used: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 0 },
          },
        },
      ],
    },
  })
  @ApiResponse({
    status: 401,
    schema: stationPairErrorOpenApiSchema,
    description:
      "Recovery rejected; PAIR_RECOVERY_MISMATCH exposes no foreign-device details. Existing pairing errors and rate limits also apply.",
  })
  async recovery(
    @Body(new ZodValidationPipe(stationRecoveryRequestSchema)) body: StationRecoveryRequest,
    @Ip() ip: string,
    @Headers("x-station-capabilities") capabilities: string | undefined,
  ): Promise<StationRecoveryResponse> {
    const paired = await this.pairing.redeem(body.code, ip, {
      expectedRecoveryIdentity: body.expected,
      includeSubscription: hasCapability(capabilities, "subscription-state-v1"),
      handheldClient: hasCapability(capabilities, "handheld-v1"),
    });
    return { version: 1, ...paired };
  }

  @Post("pair")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Pair a station by code",
    description:
      "Unauthenticated by design: an unpaired station has no credential, so the single-use code and its rate limiter are the boundary. A handheld app sends `handheld-v1` in x-station-capabilities; a code issued for the other device kind answers PAIR_KIND_MISMATCH and stays live.",
  })
  @ApiZodBody(pairStationSchema)
  @ApiStationPairSecretResponse()
  @ApiZodValidationError()
  @ApiResponse({
    status: 401,
    schema: stationPairErrorOpenApiSchema,
    description:
      "Pairing rejected; `code` distinguishes invalid, expired, locked, rate-limited, and kind-mismatched attempts.",
  })
  async pair(
    @Body(new ZodValidationPipe(pairStationSchema)) body: PairStationDto,
    @Ip() ip: string,
    @Headers("x-station-capabilities") capabilities: string | undefined,
  ): Promise<PairStationResultDto> {
    return this.pairing.redeem(body.code, ip, {
      includeSubscription: hasCapability(capabilities, "subscription-state-v1"),
      handheldClient: hasCapability(capabilities, "handheld-v1"),
    });
  }
}

function hasCapability(value: string | undefined, capability: string): boolean {
  return value?.split(",").some((candidate) => candidate.trim() === capability) ?? false;
}
