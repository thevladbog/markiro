import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { SecurityAuditService } from "../../authorization/security-audit.service";
import { ApiCabinetAuth, ApiHttpErrors } from "../../lib/openapi";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { ApiPairingCodeSecretResponse } from "../device-pairing/secret-response.openapi";
import {
  signerAgentsOverviewOpenApiSchema,
  type IssueSignerPairingCodeResultDto,
  type RequestSignerTokenRefreshResultDto,
  type SignerAgentsOverviewDto,
} from "./dto";
import { SignerAgentsService } from "./signer-agents.service";

/** Credential-only cabinet routes for the Chestny ZNAK signer agent. */
@ApiTags("signer-agents")
@Controller("signer-agents")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@ApiCabinetAuth()
export class SignerAgentsController {
  constructor(
    private readonly service: SignerAgentsService,
    private readonly audit: SecurityAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List signer agents and the tenant's True API token status" })
  @ApiOkResponse({ schema: signerAgentsOverviewOpenApiSchema })
  @ApiHttpErrors(401, 403)
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_READ)
  async overview(@Req() req: RequestWithTenant): Promise<SignerAgentsOverviewDto> {
    return this.service.overview(req.tenantId!);
  }

  @Post("pairing-code")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Issue a signer agent pairing code",
    description:
      "Single-use 8-digit code for POST /signer-agent/pair, revealed exactly once. Issuing a new code retires any code still live for the tenant.",
  })
  @ApiPairingCodeSecretResponse()
  @ApiHttpErrors(401, 403)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_WRITE, CABINET_CAPABILITY.CREDENTIALS_MANAGE)
  async issuePairingCode(@Req() req: RequestWithTenant): Promise<IssueSignerPairingCodeResultDto> {
    const result = await this.service.issuePairingCode(req.tenantId!, req.userId!);
    this.auditMutation(req, "chz_signer_pairing_code.issue", null, "succeeded");
    return result;
  }

  @Post("token-refresh")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: "Request an immediate True API token refresh" })
  @ApiResponse({
    status: 202,
    description: "A refresh task was queued or was already pending.",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["status", "taskId"],
      properties: {
        status: { type: "string", enum: ["queued", "already_pending"] },
        taskId: { type: "string", format: "uuid" },
      },
    },
  })
  @ApiHttpErrors(401, 403, 409, 503)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_WRITE, CABINET_CAPABILITY.CREDENTIALS_MANAGE)
  async requestTokenRefresh(
    @Req() req: RequestWithTenant,
  ): Promise<RequestSignerTokenRefreshResultDto> {
    try {
      const result = await this.service.requestTokenRefresh(req.tenantId!);
      this.auditMutation(req, "chz_signer_token.refresh", null, "succeeded");
      return result;
    } catch (error) {
      this.auditMutation(req, "chz_signer_token.refresh", null, "failed");
      throw error;
    }
  }

  @Post(":id/revoke")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Revoke a signer agent" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiResponse({ status: 204, description: "The signer agent was revoked." })
  @ApiHttpErrors(400, 401, 403, 404)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_WRITE, CABINET_CAPABILITY.CREDENTIALS_MANAGE)
  async revoke(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    try {
      await this.service.revoke(req.tenantId!, id);
    } catch (error) {
      this.auditMutation(req, "chz_signer_agent.revoke", id, "failed");
      throw error;
    }
    this.auditMutation(req, "chz_signer_agent.revoke", id, "succeeded");
  }

  private auditMutation(
    req: RequestWithTenant,
    action:
      "chz_signer_pairing_code.issue" | "chz_signer_agent.revoke" | "chz_signer_token.refresh",
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
