import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../../zod.pipe";
import { pairKioskSchema, type PairKioskDto, type PairKioskResultDto } from "../pickup-orders/dto";
import { PairingService } from "./pairing.service";

/**
 * The one unauthenticated kiosk route: a device has no credential until this
 * call succeeds. It lives in its own controller because `KioskController`
 * applies `KioskDeviceGuard` at class level. Brute force is bounded by the
 * per-code attempt lockout in `PairingService.redeem`.
 */
@ApiTags("kiosk")
@Controller("kiosk")
export class KioskPairController {
  constructor(private readonly pairingService: PairingService) {}

  @Post("pair")
  async pair(
    @Body(new ZodValidationPipe(pairKioskSchema)) body: PairKioskDto,
  ): Promise<PairKioskResultDto> {
    return this.pairingService.redeem(body.code);
  }
}
