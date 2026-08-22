import { applyDecorators } from "@nestjs/common";
import {
  ApiBody,
  ApiResponse,
  ApiSecurity,
  type DocumentBuilder,
  type SchemaObject,
} from "@nestjs/swagger";
import { platformErrorSchema } from "@markiro/platform-contracts";
import { z, type ZodType } from "zod";

export const PLATFORM_SESSION_SECURITY = "platformSession";

const PROTECTED_ERROR_STATUSES = [400, 401, 403, 404, 409, 422, 429, 500] as const;
const PUBLIC_ERROR_STATUSES = [400, 401, 404, 409, 422, 429, 500] as const;

interface PlatformOpenApiOptions {
  response: ZodType;
  body?: ZodType;
}

export function addPlatformSessionSecurity(
  builder: DocumentBuilder,
  sessionCookieName: string,
): DocumentBuilder {
  return builder.addCookieAuth(
    sessionCookieName,
    { type: "apiKey", in: "cookie" },
    PLATFORM_SESSION_SECURITY,
  );
}

export function platformOpenApiSchema(schema: ZodType): SchemaObject {
  // Platform response schemas normalize values such as database Dates and timestamp strings.
  // Zod cannot represent those output transforms in JSON Schema, so OpenAPI describes the
  // accepted JSON wire shape; the controller boundary still parses and normalizes the response.
  const wireSchema = z.toJSONSchema(schema, { target: "openapi-3.0", io: "input" });
  Reflect.deleteProperty(wireSchema, "$schema");
  return wireSchema as SchemaObject;
}

export function PlatformApiProtectedOk(options: PlatformOpenApiOptions): MethodDecorator {
  return platformOperation(200, options, true);
}

export function PlatformApiProtectedCreated(options: PlatformOpenApiOptions): MethodDecorator {
  return platformOperation(201, options, true);
}

export function PlatformApiPublicCreated(options: PlatformOpenApiOptions): MethodDecorator {
  return platformOperation(201, options, false);
}

function platformOperation(
  successStatus: 200 | 201,
  options: PlatformOpenApiOptions,
  protectedRoute: boolean,
): MethodDecorator {
  const decorators: MethodDecorator[] = [
    ApiResponse({ status: successStatus, schema: platformOpenApiSchema(options.response) }),
    ...platformErrorResponses(protectedRoute),
  ];
  if (options.body) {
    decorators.push(ApiBody({ schema: platformOpenApiSchema(options.body) }));
  }
  if (protectedRoute) {
    decorators.push(ApiSecurity(PLATFORM_SESSION_SECURITY));
  }
  return applyDecorators(...decorators);
}

function platformErrorResponses(protectedRoute: boolean): MethodDecorator[] {
  const statuses = protectedRoute ? PROTECTED_ERROR_STATUSES : PUBLIC_ERROR_STATUSES;
  const schema = platformOpenApiSchema(platformErrorSchema);
  return statuses.map((status) => ApiResponse({ status, schema }));
}
