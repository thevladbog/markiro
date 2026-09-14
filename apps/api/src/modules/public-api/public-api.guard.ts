import {
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PUBLIC_API_SCOPES, type PublicApiScope } from "@markiro/platform-contracts";
import { PublicApiAuthService } from "./public-api-auth.service";
import type { RequestWithPublicApiPrincipal } from "./public-api.types";

export const PUBLIC_API_SCOPE = "markiro:public-api-scope";
export const RequirePublicApiScope = (scope: PublicApiScope) =>
  SetMetadata(PUBLIC_API_SCOPE, scope);
@Injectable()
export class PublicApiGuard implements CanActivate {
  constructor(
    private readonly auth: PublicApiAuthService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const scope = this.reflector.get<PublicApiScope | undefined>(
      PUBLIC_API_SCOPE,
      context.getHandler(),
    );
    if (!scope || !PUBLIC_API_SCOPES.includes(scope))
      throw new ForbiddenException("Public API route scope is undeclared");
    const req = context.switchToHttp().getRequest<RequestWithPublicApiPrincipal>();
    delete req.publicApiPrincipal;
    const key = req.headers["x-api-key"];
    if (typeof key !== "string" || !key) throw new UnauthorizedException("Public API key required");
    const principal = await this.auth.authenticate(key);
    if (!principal.scopes.includes(scope))
      throw new ForbiddenException("Public API scope required");
    req.publicApiPrincipal = principal;
    return true;
  }
}
