import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  StreamableFile,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiOkResponse,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
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
import { OrgProfileService } from "../org-profile/org-profile.service";
import {
  BOX_REGISTRY_REVISION_PATTERN,
  boxRegistryQuerySchema,
  type BoxRegistryQueryDto,
  type KioskBoxRegistryPage,
} from "./box-registry.dto";
import { BoxRegistryService } from "./box-registry.service";

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
  constructor(
    private readonly pickupOrdersService: PickupOrdersService,
    private readonly orgProfileService: OrgProfileService,
    private readonly boxRegistryService: BoxRegistryService,
  ) {}

  @Get("bootstrap")
  async bootstrap(@Req() req: RequestWithKiosk): Promise<KioskBootstrapDto> {
    return this.pickupOrdersService.bootstrap(req.tenantId!, req.kioskId!);
  }

  @Get("box-registry")
  @ApiQuery({
    name: "since",
    required: false,
    schema: { type: "string", pattern: BOX_REGISTRY_REVISION_PATTERN },
    description: "Exclusive tenant registry revision. Omit for a full snapshot.",
  })
  @ApiQuery({
    name: "until",
    required: false,
    schema: { type: "string", pattern: BOX_REGISTRY_REVISION_PATTERN },
    description: "Server-assigned inclusive revision; required unchanged with cursor pages.",
  })
  @ApiQuery({
    name: "cursor",
    required: false,
    schema: { type: "string", maxLength: 1024 },
    description: "Opaque versioned cursor bound to since and until revisions.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 500, default: 250 },
    description: "Maximum candidate boxes considered before the member-key budget.",
  })
  @ApiOkResponse({
    description: "A stable committed box-registry revision page.",
    schema: {
      type: "object",
      required: ["until", "items"],
      properties: {
        until: { type: "string", pattern: BOX_REGISTRY_REVISION_PATTERN },
        nextCursor: { type: "string" },
        items: {
          type: "array",
          items: {
            oneOf: [
              {
                type: "object",
                required: [
                  "kind",
                  "boxId",
                  "sscc",
                  "productId",
                  "bottleCount",
                  "contentKeys",
                  "updatedAt",
                ],
                properties: {
                  kind: { type: "string", enum: ["upsert"] },
                  boxId: { type: "string", format: "uuid" },
                  sscc: { type: "string", pattern: "^[0-9]{18}$" },
                  productId: { type: "string", format: "uuid" },
                  bottleCount: { type: "integer", minimum: 1, maximum: 500 },
                  contentKeys: {
                    type: "array",
                    maxItems: 500,
                    items: { type: "string" },
                  },
                  updatedAt: { type: "string", format: "date-time" },
                },
              },
              {
                type: "object",
                required: ["kind", "sscc", "updatedAt"],
                properties: {
                  kind: { type: "string", enum: ["remove"] },
                  sscc: { type: "string", pattern: "^[0-9]{18}$" },
                  updatedAt: { type: "string", format: "date-time" },
                },
              },
            ],
          },
        },
      },
    },
  })
  @ApiBadRequestResponse({ description: "Malformed bounds, cursor, or page size." })
  @ApiConflictResponse({
    description: "The tenant registry changed while this snapshot was being paged; restart it.",
    schema: {
      type: "object",
      required: ["code"],
      properties: { code: { type: "string", enum: ["registry_snapshot_changed"] } },
    },
  })
  @ApiUnauthorizedResponse({ description: "Missing, unknown, revoked, or archived kiosk token." })
  async boxRegistry(
    @Req() req: RequestWithKiosk,
    @Query(new ZodValidationPipe(boxRegistryQuerySchema)) query: BoxRegistryQueryDto,
  ): Promise<KioskBoxRegistryPage> {
    return this.boxRegistryService.list(req.tenantId!, query);
  }

  @Get("branding/logo/:revision")
  async logo(
    @Req() req: RequestWithKiosk,
    @Param("revision", new ParseUUIDPipe()) revision: string,
  ): Promise<StreamableFile> {
    const logo = await this.orgProfileService.getKioskLogo(req.tenantId!, revision);
    return new StreamableFile(logo.body, {
      type: logo.contentType,
      disposition: "inline",
      length: logo.body.byteLength,
    });
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
