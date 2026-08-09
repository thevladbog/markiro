import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq } from "drizzle-orm";
import type { Request } from "express";
import { schema, type Db, type PlatformAuth, type PlatformRole } from "@markiro/db";
import { DB } from "../auth/auth.module";
import {
  hasPlatformCapabilities,
  PLATFORM_ACCESS_POLICY,
  platformCapabilitiesForRole,
  type PlatformAccessPolicy,
  type PlatformCapability,
  type PlatformPrincipal,
} from "./platform-access-policy";
import { PLATFORM_AUTH } from "./platform-auth.setup";
import { PlatformAuditService } from "./platform-audit.service";

export interface RequestWithPlatformPrincipal extends Request {
  authKind?: "session" | "station";
  platformPrincipal?: PlatformPrincipal;
}

@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PLATFORM_AUTH) private readonly auth: PlatformAuth,
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPlatformPrincipal>();
    const policy = this.reflector.getAllAndOverride<PlatformAccessPolicy>(PLATFORM_ACCESS_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const targetId = `${context.getClass().name}.${context.getHandler().name}`;
    const required = policy?.capabilities ?? [];
    if (!policy) {
      return this.deny(request, targetId, "missing_policy", required, null, null);
    }

    if (request.authKind === "session") {
      return this.deny(request, targetId, "customer_session", required, null, null);
    }
    if (request.authKind === "station") {
      return this.deny(request, targetId, "device_credential", required, null, null);
    }

    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) {
      await this.auditDenial(targetId, "platform_session_required", required, null, null);
      throw new UnauthorizedException();
    }

    const [user] = await this.db
      .select({
        id: schema.platformUsers.id,
        role: schema.platformUsers.role,
        status: schema.platformUsers.status,
        twoFactorEnabled: schema.platformUsers.twoFactorEnabled,
      })
      .from(schema.platformUsers)
      .where(eq(schema.platformUsers.id, session.user.id));
    if (!user) {
      return this.deny(request, targetId, "platform_user_missing", required, null, null);
    }
    if (user.status !== "active") {
      return this.deny(request, targetId, "platform_user_inactive", required, user.id, user.role);
    }

    let twoFactorReady = false;
    if (user.twoFactorEnabled) {
      const [twoFactor] = await this.db
        .select({ verified: schema.platformTwoFactors.verified })
        .from(schema.platformTwoFactors)
        .where(
          and(
            eq(schema.platformTwoFactors.userId, user.id),
            eq(schema.platformTwoFactors.verified, true),
          ),
        );
      twoFactorReady = twoFactor?.verified === true;
    }
    if (!twoFactorReady) {
      return this.deny(request, targetId, "two_factor_required", required, user.id, user.role);
    }

    const capabilities = platformCapabilitiesForRole(user.role);
    const principal: PlatformPrincipal = {
      userId: user.id,
      role: user.role,
      capabilities,
      twoFactorReady,
    };
    request.platformPrincipal = principal;
    if (hasPlatformCapabilities(capabilities, required)) return true;
    return this.deny(request, targetId, "insufficient_capability", required, user.id, user.role);
  }

  private async deny(
    _request: RequestWithPlatformPrincipal,
    targetId: string,
    reason: string,
    required: readonly PlatformCapability[],
    actorPlatformUserId: string | null,
    actorRole: PlatformRole | null,
  ): Promise<never> {
    await this.auditDenial(targetId, reason, required, actorPlatformUserId, actorRole);
    throw new ForbiddenException("Insufficient platform permissions");
  }

  private async auditDenial(
    targetId: string,
    reason: string,
    required: readonly PlatformCapability[],
    actorPlatformUserId: string | null,
    actorRole: PlatformRole | null,
  ): Promise<void> {
    await this.db.transaction((tx) =>
      this.audit.record(tx, {
        actorPlatformUserId,
        actorRole,
        action: "platform.authorization.denied",
        outcome: "denied",
        tenantId: null,
        targetType: "platform_route",
        targetId,
        reason,
        before: null,
        after: { requiredCapabilities: required },
        requestId: null,
      }),
    );
  }
}
