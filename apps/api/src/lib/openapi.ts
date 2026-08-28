import { applyDecorators } from "@nestjs/common";
import { ApiBody, ApiQuery, ApiResponse, ApiSecurity, type SchemaObject } from "@nestjs/swagger";
import { z, type ZodObject, type ZodType } from "zod";

/**
 * OpenAPI security scheme names registered on the DocumentBuilder in main.ts.
 * Tenant-scoped controllers reference these via the ApiXxxAuth() decorators
 * below so Scalar shows which credential each route expects. Platform routes
 * keep their own scheme (see platform-http/platform-openapi.ts).
 */
export const CABINET_SESSION_SECURITY = "cabinetSession";
export const STATION_API_KEY_SECURITY = "stationApiKey";
export const KIOSK_TOKEN_SECURITY = "kioskToken";
export const SIGNER_AGENT_TOKEN_SECURITY = "signerAgentToken";

/**
 * Converts a zod schema into an OpenAPI 3.0 SchemaObject describing the JSON
 * wire shape. `io: "input"` documents what the API accepts: zod output-side
 * transforms (Date normalization, defaults) cannot be represented in JSON
 * Schema, and every module schema in this app validates incoming payloads.
 */
export function zodApiSchema(schema: ZodType): SchemaObject {
  const wireSchema = z.toJSONSchema(schema, { target: "openapi-3.0", io: "input" });
  Reflect.deleteProperty(wireSchema, "$schema");
  return wireSchema as SchemaObject;
}

/** ApiBody with the schema derived from the same zod schema the route validates with. */
export function ApiZodBody(schema: ZodType): MethodDecorator {
  return ApiBody({ schema: zodApiSchema(schema) });
}

/**
 * Expands a zod object schema into one ApiQuery decorator per property, so
 * Scalar renders individual query parameters instead of one opaque object.
 */
export function ApiZodQuery(schema: ZodObject): MethodDecorator {
  const objectSchema = zodApiSchema(schema);
  const required = new Set(objectSchema.required ?? []);
  const decorators = Object.entries(objectSchema.properties ?? {}).map(([name, property]) => {
    const propertySchema = property as SchemaObject;
    return ApiQuery({
      name,
      required: required.has(name),
      schema: propertySchema,
      ...(propertySchema.description ? { description: propertySchema.description } : {}),
    });
  });
  return applyDecorators(...decorators);
}

/**
 * ApiResponse with the schema derived from a zod schema, for modules whose
 * response DTOs are zod-typed. Modules with interface-only response DTOs
 * document a hand-written SchemaObject instead (see inventories/dto.ts).
 */
export function ApiZodResponse(options: {
  status: number;
  schema: ZodType;
  description?: string;
}): MethodDecorator {
  return ApiResponse({
    status: options.status,
    schema: zodApiSchema(options.schema),
    ...(options.description ? { description: options.description } : {}),
  });
}

/** Nest's default HttpException JSON body. */
export const httpErrorSchema: SchemaObject = {
  type: "object",
  required: ["statusCode", "message"],
  properties: {
    statusCode: { type: "integer" },
    message: { type: "string" },
    error: { type: "string" },
  },
};

/** ZodValidationPipe 400 body: Nest wraps the issue list as `message`. */
export const validationErrorSchema: SchemaObject = {
  type: "object",
  required: ["statusCode", "message"],
  properties: {
    statusCode: { type: "integer", enum: [400] },
    message: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "message"],
        properties: {
          path: { type: "string", description: "Dot-joined path of the invalid field." },
          message: { type: "string" },
        },
      },
    },
    error: { type: "string" },
  },
};

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Malformed or invalid request.",
  // Worded to avoid "credentials": the inventories contract test greps the
  // rendered path JSON for private-field tripwires, and /credential/i is one.
  401: "Missing or invalid authentication.",
  402: "Subscription does not permit this operation.",
  403: "Authenticated, but not permitted to perform this operation.",
  404: "The referenced resource does not exist in this tenant.",
  409: "The request conflicts with current resource state.",
  413: "Payload exceeds the accepted size limit.",
  415: "Unsupported media type.",
  422: "The request is well-formed but cannot be processed.",
  429: "Rate limit exceeded; retry after the window resets.",
  503: "The service dependency is unavailable.",
};

/** Declares uniform error responses with the standard HttpException body. */
export function ApiHttpErrors(...statuses: number[]): MethodDecorator {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        schema: httpErrorSchema,
        ...(ERROR_DESCRIPTIONS[status] ? { description: ERROR_DESCRIPTIONS[status] } : {}),
      }),
    ),
  );
}

/** The 400 produced by ZodValidationPipe when the body/query fails validation. */
export function ApiZodValidationError(): MethodDecorator {
  return ApiResponse({
    status: 400,
    schema: validationErrorSchema,
    description: "Request validation failed; `message` lists the offending fields.",
  });
}

/** Routes guarded by TenantGuard's session path only (admin/manager cabinet UI). */
export function ApiCabinetAuth(): ClassDecorator & MethodDecorator {
  return ApiSecurity(CABINET_SESSION_SECURITY);
}

/** Routes accepting either a cabinet session or a paired station's x-api-key. */
export function ApiCabinetOrStationAuth(): ClassDecorator & MethodDecorator {
  return applyDecorators(
    ApiSecurity(CABINET_SESSION_SECURITY),
    ApiSecurity(STATION_API_KEY_SECURITY),
  );
}

/** Station-only routes (StationOnlyGuard): the paired device's x-api-key. */
export function ApiStationAuth(): ClassDecorator & MethodDecorator {
  return ApiSecurity(STATION_API_KEY_SECURITY);
}

/** Kiosk-device routes (KioskDeviceGuard): the paired kiosk's x-kiosk-token. */
export function ApiKioskAuth(): ClassDecorator & MethodDecorator {
  return ApiSecurity(KIOSK_TOKEN_SECURITY);
}

/** Signer-agent routes (SignerAgentGuard): the paired agent's x-signer-token. */
export function ApiSignerAgentAuth(): ClassDecorator & MethodDecorator {
  return ApiSecurity(SIGNER_AGENT_TOKEN_SECURITY);
}
