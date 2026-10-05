import { z } from "zod";

const schema = z
  .object({
    endpoint: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        url.port === "19000" &&
        url.pathname === "/" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
    region: z.string().trim().min(1).max(64),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    accessKeyId: z.string().min(1).max(256),
    secretAccessKey: z.string().min(1).max(256),
    forcePathStyle: z.literal("true").transform(() => true),
  })
  .strict();
export type UsRequestPackageArtifactStorageConfig = Readonly<z.infer<typeof schema>>;
const validated = new WeakSet<UsRequestPackageArtifactStorageConfig>();
const fields = {
  endpoint: "US_REQUEST_PACKAGE_S3_ENDPOINT",
  region: "US_REQUEST_PACKAGE_S3_REGION",
  bucket: "US_REQUEST_PACKAGE_S3_BUCKET",
  accessKeyId: "US_REQUEST_PACKAGE_S3_ACCESS_KEY_ID",
  secretAccessKey: "US_REQUEST_PACKAGE_S3_SECRET_ACCESS_KEY",
  forcePathStyle: "US_REQUEST_PACKAGE_S3_FORCE_PATH_STYLE",
} as const;
class ConfigurationError extends Error {
  constructor(
    readonly code:
      | "us_request_package_storage_configuration_invalid"
      | "us_request_package_storage_operational_verification_required",
  ) {
    super(code);
  }
}

/** Synthetic development/test only; no residency or operational assertion. */
export function loadUsRequestPackageArtifactStorageConfig(
  source: NodeJS.ProcessEnv,
): UsRequestPackageArtifactStorageConfig | null {
  if (source.NODE_ENV === "production")
    throw new ConfigurationError("us_request_package_storage_operational_verification_required");
  if (!Object.values(fields).some((field) => source[field] !== undefined)) return null;
  const parsed = schema.safeParse(
    Object.fromEntries(
      Object.entries(fields).map(([property, field]) => [property, source[field]]),
    ),
  );
  if (
    !parsed.success ||
    source.MARKIRO_DEPLOYMENT_EDITION !== "US" ||
    !["development", "test"].includes(source.NODE_ENV ?? "") ||
    parsed.data.bucket === source.S3_BUCKET ||
    parsed.data.accessKeyId === source.S3_ACCESS_KEY_ID ||
    parsed.data.secretAccessKey === source.S3_SECRET_ACCESS_KEY
  )
    throw new ConfigurationError("us_request_package_storage_configuration_invalid");
  const config = Object.freeze(parsed.data);
  validated.add(config);
  return config;
}

export function assertUsRequestPackageArtifactStorageConfig(
  config: UsRequestPackageArtifactStorageConfig,
): void {
  if (!validated.has(config))
    throw new ConfigurationError("us_request_package_storage_configuration_invalid");
}
