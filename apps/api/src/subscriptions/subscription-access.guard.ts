import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { EntitlementsService, SUBSCRIPTION_ENFORCEMENT_MODE } from "./entitlements.service";
import type { SubscriptionEnforcementMode } from "./entitlements.types";
import {
  ROUTE_SUBSCRIPTION_ACCESS_POLICY,
  type SubscriptionAccessPolicy,
} from "./subscription-access-policy";
import {
  SubscriptionFeatureDisabledException,
  SubscriptionReadOnlyException,
  SubscriptionUnmanagedException,
} from "./subscription-errors";

interface RequestWithSubscriptionTenant extends Request {
  tenantId?: string;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class SubscriptionAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementsService,
    @Inject(SUBSCRIPTION_ENFORCEMENT_MODE)
    private readonly enforcementMode: SubscriptionEnforcementMode,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithSubscriptionTenant>();
    const policy = this.reflector.getAllAndOverride<SubscriptionAccessPolicy>(
      ROUTE_SUBSCRIPTION_ACCESS_POLICY,
      [context.getHandler(), context.getClass()],
    );

    if (!policy) {
      if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
      throw new ForbiddenException({ code: "subscription_policy_missing" });
    }
    if (!request.tenantId) throw new ForbiddenException({ code: "subscription_policy_missing" });

    const resolved = await this.entitlements.resolve(request.tenantId, undefined, new Date());
    if (resolved.access === "unmanaged") {
      if (this.enforcementMode === "all") throw new SubscriptionUnmanagedException();
      return true;
    }
    if (policy.mode === "recovery" || policy.mode === "read_only_allowed") return true;
    if (resolved.access === "read_only") throw new SubscriptionReadOnlyException();
    if (policy.mode === "feature" && !resolved.features[policy.entitlement]) {
      throw new SubscriptionFeatureDisabledException(policy.entitlement);
    }
    return true;
  }
}
