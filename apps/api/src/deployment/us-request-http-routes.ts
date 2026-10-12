import {
  applyDecorators,
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { ApiCookieAuth, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  usRequestArtifactKindSchema,
  usRequestListQuerySchema,
  usRequestHistoryQuerySchema,
} from "@markiro/platform-contracts";
import type { UsRequestHttpContext } from "../modules/traceability/requests/us-request-http-context";
import { usMasterDataBadRequestSchema, usMasterDataErrorSchema } from "./us-master-data-openapi";
import type { UsRequest } from "./us-profile.controller";

const root = "/traceability/requests";
const runRoot = "/traceability/export-runs";
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const item = new RegExp(`^${root}/${uuid}$`);
const command = new RegExp(`^${root}/${uuid}/(close|validate|acknowledge-warnings|prepare)$`);
const runs = new RegExp(`^${root}/${uuid}/runs$`);
const run = new RegExp(`^${runRoot}/${uuid}$`);
const attempts = new RegExp(`^${runRoot}/${uuid}/attempts$`);
const retry = new RegExp(`^${runRoot}/${uuid}/retry$`);
const artifact = new RegExp(
  `^${runRoot}/${uuid}/artifacts/(xlsx|plan_pdf|validation_report|request_report|manifest|package_zip)$`,
);

/** Decode original URL once, reject duplicate fields before the service parses raw strings. */
export function usRequestRawQuery(request: UsRequest): Record<string, string> {
  const query: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of new URL(request.originalUrl, "http://localhost").searchParams) {
    if (Object.hasOwn(query, key)) throw new BadRequestException({ code: "us_invalid_query" });
    query[key] = value;
  }
  return query;
}

export function usRequestHttpContext(request: UsRequest): UsRequestHttpContext {
  if (!request.usPrincipal || !request.usRequestId)
    throw new UnauthorizedException("us_session_required");
  return {
    tenantId: request.usPrincipal.tenantId,
    userId: request.usPrincipal.userId,
    httpRequestId: request.usRequestId,
  };
}

@Injectable()
export class UsRequestsCanonicalRouteGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<UsRequest>();
    const path = request.path;
    const valid =
      (path === root && ["GET", "POST"].includes(request.method)) ||
      (item.test(path) && ["GET", "PATCH"].includes(request.method)) ||
      (command.test(path) && request.method === "POST") ||
      ((runs.test(path) || run.test(path) || attempts.test(path) || artifact.test(path)) &&
        request.method === "GET") ||
      (retry.test(path) && request.method === "POST");
    if (!valid) throw new NotFoundException();
    const query = usRequestRawQuery(request);
    const contract =
      path === root && request.method === "GET"
        ? usRequestListQuerySchema
        : runs.test(path) || attempts.test(path)
          ? usRequestHistoryQuerySchema
          : null;
    if (contract ? !contract.safeParse(query).success : Object.keys(query).length > 0)
      throw new BadRequestException({ code: "us_invalid_query" });
    if (artifact.test(path) && request.headers.range !== undefined)
      throw new BadRequestException({ code: "us_request_range_unsupported" });
    return true;
  }
}

export function ApiUsRequestBoundary(): ClassDecorator {
  return applyDecorators(
    ApiTags("us-requests"),
    ApiCookieAuth("markiro-us.session_token"),
    ApiResponse({
      status: 400,
      description: "Invalid strict input, duplicate/unknown query, or Range request.",
      schema: { oneOf: [usMasterDataBadRequestSchema, usMasterDataErrorSchema] },
    }),
    ApiResponse({
      status: 401,
      description: "Verified US session required.",
      schema: usMasterDataErrorSchema,
    }),
    ApiResponse({
      status: 403,
      description: "Current capability, MFA, processor profile and trusted host/origin required.",
      schema: usMasterDataErrorSchema,
    }),
    ApiResponse({
      status: 404,
      description: "Canonical route or tenant record not found.",
      schema: usMasterDataErrorSchema,
    }),
    ApiResponse({
      status: 409,
      description: "Revision, digest, lifecycle or idempotency conflict.",
      schema: usMasterDataErrorSchema,
    }),
    ApiResponse({
      status: 413,
      description: "Body exceeds the route's uncompressed limit.",
      schema: usMasterDataErrorSchema,
    }),
    ApiResponse({
      status: 415,
      description: "Uncompressed JSON required for commands.",
      schema: usMasterDataErrorSchema,
    }),
    ApiResponse({
      status: 503,
      description: "Checked build, private storage, evidence or database unavailable.",
      schema: usMasterDataErrorSchema,
    }),
  );
}

export const usRequestArtifactKinds = usRequestArtifactKindSchema.options;
