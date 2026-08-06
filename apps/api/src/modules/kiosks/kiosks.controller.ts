import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { SecurityAuditService } from "../../authorization/security-audit.service";
import { PairingService } from "../kiosk/pairing.service";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createKioskSchema,
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
import { KiosksService } from "./kiosks.service";

// Cabinet-only: the kiosk device talks to /kiosk/* behind KioskDeviceGuard and
// never needs this module, so no device key — station or kiosk — should reach
// it (see docs/device-key-surface.md).
@ApiTags("kiosks")
@Controller("kiosks")
@UseGuards(TenantGuard, AuthorizationGuard)
export class KiosksController {
  constructor(
    private readonly kiosksService: KiosksService,
    private readonly pairingService: PairingService,
    private readonly audit: SecurityAuditService,
  ) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async listKiosks(@Req() req: RequestWithTenant): Promise<ListKiosksResponseDto> {
    return this.kiosksService.listKiosks(req.tenantId!);
  }

  @Post()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async createKiosk(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createKioskSchema)) body: CreateKioskDto,
  ): Promise<KioskDto> {
    return this.kiosksService.createKiosk(req.tenantId!, body);
  }

  @Patch(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async updateKiosk(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateKioskSchema)) body: UpdateKioskDto,
  ): Promise<KioskDto> {
    return this.kiosksService.updateKiosk(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
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
  @RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
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
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async setProducts(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(setKioskProductsSchema)) body: SetKioskProductsDto,
  ): Promise<KioskDto> {
    return this.kiosksService.setProducts(req.tenantId!, id, body);
  }

  @Post(":id/enroll")
  @HttpCode(200)
  @RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
  async enroll(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<EnrollKioskResponseDto> {
    const result = await this.kiosksService.enroll(req.tenantId!, id);
    this.audit.credentialMutation({
      tenantId: req.tenantId!,
      userId: req.userId!,
      action: "kiosk.enroll",
      resourceId: id,
      outcome: "succeeded",
    });
    return result;
  }

  /** Credential-only: a stolen device must not be able to mint pairing codes. */
  @Post(":id/pairing-code")
  @RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
  async issuePairingCode(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
  ): Promise<IssuePairingCodeResultDto> {
    const result = await this.pairingService.issueCode(req.tenantId!, id);
    this.audit.credentialMutation({
      tenantId: req.tenantId!,
      userId: req.userId!,
      action: "kiosk_pairing_code.issue",
      resourceId: id,
      outcome: "succeeded",
    });
    return result;
  }

  private auditMutation(
    req: RequestWithTenant,
    action: "kiosk.archive" | "kiosk.unbind",
    resourceId: string,
    outcome: "succeeded" | "failed",
  ): void {
    this.audit.credentialMutation({
      tenantId: req.tenantId!,
      userId: req.userId!,
      action,
      resourceId,
      outcome,
    });
  }
}
