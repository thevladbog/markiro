import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { ApiHeader, ApiTags } from "@nestjs/swagger";
import { KioskDeviceGuard, type RequestWithKiosk } from "../../tenancy/kiosk-device.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  AllowSubscriptionReadOnly,
  AllowSubscriptionRecovery,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { SubscriptionReadOnlyException } from "../../subscriptions/subscription-errors";
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

const KIOSK_RECOVERY_CAPABILITY = "subscription-recovery-v1";

function hasKioskRecoveryCapability(header: string | undefined): boolean {
  return header
    ? header
        .split(",")
        .map((value) => value.trim())
        .includes(KIOSK_RECOVERY_CAPABILITY)
    : false;
}

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
  @AllowSubscriptionRecovery("kiosk")
  async attestOrder(
    @Req() req: RequestWithKiosk,
    @Body(new ZodValidationPipe(createOrderAdmissionSchema)) body: CreateOrderAdmissionDto,
  ): Promise<CreateOrderAdmissionResultDto> {
    return this.pickupOrdersService.attestKioskOrder(req.tenantId!, req.kioskId!, body);
  }

  @Post("orders")
  @AllowSubscriptionRecovery("kiosk")
  @ApiHeader({
    name: "x-kiosk-capabilities",
    required: false,
    description:
      "Comma-separated client capabilities. subscription-recovery-v1 opts into coded 403 recovery verdicts.",
  })
  async createOrder(
    @Req() req: RequestWithKiosk,
    @Headers("x-kiosk-capabilities") capabilities: string | undefined,
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderDto,
  ): Promise<CreateOrderResultDto> {
    try {
      return await this.pickupOrdersService.createFromKiosk(req.tenantId!, req.kioskId!, body);
    } catch (error) {
      if (
        error instanceof SubscriptionReadOnlyException &&
        !hasKioskRecoveryCapability(capabilities)
      ) {
        // Pre-Task-8 kiosks only quarantine 400/409/422. Returning the new
        // coded 403 to one of them would leave this immutable record at the
        // head of its queue forever. The capable client opts into the exact
        // 403 so it can distinguish subscription expiry from an ordinary,
        // retryable authorization failure; legacy clients receive a status
        // already terminal in their frozen worker while the body stays stable.
        throw new UnprocessableEntityException({ code: "subscription_read_only" });
      }
      throw error;
    }
  }
}
