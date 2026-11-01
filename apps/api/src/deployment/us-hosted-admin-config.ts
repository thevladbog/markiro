import { z } from "zod";

export type UsHostedAdminOperation = "migrate" | "seed" | "provision";
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const release = z
  .object({
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    manifestSha256: sha256,
    adminManifestSha256: sha256,
  })
  .strict()
  .readonly();
const database = (operation: UsHostedAdminOperation) =>
  z
    .object({
      host: z.literal("postgres.us-demo.internal"),
      port: z.literal(5432),
      name: z.literal("markiro_us_synthetic"),
      user: z.literal("markiro_us"),
      caFile: z.literal("/run/secrets/us-demo/db-ca.pem"),
      passwordFile: z.literal(`/run/secrets/us-demo/admin-${operation}-db-password`),
    })
    .strict()
    .readonly();
const common = {
  schemaVersion: z.literal(1),
  edition: z.literal("US"),
  purpose: z.literal("synthetic-demo"),
  mode: z.literal("production"),
  service: z.literal("admin"),
  release,
};
const schema = z
  .discriminatedUnion("operation", [
    z
      .object({ ...common, operation: z.literal("migrate"), database: database("migrate") })
      .strict(),
    z
      .object({
        ...common,
        operation: z.literal("seed"),
        database: database("seed"),
        storage: z
          .object({
            endpoint: z.literal("https://objects.us-demo.internal"),
            bucket: z.literal("markiro-us-synthetic-private"),
            signingRegion: z
              .string()
              .min(1)
              .max(63)
              .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
              .refine((value) => value === value.trim()),
            caFile: z.literal("/run/secrets/us-demo/storage-ca.pem"),
            accessKeyFile: z.literal("/run/secrets/us-demo/admin-seed-storage-access-key"),
            secretKeyFile: z.literal("/run/secrets/us-demo/admin-seed-storage-secret-key"),
            forcePathStyle: z.literal(true),
          })
          .strict()
          .readonly(),
      })
      .strict(),
    z
      .object({ ...common, operation: z.literal("provision"), database: database("provision") })
      .strict(),
  ])
  .readonly();

/** Expectations only; parsing grants no administrative authority or material access. */
export type UnverifiedUsHostedAdminConfig = z.infer<typeof schema>;

export function parseUsHostedAdminOperation(args: readonly string[]): UsHostedAdminOperation {
  if (Array.isArray(args) && args.length === 1) {
    const operation: unknown = args[0];
    if (operation === "migrate" || operation === "seed" || operation === "provision")
      return operation;
  }
  throw new Error("us_hosted_admin_operation_invalid");
}

/** Pure strict admission; no environment, filesystem, client or secret acquisition. */
export function parseUsHostedAdminConfig(
  document: string,
  expectedOperation: UsHostedAdminOperation,
): UnverifiedUsHostedAdminConfig {
  try {
    parseUsHostedAdminOperation([expectedOperation]);
    if (
      typeof document !== "string" ||
      Buffer.byteLength(document, "utf8") > 16384 ||
      Buffer.from(document, "utf8").toString("utf8") !== document
    )
      throw new Error();
    const parsed = schema.parse(JSON.parse(document));
    if (parsed.operation !== expectedOperation) throw new Error();
    return parsed;
  } catch {
    throw new Error("us_hosted_admin_config_invalid");
  }
}
