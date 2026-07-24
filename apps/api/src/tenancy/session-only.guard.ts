import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { RequestWithTenant } from "./tenant.guard";

/**
 * Restricts a route to callers authenticated via a Better Auth session
 * (admin/manager UI), rejecting the station `x-api-key` path. Must run
 * after `TenantGuard`, which is the only place that sets `req.userId`
 * (on the session branch — see tenant.guard.ts). Used for admin-only
 * actions like device management, which must never be reachable by a
 * station's own api-key even though `TenantGuard` accepts it for
 * tenant resolution.
 */
@Injectable()
export class SessionOnlyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<RequestWithTenant>();
    if (!req.userId) {
      throw new ForbiddenException("A user session is required for this action");
    }
    return true;
  }
}
