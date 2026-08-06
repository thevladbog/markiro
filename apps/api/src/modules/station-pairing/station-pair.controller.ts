import { Body, Controller, Header, Ip, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ZodValidationPipe } from "../../zod.pipe";
import { pairStationSchema, type PairStationDto, type PairStationResultDto } from "./dto";
import { StationPairingService } from "./station-pairing.service";
import { ApiStationPairSecretResponse } from "../device-pairing/secret-response.openapi";

/**
 * Deliberately unauthenticated: an unpaired station has no credential yet.
 * Pairing security is enforced by the shared per-source/global limiter and
 * the single-use HMAC-protected code in StationPairingService.
 */
@ApiTags("station")
@Controller("station")
export class StationPairController {
  constructor(private readonly pairing: StationPairingService) {}

  @Post("pair")
  @Header("Cache-Control", "no-store")
  @ApiStationPairSecretResponse()
  async pair(
    @Body(new ZodValidationPipe(pairStationSchema)) body: PairStationDto,
    @Ip() ip: string,
  ): Promise<PairStationResultDto> {
    return this.pairing.redeem(body.code, ip);
  }
}
