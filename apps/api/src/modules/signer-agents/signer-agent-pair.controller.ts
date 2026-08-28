import { Body, Controller, Header, Ip, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { chzSignerPairResponseSchema } from "@markiro/platform-contracts";
import { ApiZodBody, ApiZodResponse, ApiZodValidationError } from "../../lib/openapi";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  pairSignerAgentSchema,
  type PairSignerAgentDto,
  type PairSignerAgentResultDto,
} from "./dto";
import { SignerAgentsService } from "./signer-agents.service";

/**
 * The one unauthenticated signer-agent route: the desktop agent has no
 * credential until this call succeeds. Deliberately its own controller,
 * not a route on `SignerAgentsController`, which applies the cabinet-session
 * guard stack at class level (same reasoning as `KioskPairController`).
 * Brute force is bounded by the per-code attempt lockout AND the shared
 * fixed-window pairing rate limiter, both in `SignerAgentsService.pair`.
 */
@ApiTags("signer-agent")
@Controller("signer-agent")
export class SignerAgentPairController {
  constructor(private readonly service: SignerAgentsService) {}

  @Post("pair")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Pair a Chestny ZNAK signer agent",
    description:
      "The one unauthenticated signer-agent route: exchanges the single-use 8-digit code shown in the cabinet for the agent's device credential. Bounded by a per-code attempt lockout and a fixed-window rate limiter.",
  })
  @ApiZodBody(pairSignerAgentSchema)
  @ApiZodResponse({
    status: 201,
    schema: chzSignerPairResponseSchema,
    description: "Agent identity and its one-time secret reveal.",
  })
  @ApiZodValidationError()
  @ApiResponse({
    status: 401,
    description:
      "Wrong, expired, used, or locked-out code, or the pairing rate limit was exceeded.",
  })
  async pair(
    @Body(new ZodValidationPipe(pairSignerAgentSchema)) body: PairSignerAgentDto,
    @Ip() ip: string,
  ): Promise<PairSignerAgentResultDto> {
    return this.service.pair(body.pairingCode, ip, body.hostname, body.appVersion);
  }
}
