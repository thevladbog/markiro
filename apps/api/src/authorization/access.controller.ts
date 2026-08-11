import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import type { CabinetCapability, CabinetRole } from "@markiro/domain";
import { TenantGuard, type RequestWithTenant } from "../tenancy/tenant.guard";
import { RequireMembership } from "./access-policy";
import { AuthorizationGuard } from "./authorization.guard";
import { AuthorizationService, type AccessDocumentSubscription } from "./authorization.service";

export interface AccessDocumentDto {
  roles: CabinetRole[];
  capabilities: CabinetCapability[];
  subscription: AccessDocumentSubscription["subscription"];
  scheduled: AccessDocumentSubscription["scheduled"];
  usage: AccessDocumentSubscription["usage"];
  quotas: AccessDocumentSubscription["quotas"];
  features: AccessDocumentSubscription["features"];
}

@Controller("access")
@UseGuards(TenantGuard, AuthorizationGuard)
export class AccessController {
  constructor(private readonly authorization: AuthorizationService) {}

  @Get("me")
  @RequireMembership()
  async me(@Req() request: RequestWithTenant): Promise<AccessDocumentDto> {
    const principal = request.cabinetPrincipal!;
    return {
      roles: principal.roles,
      capabilities: principal.capabilities,
      ...(await this.authorization.resolveSubscriptionDocument(principal.tenantId)),
    };
  }
}
