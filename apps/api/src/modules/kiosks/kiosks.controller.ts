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
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { SecurityAuditService } from "../../authorization/security-audit.service";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodValidationError,
} from "../../lib/openapi";
import { PairingService } from "../kiosk/pairing.service";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createKioskSchema,
  kioskOpenApiSchema,
  listKiosksOpenApiSchema,
  setKioskProductsSchema,
  updateKioskSchema,
  type CreateKioskDto,
  type EnrollKioskResponseDto,
  type IssuePairingCodeResultDto,
  type KioskDto,
  type ListKiosksResponseDto,
  type SetKioskProductsDto,
  type UpdateKioskDto,
} from "./dto";
import { KiosksService, type KioskUpdateAuditAction } from "./kiosks.service";
import {
  ApiLegacyKioskEnrollSecretResponse,
  ApiPairingCodeSecretResponse,
} from "../device-pairing/secret-response.openapi";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";

// Cabinet-only: the kiosk device talks to /kiosk/* behind KioskDeviceGuard and
// never needs this module, so no device key — station or kiosk — should reach
// it (see docs/device-key-surface.md).
@ApiTags("kiosks")
@ApiCabinetAuth()
@Controller("kiosks")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class KiosksController {
  constructor(
    private readonly kiosksService: KiosksService,
    private readonly pairingService: PairingService,
    private readonly audit: SecurityAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List kiosks" })
  @ApiResponse({ status: 200, schema: listKiosksOpenApiSchema })
  @ApiHttpErrors(401, 403)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async listKiosks(@Req() req: RequestWithTenant): Promise<ListKiosksResponseDto> {
    return this.kiosksService.listKiosks(req.tenantId!);
  }

  @Post()
  @ApiOperation({ summary: "Create a kiosk" })
  @ApiZodBody(createKioskSchema)
  @ApiResponse({ status: 201, schema: kioskOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 409)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  async createKiosk(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createKioskSchema)) body: CreateKioskDto,
  ): Promise<KioskDto> {
    try {
      const result = await this.kiosksService.createKiosk(req.tenantId!, body);
      this.auditMutation(req, "kiosk.create", result.id, "succeeded");
      return result;
    } catch (error) {
      this.auditMutation(req, "kiosk.create", null, "failed");
      throw error;
    }
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Update a kiosk",
    description:
      "`status` archives or reactivates the kiosk; a real status transition also revokes the device credential and retires live pairing codes.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(updateKioskSchema)
  @ApiResponse({ status: 200, schema: kioskOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404, 409)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  async updateKiosk(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateKioskSchema)) body: UpdateKioskDto,
  ): Promise<KioskDto> {
    const attemptedAction: KioskUpdateAuditAction =
      body.status === "archived"
        ? "kiosk.archive"
        : body.status === "active"
          ? "kiosk.unbind"
          : "kiosk.update";
    try {
      const result = await this.kiosksService.updateKiosk(req.tenantId!, id, body);
      this.auditMutation(req, result.auditAction, id, "succeeded");
      return result.kiosk;
    } catch (error) {
      this.auditMutation(req, attemptedAction, id, "failed");
      throw error;
    }
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({
    summary: "Archive a kiosk",
    description: "Also revokes the device credential and retires live pairing codes.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 204, description: "The kiosk was archived." })
  @ApiHttpErrors(401, 403, 404)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @AllowSubscriptionReadOnly("security")
  async archiveKiosk(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    try {
      await this.kiosksService.archiveKiosk(req.tenantId!, id);
    } catch (error) {
      this.auditMutation(req, "kiosk.archive", id, "failed");
      throw error;
    }
    this.auditMutation(req, "kiosk.archive", id, "succeeded");
  }

  /** Explicitly remove the active device credential while retaining the kiosk record. */
  @Post(":id/unbind")
  @HttpCode(204)
  @ApiOperation({
    summary: "Unbind the kiosk device credential",
    description:
      "Removes the active device credential while retaining the kiosk record and its pickup history. On an archived kiosk this is the explicit reactivate-and-unbind recovery path.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 204, description: "The device credential was removed." })
  @ApiHttpErrors(401, 403, 404, 409)
  @RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
  @AllowSubscriptionReadOnly("security")
  async unbindKiosk(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    try {
      await this.kiosksService.unbindKiosk(req.tenantId!, id);
    } catch (error) {
      this.auditMutation(req, "kiosk.unbind", id, "failed");
      throw error;
    }
    this.auditMutation(req, "kiosk.unbind", id, "succeeded");
  }

  @Put(":id/products")
  @HttpCode(200)
  @ApiOperation({ summary: "Set the kiosk product allowlist" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiZodBody(setKioskProductsSchema)
  @ApiResponse({ status: 200, schema: kioskOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403, 404)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  async setProducts(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(setKioskProductsSchema)) body: SetKioskProductsDto,
  ): Promise<KioskDto> {
    return this.kiosksService.setProducts(req.tenantId!, id, body);
  }

  @Post(":id/enroll")
  @HttpCode(200)
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Issue a legacy kiosk enrollment token",
    description: "One-time token reveal; replaces any previously issued device credential.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiLegacyKioskEnrollSecretResponse()
  @ApiHttpErrors(401, 403, 404)
  @RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
  @RequireSubscriptionWrite()
  async enroll(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<EnrollKioskResponseDto> {
    try {
      const result = await this.kiosksService.enroll(req.tenantId!, id);
      this.auditMutation(req, "kiosk.enroll", id, "succeeded");
      return result;
    } catch (error) {
      this.auditMutation(req, "kiosk.enroll", id, "failed");
      throw error;
    }
  }

  /** Credential-only: a stolen device must not be able to mint pairing codes. */
  @Post(":id/pairing-code")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Issue a kiosk pairing code",
    description:
      "Single-use 8-digit code for POST /kiosk/pair, revealed exactly once. Issuing a new code retires any code still live for the kiosk.",
  })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiPairingCodeSecretResponse()
  @ApiHttpErrors(401, 403, 404)
  @RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
  @RequireSubscriptionWrite()
  async issuePairingCode(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<IssuePairingCodeResultDto> {
    try {
      const result = await this.pairingService.issueCode(req.tenantId!, id);
      this.auditMutation(req, "kiosk_pairing_code.issue", id, "succeeded");
      return result;
    } catch (error) {
      this.auditMutation(req, "kiosk_pairing_code.issue", id, "failed");
      throw error;
    }
  }

  private auditMutation(
    req: RequestWithTenant,
    action:
      | "kiosk.create"
      | "kiosk.update"
      | "kiosk.archive"
      | "kiosk.unbind"
      | "kiosk.enroll"
      | "kiosk_pairing_code.issue",
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
