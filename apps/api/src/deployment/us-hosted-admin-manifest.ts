import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z
  .object({
    schemaVersion: z.literal(1),
    edition: z.literal("US"),
    purpose: z.literal("synthetic-demo"),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    runtimeManifestSha256: sha256,
    entrypoint: z
      .object({
        path: z.literal("apps/api/dist/main.us-hosted-admin.js"),
        byteSize: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
        sha256,
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

/** Expectations only; no checked bytes or executable authority. */
export type UnverifiedUsHostedAdminManifest = z.infer<typeof schema>;

export function parseUsHostedAdminManifest(document: string): UnverifiedUsHostedAdminManifest {
  try {
    if (
      typeof document !== "string" ||
      !document.length ||
      Buffer.byteLength(document, "utf8") > 1024 * 1024 ||
      Buffer.from(document, "utf8").toString("utf8") !== document
    )
      throw new Error();
    return schema.parse(JSON.parse(document));
  } catch {
    throw new Error("us_hosted_admin_manifest_invalid");
  }
}
