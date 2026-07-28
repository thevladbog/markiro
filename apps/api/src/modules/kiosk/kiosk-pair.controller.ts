import { Body, Controller, Ip, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../../zod.pipe";
import { pairKioskSchema, type PairKioskDto, type PairKioskResultDto } from "../pickup-orders/dto";
import { PairingService } from "./pairing.service";

/**
 * The one unauthenticated kiosk route: a device has no credential until this
 * call succeeds. It lives in its own controller because `KioskController`
 * applies `KioskDeviceGuard` at class level. Brute force is bounded by the
 * per-code attempt lockout AND the per-source fixed-window limiter, both in
 * `PairingService.redeem`.
 */
@ApiTags("kiosk")
@Controller("kiosk")
export class KioskPairController {
  constructor(private readonly pairingService: PairingService) {}

  @Post("pair")
  async pair(
    @Body(new ZodValidationPipe(pairKioskSchema)) body: PairKioskDto,
    @Ip() ip: string,
  ): Promise<PairKioskResultDto> {
    // An empty IP (seen behind some proxies/test clients) must still bound
    // something, rather than silently disabling the per-source limiter.
    return this.pairingService.redeem(body.code, ip || "unknown");
  }
}
