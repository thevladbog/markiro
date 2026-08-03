import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import type { CabinetCapability, CabinetRole } from "@markiro/domain";
import { TenantGuard, type RequestWithTenant } from "../tenancy/tenant.guard";
import { RequireMembership } from "./access-policy";
import { AuthorizationGuard } from "./authorization.guard";

export interface AccessDocumentDto {
  roles: CabinetRole[];
  capabilities: CabinetCapability[];
}

@Controller("access")
@UseGuards(TenantGuard, AuthorizationGuard)
export class AccessController {
  @Get("me")
  @RequireMembership()
  me(@Req() request: RequestWithTenant): AccessDocumentDto {
    const principal = request.cabinetPrincipal!;
    return { roles: principal.roles, capabilities: principal.capabilities };
  }
}
