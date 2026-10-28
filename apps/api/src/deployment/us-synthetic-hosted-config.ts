import { isIP } from "node:net";
import { z } from "zod";

export type UsSyntheticHostedService = "api" | "worker";

const publicOrigin = z
  .string()
  .max(261)
  .refine((value) => {
    try {
      const url = new URL(value);
      const host = url.hostname;
      return (
        url.protocol === "https:" &&
        value === url.origin &&
        !url.username &&
        !url.password &&
        !url.port &&
        host.length <= 253 &&
        !isIP(host) &&
        !["localhost", "local", "internal"].some(
          (suffix) => host === suffix || host.endsWith(`.${suffix}`),
        ) &&
        host.split(".").length >= 2 &&
        host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      );
    } catch {
      return false;
    }
  });

function database(service: UsSyntheticHostedService) {
  return z
    .object({
      host: z.literal("postgres.us-demo.internal"),
      port: z.literal(5432),
      name: z.literal("markiro_us_synthetic"),
      user: z.literal(`markiro_us_${service}`),
      caFile: z.literal("/run/secrets/us-demo/db-ca.pem"),
      passwordFile: z.literal(`/run/secrets/us-demo/${service}-db-password`),
    })
    .strict()
    .readonly();
}

function storage(service: UsSyntheticHostedService) {
  return z
    .object({
      endpoint: z.literal("https://objects.us-demo.internal"),
      bucket: z.literal("markiro-us-synthetic-private"),
      // An S3 signing identifier is not proof of physical region or private policy.
      signingRegion: z
        .string()
        .min(1)
        .max(63)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .refine((value) => value === value.trim()),
      caFile: z.literal("/run/secrets/us-demo/storage-ca.pem"),
      accessKeyFile: z.literal(`/run/secrets/us-demo/${service}-storage-access-key`),
      secretKeyFile: z.literal(`/run/secrets/us-demo/${service}-storage-secret-key`),
      forcePathStyle: z.literal(true),
    })
    .strict()
    .readonly();
}

const release = z
  .object({
    sourceSha: z
      .string()
      .length(40)
      .regex(/^[a-f0-9]{40}$/),
    manifestSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/),
    manifestFile: z.literal("/app/us-synthetic-release.json"),
  })
  .strict()
  .readonly();
const common = {
  schemaVersion: z.literal(1),
  edition: z.literal("US"),
  purpose: z.literal("synthetic-demo"),
  mode: z.literal("production"),
  publicOrigin,
  release,
};
const configuration = z
  .discriminatedUnion("service", [
    z
      .object({
        ...common,
        service: z.literal("api"),
        database: database("api"),
        storage: storage("api"),
        tls: z
          .object({
            certificateFile: z.literal("/run/secrets/us-demo/api-cert.pem"),
            privateKeyFile: z.literal("/run/secrets/us-demo/api-key.pem"),
          })
          .strict()
          .readonly(),
      })
      .strict(),
    z
      .object({
        ...common,
        service: z.literal("worker"),
        database: database("worker"),
        storage: storage("worker"),
      })
      .strict(),
  ])
  .readonly();

export type UsSyntheticHostedConfig = z.infer<typeof configuration>;

/** Admission data only: no release verification, secret reading or connection.
 * Existing local/RU executable policies never consume this document. */
export function parseUsSyntheticHostedConfig(
  document: string,
  expectedService: UsSyntheticHostedService,
): UsSyntheticHostedConfig {
  try {
    if (
      typeof document !== "string" ||
      Buffer.byteLength(document, "utf8") > 16384 ||
      (expectedService !== "api" && expectedService !== "worker")
    )
      throw new Error();
    const parsed = configuration.parse(JSON.parse(document));
    if (parsed.service !== expectedService) throw new Error();
    return parsed;
  } catch {
    // Never expose schema issues, rejected URLs, secret references or input bytes.
    throw new Error("us_synthetic_hosted_config_invalid");
  }
}
