import {
  applyDecorators,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import type { Request } from "express";
import { requirePublisherProduct, type GithubPublisherPrincipal } from "./catalog-oidc";
import { CatalogFault } from "./catalog-types";
export const CATALOG_PUBLISHER_POLICY = Symbol("CATALOG_PUBLISHER_POLICY");
export const CATALOG_PUBLISHER_VERIFY = Symbol("CATALOG_PUBLISHER_VERIFY");
export type VerifyPublisher = (token: string) => Promise<GithubPublisherPrincipal>;
export interface RequestWithPublisher extends Request {
  catalogPublisher?: GithubPublisherPrincipal;
}
/** Classification requires both explicit machine intent and the exact authentication guard. */
export function isCatalogPublisherRoute(controller: object, handler: object): boolean {
  const policy: unknown =
    Reflect.getMetadata(CATALOG_PUBLISHER_POLICY, handler) ??
    Reflect.getMetadata(CATALOG_PUBLISHER_POLICY, controller);
  const classGuards: unknown = Reflect.getMetadata(GUARDS_METADATA, controller) ?? [],
    methodGuards: unknown = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
  if (policy !== true || !Array.isArray(classGuards) || !Array.isArray(methodGuards)) return false;
  return (
    classGuards.length + methodGuards.length === 1 &&
    (classGuards[0] === CatalogPublisherGuard || methodGuards[0] === CatalogPublisherGuard)
  );
}
@Injectable()
export class CatalogPublisherGuard implements CanActivate {
  constructor(@Inject(CATALOG_PUBLISHER_VERIFY) private readonly verify: VerifyPublisher) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!isCatalogPublisherRoute(context.getClass(), context.getHandler()))
      throw new ForbiddenException({ code: "publisher_policy_missing" });
    const request = context.switchToHttp().getRequest<RequestWithPublisher>();
    const authorization = request.headers.authorization;
    if (
      typeof authorization !== "string" ||
      !/^Bearer [A-Za-z0-9._-]+$/.test(authorization) ||
      request.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === "authorization")
        .length !== 1
    )
      throw new ForbiddenException({ code: "publisher_forbidden" });
    try {
      const principal = await this.verify(authorization.slice(7));
      if (request.params.product !== undefined)
        requirePublisherProduct(principal, request.params.product);
      else if (principal.expiresAt <= Date.now()) throw new CatalogFault("forbidden");
      Object.defineProperty(request, "catalogPublisher", {
        value: principal,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      return true;
    } catch (error) {
      if (
        error instanceof CatalogFault &&
        (error.code === "unavailable" || error.code === "not_ready")
      )
        throw new ServiceUnavailableException({ code: "publisher_unavailable" });
      throw new ForbiddenException({ code: "publisher_forbidden" });
    }
  }
}
export const CatalogPublisherRoute = () =>
  applyDecorators(SetMetadata(CATALOG_PUBLISHER_POLICY, true), UseGuards(CatalogPublisherGuard));
