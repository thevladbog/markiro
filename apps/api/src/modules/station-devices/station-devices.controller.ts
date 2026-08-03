import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { SecurityAuditService } from "../../authorization/security-audit.service";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { loadEnv } from "../../env";
import {
  createStationDeviceSchema,
  type CreateStationDeviceDto,
  type EnrollStationDeviceResponseDto,
  type ListStationDevicesResponseDto,
} from "./dto";
import { StationDevicesService } from "./station-devices.service";

@ApiTags("station-devices")
@Controller("station-devices")
// Device management (list/revoke/mint station keys) is an admin action:
// TenantGuard alone would also accept a station's own x-api-key (needed for
// other station-facing endpoints), so the cabinet authorization guard ensures only a
// logged-in user (never a station) can reach these routes.
@UseGuards(TenantGuard, AuthorizationGuard)
@RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
export class StationDevicesController {
  constructor(
    private readonly service: StationDevicesService,
    private readonly audit: SecurityAuditService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithTenant): Promise<ListStationDevicesResponseDto> {
    return this.service.list(req.tenantId!);
  }

  @Post()
  async enroll(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createStationDeviceSchema)) body: CreateStationDeviceDto,
  ): Promise<EnrollStationDeviceResponseDto> {
    // The station will call back at this same origin; BETTER_AUTH_URL is the
    // canonical public API base handed to the device to persist as serverUrl.
    // req.userId (the enrolling member) owns the minted org-scoped key.
    const result = await this.service.enroll(
      req.tenantId!,
      req.userId!,
      body.name,
      loadEnv().BETTER_AUTH_URL,
    );
    this.audit.credentialMutation({
      tenantId: req.tenantId!,
      userId: req.userId!,
      action: "station_device.enroll",
      resourceId: result.deviceId,
      outcome: "succeeded",
    });
    return result;
  }

  @Delete(":id")
  @HttpCode(204)
  async revoke(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    await this.service.revoke(req.tenantId!, id);
    this.audit.credentialMutation({
      tenantId: req.tenantId!,
      userId: req.userId!,
      action: "station_device.revoke",
      resourceId: id,
      outcome: "succeeded",
    });
  }
}
