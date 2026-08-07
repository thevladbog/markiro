import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  listDevicesQuerySchema,
  type ListDevicesQueryDto,
  type ListDevicesResponseDto,
} from "./dto";
import { DevicesService } from "./devices.service";

/** Cabinet-only operational inventory; floor keys must never enumerate peer devices. */
@ApiTags("devices")
@Controller("devices")
@UseGuards(TenantGuard, AuthorizationGuard)
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @Get()
  async listDevices(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listDevicesQuerySchema)) query: ListDevicesQueryDto,
  ): Promise<ListDevicesResponseDto> {
    return this.devicesService.list(req.tenantId!, query);
  }
}
