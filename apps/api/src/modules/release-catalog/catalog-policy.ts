import { createHash } from "node:crypto";
import {
  publicationRequestSchema,
  releaseFileNameSchema,
  releaseIdentitySchema,
  releaseOperationIdSchema,
  releaseProductSchema,
} from "@markiro/platform-contracts";

/** Reject aliases instead of decoding/normalizing an attacker-chosen public path. */
export function derivePublicPath(identityInput: unknown, nameInput: unknown): string {
  const identity = releaseIdentitySchema.parse(identityInput);
  const name = releaseFileNameSchema.parse(nameInput);
  const prefix = `/${identity.product}/${identity.channel}`;
  return `${prefix}${identity.product === "standalone" ? "" : "/releases"}/${identity.version}/${name}`;
}

export function deriveUploadKey(
  productInput: unknown,
  intentInput: unknown,
  nameInput: unknown,
): string {
  const product = releaseProductSchema.parse(productInput);
  const intent = releaseOperationIdSchema.parse(intentInput);
  const name = releaseFileNameSchema.parse(nameInput);
  return `${product}/_uploads/${intent}/${name}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("invalid catalog value");
  return serialized;
}

/** Semantic equality excludes storage VersionIds but covers every admitted field. */
export function canonicalPublicationDigest(input: unknown): string {
  const request = publicationRequestSchema.parse(input);
  const files = [...request.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash("sha256")
    .update(canonicalJson({ schema: 1, ...request, files }))
    .digest("hex");
}
