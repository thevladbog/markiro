import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { KioskDeviceGuard, type RequestWithKiosk } from "../../tenancy/kiosk-device.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  AllowSubscriptionReadOnly,
  AllowSubscriptionRecovery,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import {
  createOrderAdmissionSchema,
  createOrderSchema,
  type CreateOrderAdmissionDto,
  type CreateOrderAdmissionResultDto,
  type CreateOrderDto,
  type CreateOrderResultDto,
  type KioskBootstrapDto,
} from "../pickup-orders/dto";
import { PickupOrdersService } from "../pickup-orders/pickup-orders.service";

/** Device-facing routes under `/kiosk`, authenticated via `x-kiosk-token` (no session cookie). */
@ApiTags("kiosk")
@Controller("kiosk")
@UseGuards(KioskDeviceGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class KioskController {
  constructor(private readonly pickupOrdersService: PickupOrdersService) {}

  @Get("bootstrap")
  async bootstrap(@Req() req: RequestWithKiosk): Promise<KioskBootstrapDto> {
    return this.pickupOrdersService.bootstrap(req.tenantId!, req.kioskId!);
  }

  @Post("order-admissions")
  @RequireSubscriptionWrite()
  async attestOrder(
    @Req() req: RequestWithKiosk,
    @Body(new ZodValidationPipe(createOrderAdmissionSchema)) body: CreateOrderAdmissionDto,
  ): Promise<CreateOrderAdmissionResultDto> {
    return this.pickupOrdersService.attestKioskOrder(req.tenantId!, req.kioskId!, body);
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
