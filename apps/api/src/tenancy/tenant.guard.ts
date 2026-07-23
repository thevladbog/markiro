import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import type { Auth } from "@markiro/db";
import { AUTH } from "../auth/auth.module";

/** Exported so guarded controllers can type `@Req()` without re-declaring this. */
export interface RequestWithTenant extends Request {
  tenantId?: string;
  userId?: string;
}

/**
 * Resolves the caller's tenant from either a Better Auth session (admin/manager
 * UI) or a station's org-owned `x-api-key` (kiosk device), and requires an
 * active organization: no session and no valid api-key -> 401, session
 * without an active org -> 403. On success, attaches `req.tenantId` for
 * downstream handlers/repositories.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithTenant>();

    // Primary path: an admin/manager Better Auth session with an active org.
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (session) {
      const tenantId = session.session.activeOrganizationId;
      if (!tenantId) throw new ForbiddenException("No active organization");
      req.tenantId = tenantId;
      // Enrollment (Task 6) mints an org-owned key server-side and needs the
      // acting member's id as the key's `userId`; expose it on the request.
      req.userId = session.user.id;
      return true;
    }

    // Station path: no session, but a device-enrolled api-key. The key's
    // referenceId carries the tenantId (set at enrollment, Task 6).
    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey === "string" && apiKey.length > 0) {
      // `configId` is required: the "station" apiKey configuration has no
      // "default" fallback, so verifyApiKey without it throws
      // NO_DEFAULT_API_KEY_CONFIGURATION_FOUND (see packages/db/src/auth-config.ts).
      const result = await this.auth.api.verifyApiKey({
        body: { key: apiKey, configId: "station" },
      });
      if (result.valid && result.key) {
        req.tenantId = result.key.referenceId;
        return true;
      }
    }

    throw new UnauthorizedException();
  }
}
