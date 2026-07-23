import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { KioskDeviceGuard, type RequestWithKiosk } from "../../tenancy/kiosk-device.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { createOrderSchema, type CreateOrderDto, type CreateOrderResultDto, type KioskBootstrapDto } from "../pickup-orders/dto";
import { PickupOrdersService } from "../pickup-orders/pickup-orders.service";

/** Device-facing routes under `/kiosk`, authenticated via `x-kiosk-token` (no session cookie). */
@ApiTags("kiosk")
@Controller("kiosk")
@UseGuards(KioskDeviceGuard)
export class KioskController {
  constructor(private readonly pickupOrdersService: PickupOrdersService) {}

  @Get("bootstrap")
  async bootstrap(@Req() req: RequestWithKiosk): Promise<KioskBootstrapDto> {
    return this.pickupOrdersService.bootstrap(req.tenantId!, req.kioskId!);
  }

  @Post("orders")
  async createOrder(
    @Req() req: RequestWithKiosk,
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderDto,
  ): Promise<CreateOrderResultDto> {
    return this.pickupOrdersService.createFromKiosk(req.tenantId!, req.kioskId!, body);
  }
}
