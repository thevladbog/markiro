import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { RequestWithTenant } from "./tenant.guard";

@Injectable()
export class StationOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithTenant>();
    if (request.authKind !== "station") {
      throw new ForbiddenException("Station device authentication required");
    }
    return true;
  }
}
