import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { hasCabinetCapabilities, type CabinetCapability } from "@markiro/domain";
import type { RequestWithTenant } from "../tenancy/tenant.guard";
import { ROUTE_ACCESS_POLICY, type RouteAccessPolicy } from "./access-policy";
import { AuthorizationService } from "./authorization.service";
import { SecurityAuditService } from "./security-audit.service";

@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
    private readonly audit: SecurityAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithTenant>();
    const policy = this.reflector.getAllAndOverride<RouteAccessPolicy>(ROUTE_ACCESS_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const action = `${context.getClass().name}.${context.getHandler().name}`;
    if (!policy) return this.deny(request, action, "missing_policy");

    if (request.authKind === "station") {
      if (policy.mode === "station-or-cabinet") return true;
      return this.deny(request, action, "session_required");
    }

    if (request.authKind !== "session" || !request.userId || !request.tenantId) {
      return this.deny(request, action, "session_required");
    }

    const principal = await this.authorization.resolvePrincipal(request.userId, request.tenantId);
    if (!principal) return this.deny(request, action, "membership_missing");
    request.cabinetPrincipal = principal;

    if (policy.mode === "membership") return true;
    if (hasCabinetCapabilities(principal.capabilities, policy.capabilities)) return true;
    return this.deny(request, action, "insufficient_permission", policy.capabilities);
  }

  private deny(
    request: RequestWithTenant,
    action: string,
    reason: string,
    required: readonly CabinetCapability[] = [],
  ): never {
    this.audit.authorizationDenied({
      tenantId: request.tenantId ?? null,
      userId: request.userId ?? null,
      action,
      reason,
      required,
      outcome: "denied",
    });
    throw new ForbiddenException("Insufficient cabinet permissions");
  }
}
