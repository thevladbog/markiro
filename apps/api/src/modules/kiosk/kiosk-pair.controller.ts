import { Body, Controller, Header, Ip, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../../zod.pipe";
import { pairKioskSchema, type PairKioskDto, type PairKioskResultDto } from "../pickup-orders/dto";
import { PairingService } from "./pairing.service";
import { ApiKioskPairSecretResponse } from "../device-pairing/secret-response.openapi";

/**
 * The one unauthenticated kiosk route: a device has no credential until this
 * call succeeds. It lives in its own controller because `KioskController`
 * applies `KioskDeviceGuard` at class level. Brute force is bounded by the
 * per-code attempt lockout AND a fixed-window limiter (per-source plus a
 * global backstop), both in `PairingService.redeem`. `@Ip()` only resolves
 * to the real client address when `TRUST_PROXY_HOPS` is configured for the
 * deployment topology (see `main.ts`) -- otherwise every caller collapses
 * onto one bucket and the global backstop is what's actually bounding this
 * route.
 */
@ApiTags("kiosk")
@Controller("kiosk")
export class KioskPairController {
  constructor(private readonly pairingService: PairingService) {}

  @Post("pair")
  @Header("Cache-Control", "no-store")
  @ApiKioskPairSecretResponse()
  async pair(
    @Body(new ZodValidationPipe(pairKioskSchema)) body: PairKioskDto,
    @Ip() ip: string,
  ): Promise<PairKioskResultDto> {
    // Pass the resolved IP through as-is, including empty (seen behind some
    // proxies/test clients). `PairingService.redeem` treats an empty source
    // as unattributable and counts it ONLY against the global backstop --
    // folding it into a shared "unknown" per-source bucket would let an
    // unidentifiable caller lock out every other unidentifiable caller, and
    // worse, would let anyone who can make their source look empty consume a
    // budget alongside legitimate callers.
    return this.pairingService.redeem(body.code, ip);
  }
}
