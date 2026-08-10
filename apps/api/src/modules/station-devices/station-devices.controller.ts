import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
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
import {
  createStationDeviceSchema,
  updateStationDeviceSchema,
  type CreateStationDeviceDto,
  type ListStationDevicesResponseDto,
  type StationDeviceDto,
  type UpdateStationDeviceDto,
} from "./dto";
import { StationDevicesService } from "./station-devices.service";
import { type IssueStationPairingCodeResultDto } from "../station-pairing/dto";
import { StationPairingService } from "../station-pairing/station-pairing.service";
import { ApiPairingCodeSecretResponse } from "../device-pairing/secret-response.openapi";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";

@ApiTags("station-devices")
@Controller("station-devices")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
export class StationDevicesController {
  constructor(
    private readonly service: StationDevicesService,
    private readonly pairing: StationPairingService,
    private readonly audit: SecurityAuditService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithTenant): Promise<ListStationDevicesResponseDto> {
    return this.service.list(req.tenantId!);
  }

  @Post()
  @RequireSubscriptionWrite()
  async create(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createStationDeviceSchema)) body: CreateStationDeviceDto,
  ): Promise<StationDeviceDto> {
    try {
      const result = await this.service.create(req.tenantId!, body);
      this.auditMutation(req, "station_device.create", result.id, "succeeded");
      return result;
    } catch (error) {
      this.auditMutation(req, "station_device.create", null, "failed");
      throw error;
    }
  }

  @Patch(":id")
  @RequireSubscriptionWrite()
  async update(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateStationDeviceSchema)) body: UpdateStationDeviceDto,
  ): Promise<StationDeviceDto> {
    try {
      const result = await this.service.update(req.tenantId!, id, body);
      this.auditMutation(req, "station_device.update", result.id, "succeeded");
      return result;
    } catch (error) {
      this.auditMutation(req, "station_device.update", id, "failed");
      throw error;
    }
  }

  @Delete(":id")
  @HttpCode(204)
  @AllowSubscriptionReadOnly("security")
  async revoke(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    try {
      await this.service.revoke(req.tenantId!, id);
    } catch (error) {
      this.auditMutation(req, "station_device.revoke", id, "failed");
      throw error;
    }
    this.auditMutation(req, "station_device.revoke", id, "succeeded");
  }

  @Post(":id/pairing-code")
  @RequireSubscriptionWrite()
  @Header("Cache-Control", "no-store")
  @ApiPairingCodeSecretResponse()
  async issuePairingCode(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<IssueStationPairingCodeResultDto> {
    try {
      const result = await this.pairing.issueCode(req.tenantId!, id, req.userId!);
      this.auditMutation(req, "station_pairing_code.issue", id, "succeeded");
      return result;
    } catch (error) {
      this.auditMutation(req, "station_pairing_code.issue", id, "failed");
      throw error;
    }
  }

  private auditMutation(
    req: RequestWithTenant,
    action:
      | "station_device.create"
      | "station_device.update"
      | "station_device.revoke"
      | "station_pairing_code.issue",
    resourceId: string | null,
    outcome: "succeeded" | "failed",
  ): void {
    try {
      this.audit.credentialMutation({
        tenantId: req.tenantId!,
        userId: req.userId!,
        action,
        resourceId,
        outcome,
      });
    } catch {
      // Audit is best-effort. A logging sink failure must never replace the
      // cabinet mutation's original result or transient infrastructure error.
    }
  }
}
