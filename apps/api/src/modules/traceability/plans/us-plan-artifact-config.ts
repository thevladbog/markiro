import { z } from "zod";

const schema = z.object({
  endpoint: z.url().refine((value) => {
    try {
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
    } catch {
      return false;
    }
  }),
  region: z.string().trim().min(1).max(64),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(256),
  forcePathStyle: z.literal("true").transform(() => true),
});

export type UsPlanArtifactStorageConfig = Readonly<z.infer<typeof schema>>;
const validatedConfigs = new WeakSet<UsPlanArtifactStorageConfig>();
const fields = {
  endpoint: "US_PLAN_ARTIFACT_S3_ENDPOINT",
  region: "US_PLAN_ARTIFACT_S3_REGION",
  bucket: "US_PLAN_ARTIFACT_S3_BUCKET",
  accessKeyId: "US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID",
  secretAccessKey: "US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY",
  forcePathStyle: "US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE",
} as const;

/** Local synthetic seam only. No environment flag can assert residency/backup verification. */
export function loadUsPlanArtifactStorageConfig(
  source: NodeJS.ProcessEnv,
): UsPlanArtifactStorageConfig | null {
  if (source.NODE_ENV === "production")
    throw new Error("us_plan_artifact_operational_verification_required");
  if (!Object.values(fields).some((field) => source[field]?.trim())) return null;
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
  ) {
    // Zod/provider errors and configured values must never reach diagnostics.
    throw new Error("us_plan_artifact_configuration_invalid");
  }
  const config = Object.freeze(parsed.data);
  validatedConfigs.add(config);
  return config;
}

export function assertUsPlanArtifactStorageConfig(config: UsPlanArtifactStorageConfig): void {
  if (!validatedConfigs.has(config)) throw new Error("us_plan_artifact_configuration_invalid");
}
