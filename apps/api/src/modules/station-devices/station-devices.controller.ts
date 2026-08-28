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
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodValidationError,
} from "../../lib/openapi";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { SecurityAuditService } from "../../authorization/security-audit.service";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createStationDeviceSchema,
  listStationDevicesOpenApiSchema,
  stationDeviceOpenApiSchema,
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
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
@ApiCabinetAuth()
export class StationDevicesController {
  constructor(
    private readonly service: StationDevicesService,
    private readonly pairing: StationPairingService,
    private readonly audit: SecurityAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List station devices" })
  @ApiOkResponse({ schema: listStationDevicesOpenApiSchema })
  @ApiHttpErrors(401, 403)
  async list(@Req() req: RequestWithTenant): Promise<ListStationDevicesResponseDto> {
    return this.service.list(req.tenantId!);
  }

  @Post()
  @RequireSubscriptionWrite()
  @ApiOperation({
    summary: "Register a station device",
    description: "Creates the device without a credential; pairing issues one later.",
  })
  @ApiZodBody(createStationDeviceSchema)
  @ApiCreatedResponse({ schema: stationDeviceOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
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
  @ApiOperation({ summary: "Update a station device" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiZodBody(updateStationDeviceSchema)
  @ApiOkResponse({ schema: stationDeviceOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
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
  @ApiOperation({ summary: "Revoke a station device" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiResponse({ status: 204, description: "The device and its credential were revoked." })
  @ApiHttpErrors(401, 403, 404)
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
  @ApiOperation({
    summary: "Issue a station pairing code",
    description: "Mints a single-use code and retires any code still live for this device.",
  })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiPairingCodeSecretResponse()
  @ApiHttpErrors(401, 403, 404)
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
