import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

export const activationTokenSchema = z.object({ token: z.string().min(16).max(512) });
export const completeTenantOwnerActivationSchema = activationTokenSchema.extend({
  password: z.string().min(8).max(128).optional(),
});

export type ActivationTokenDto = z.infer<typeof activationTokenSchema>;
export type CompleteTenantOwnerActivationDto = z.infer<typeof completeTenantOwnerActivationSchema>;

export interface TenantOwnerActivationStatusDto {
  hasAccount: boolean;
}

export const tenantOwnerActivationStatusOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["hasAccount"],
  properties: { hasAccount: { type: "boolean" } },
};

/** The 404 body both routes answer for an unknown, expired, or malformed token. */
export const activationUnavailableOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["code"],
  properties: { code: { type: "string", enum: ["activation_unavailable"] } },
};

/** `complete`'s own 400s: no password when one is required, or one when a credential exists. */
export const completeActivationErrorOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["code"],
  properties: { code: { type: "string", enum: ["password_required", "existing_credential"] } },
};
