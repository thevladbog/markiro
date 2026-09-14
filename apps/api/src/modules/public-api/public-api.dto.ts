import { createParamDecorator, type ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ApiHeader, ApiSecurity } from "@nestjs/swagger";
import { z } from "zod";
import { publicResultClassificationSchema } from "@markiro/platform-contracts";
import type { RequestWithPublicApiPrincipal } from "./public-api.types";

export const PUBLIC_API_SECURITY = "publicApiKey";
export const PublicIdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<RequestWithPublicApiPrincipal>().headers["idempotency-key"],
);
export const ApiPublicAuth = () => ApiSecurity(PUBLIC_API_SECURITY);
export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127));
export const ApiIdempotencyKey = () =>
  ApiHeader({
    name: "Idempotency-Key",
    required: true,
    schema: { type: "string", minLength: 1, maxLength: 200 },
    description: "Reuse for identical retries; a changed payload returns 409.",
  });
export const publicResultsQuerySchema = z
  .object({
    classification: publicResultClassificationSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type PublicResultsQuery = z.infer<typeof publicResultsQuerySchema>;
export const publicProductsQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(128).optional(),
    status: z.enum(["draft", "active"]).optional(),
  })
  .strict();
export type PublicProductsQuery = z.infer<typeof publicProductsQuerySchema>;
export const emptyPublicBodySchema = z.object({}).strict();
export function publicPrincipal(req: RequestWithPublicApiPrincipal) {
  if (!req.publicApiPrincipal) throw new UnauthorizedException("Public principal required");
  return req.publicApiPrincipal;
}
/** Pick only declared wire fields before strict validation; internal DTOs never cross this boundary. */
export function publicProjection<S extends z.ZodRawShape>(
  schema: z.ZodObject<S>,
  value: object,
): z.infer<z.ZodObject<S>> {
  return schema.parse(
    Object.fromEntries(Object.keys(schema.shape).map((key) => [key, Reflect.get(value, key)])),
  );
}
