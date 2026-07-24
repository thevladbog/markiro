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
 * Resolves the caller's Better Auth session and requires an active
 * organization: no session -> 401, session without an active org -> 403.
 * On success, attaches `req.tenantId` for downstream handlers/repositories,
 * and `req.userId` (the Better Auth user id) for handlers that need to
 * record who performed an action (e.g. pickup order resolve).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<RequestWithTenant>();
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) throw new UnauthorizedException();

    const tenantId = session.session.activeOrganizationId;
    if (!tenantId) throw new ForbiddenException("No active organization");

    req.tenantId = tenantId;
    req.userId = session.user.id;
    return true;
  }
}
