import { Body, Controller, Get, Headers, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { KioskDeviceGuard, type RequestWithKiosk } from "../../tenancy/kiosk-device.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { AllowSubscriptionRecovery } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import {
  createOrderSchema,
  MAX_KIOSK_DEVICE_SEQ,
  type CreateOrderDto,
  type CreateOrderResultDto,
  type KioskBootstrapDto,
} from "../pickup-orders/dto";
import { PickupOrdersService } from "../pickup-orders/pickup-orders.service";

/** Device-facing routes under `/kiosk`, authenticated via `x-kiosk-token` (no session cookie). */
@ApiTags("kiosk")
@Controller("kiosk")
@UseGuards(KioskDeviceGuard, SubscriptionAccessGuard)
export class KioskController {
  constructor(private readonly pickupOrdersService: PickupOrdersService) {}

  @Get("bootstrap")
  async bootstrap(
    @Req() req: RequestWithKiosk,
    @Headers("x-kiosk-next-device-seq") nextDeviceSeq: string | undefined,
  ): Promise<KioskBootstrapDto> {
    const parsed = nextDeviceSeq === undefined ? undefined : Number(nextDeviceSeq);
    const requested =
      Number.isSafeInteger(parsed) && parsed! >= 0 && parsed! <= MAX_KIOSK_DEVICE_SEQ
        ? parsed
        : undefined;
    return this.pickupOrdersService.bootstrap(req.tenantId!, req.kioskId!, requested);
  }

  @Post("orders")
  @AllowSubscriptionRecovery("kiosk")
  async createOrder(
    @Req() req: RequestWithKiosk,
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderDto,
  ): Promise<CreateOrderResultDto> {
    return this.pickupOrdersService.createFromKiosk(req.tenantId!, req.kioskId!, body);
  }
}
