import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  listPickupRejectionsQuerySchema,
  type ListPickupRejectionsQueryDto,
  type ListPickupRejectionsResponseDto,
  type PickupScanRejectionRowDto,
} from "./dto";
import { PickupRejectionsService } from "./pickup-rejections.service";

// Cabinet-only: the kiosk device talks to /kiosk/* behind KioskDeviceGuard and
// never needs this module, so no device key — station or kiosk — should reach
// it (see docs/device-key-surface.md).
@ApiTags("pickup-rejections")
@Controller("pickup-rejections")
@UseGuards(TenantGuard, AuthorizationGuard)
export class PickupRejectionsController {
  constructor(private readonly pickupRejectionsService: PickupRejectionsService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async list(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listPickupRejectionsQuerySchema))
    query: ListPickupRejectionsQueryDto,
  ): Promise<ListPickupRejectionsResponseDto> {
    return this.pickupRejectionsService.list(req.tenantId!, query);
  }

  @Post(":id/acknowledge")
  @HttpCode(200)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async acknowledge(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<PickupScanRejectionRowDto> {
    return this.pickupRejectionsService.acknowledge(req.tenantId!, id, req.userId!);
  }
}
