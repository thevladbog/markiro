import type { Db } from "@markiro/db";
import { publicApiScopesSchema, type PublicApiScope } from "@markiro/platform-contracts";
import type { Request } from "express";
import { z } from "zod";

export interface PublicApiPrincipal {
  kind: "public_api";
  tenantId: string;
  keyId: string;
  scopes: PublicApiScope[];
}
export interface RequestWithPublicApiPrincipal extends Request {
  publicApiPrincipal?: PublicApiPrincipal;
}
export type PublicApiTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const metadataSchema = z
  .object({ kind: z.literal("public"), scopes: publicApiScopesSchema.default([]) })
  .strict();
export function parsePublicApiMetadata(raw: string | null): z.infer<typeof metadataSchema> | null {
  try {
    const parsed = metadataSchema.safeParse(JSON.parse(raw ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
