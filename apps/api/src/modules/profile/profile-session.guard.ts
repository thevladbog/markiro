import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import type { Auth } from "@markiro/db";
import { AUTH } from "../../auth/auth.module";
import type { RequestWithTenant } from "../../tenancy/tenant.guard";

@Injectable()
export class ProfileSessionGuard implements CanActivate {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithTenant>();
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!session) throw new UnauthorizedException();
    request.userId = session.user.id;
    request.authKind = "session";
    return true;
  }
}
