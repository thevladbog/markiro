import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createOfferSchema,
  offerIdSchema,
  paymentSchema,
  type CreateOfferDto,
  type PaymentDto,
} from "./dto";
import { PlatformOffersService } from "./platform-offers.service";

@Controller("platform/offers")
export class PlatformOffersController {
  constructor(private readonly offers: PlatformOffersService) {}

  @Get()
  @RequirePlatformCapabilities("billing.read")
  list(@Req() req: RequestWithPlatformPrincipal, @Query("tenantId") tenantId?: string) {
    return this.offers.list(req.platformPrincipal!, tenantId);
  }

  @Get(":id")
  @RequirePlatformCapabilities("billing.read")
  detail(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(offerIdSchema)) id: string,
  ) {
    return this.offers.detail(req.platformPrincipal!, id);
  }

  @Post()
  @RequirePlatformCapabilities("billing.write")
  create(
    @Req() req: RequestWithPlatformPrincipal,
    @Body(new ZodValidationPipe(createOfferSchema)) body: CreateOfferDto,
  ) {
    return this.offers.create(req.platformPrincipal!, body);
  }

  @Post(":id/publish")
  @HttpCode(200)
  @RequirePlatformCapabilities("billing.write")
  publish(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(offerIdSchema)) id: string,
  ) {
    return this.offers.publish(req.platformPrincipal!, id);
  }

  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePlatformCapabilities("billing.write")
  cancel(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(offerIdSchema)) id: string,
  ) {
    return this.offers.cancel(req.platformPrincipal!, id);
  }

  @Post(":id/payment")
  @RequirePlatformCapabilities("billing.write")
  pay(
    @Req() req: RequestWithPlatformPrincipal,
    @Param("id", new ZodValidationPipe(offerIdSchema)) id: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body(new ZodValidationPipe(paymentSchema)) body: PaymentDto,
  ) {
    return this.offers.pay(req.platformPrincipal!, id, key ?? "", body);
  }
}
