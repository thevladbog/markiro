import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodQuery,
  ApiZodValidationError,
} from "../../lib/openapi";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  listDevicesOpenApiSchema,
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
@ApiCabinetAuth()
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @Get()
  @ApiOperation({
    summary: "List devices",
    description:
      "Unified station and kiosk inventory, ordered by actionable lifecycle status (awaiting pairing, offline, revoked, online), then name.",
  })
  @ApiZodQuery(listDevicesQuerySchema)
  @ApiOkResponse({ schema: listDevicesOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  async listDevices(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listDevicesQuerySchema)) query: ListDevicesQueryDto,
  ): Promise<ListDevicesResponseDto> {
    return this.devicesService.list(req.tenantId!, query);
  }
}
