import { usExportBuildIdentitySchema } from "@markiro/platform-contracts";
import { z } from "zod";

const DOCUMENT_BYTES = 1024 * 1024;
const FILE_BYTES = 32 * 1024 * 1024;
const TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 10_000;
const descriptorPath = "apps/api/dist/us-request-build.json";
const entrypoints = {
  api: "apps/api/dist/main.us-hosted.js",
  worker: "apps/api/dist/main.us-hosted-worker.js",
} as const;
const roots = [
  "apps/api/dist/",
  "packages/db/dist/",
  "packages/domain/dist/",
  "packages/platform-contracts/dist/",
  "apps/admin/dist-us/",
  "packages/db/migrations/",
] as const;
const metadata = [
  "pnpm-lock.yaml",
  "apps/api/package.json",
  "packages/db/package.json",
  "packages/domain/package.json",
  "packages/platform-contracts/package.json",
] as const;
const required = [
  ...Object.values(entrypoints),
  descriptorPath,
  "packages/db/dist/index.js",
  "packages/domain/dist/index.js",
  "packages/platform-contracts/dist/index.js",
  "apps/api/dist/modules/traceability/plans/assets/IBMPlexSans-Regular.ttf",
  "apps/api/dist/modules/traceability/plans/assets/IBMPlexSans-Bold.ttf",
  "apps/admin/dist-us/index.html",
  "apps/admin/dist-us/.vite/manifest.json",
  "packages/db/migrations/meta/_journal.json",
  ...metadata,
];
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const inventoryPath = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine((path) => {
    const parts = path.split("/");
    if (
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part === "node_modules" ||
          part === ".env" ||
          part.startsWith(".env.") ||
          /^(?:backup|backups)$/i.test(part),
      ) ||
      /\.(?:key|pem|crt|cer|p12|pfx|bak)$/i.test(path)
    )
      return false;
    return metadata.some((file) => path === file) || roots.some((root) => path.startsWith(root));
  });
const file = z
  .object({ path: inventoryPath, byteSize: z.number().int().min(0).max(FILE_BYTES), sha256 })
  .strict()
  .readonly();
const schema = z
  .object({
    schemaVersion: z.literal(1),
    edition: z.literal("US"),
    purpose: z.literal("synthetic-demo"),
    build: usExportBuildIdentitySchema.extend({ dirty: z.literal(false) }).readonly(),
    requestBuildDescriptor: z
      .object({ path: z.literal(descriptorPath), sha256, digest: sha256 })
      .strict()
      .readonly(),
    entrypoints: z
      .object({ api: z.literal(entrypoints.api), worker: z.literal(entrypoints.worker) })
      .strict()
      .readonly(),
    files: z.array(file).min(1).max(MAX_FILES).readonly(),
  })
  .strict()
  .superRefine((value, context) => {
    const paths = new Set(value.files.map((entry) => entry.path));
    let previous = "";
    let total = 0;
    for (const entry of value.files) {
      if (entry.path <= previous) context.addIssue({ code: "custom", message: "Invalid order" });
      previous = entry.path;
      total += entry.byteSize;
      const parts = entry.path.split("/");
      for (let index = 1; index < parts.length; index++)
        if (paths.has(parts.slice(0, index).join("/")))
          context.addIssue({ code: "custom", message: "Ambiguous inventory" });
    }
    if (total > TOTAL_BYTES) context.addIssue({ code: "custom", message: "Invalid byte limit" });
    for (const path of required)
      if (!value.files.some((entry) => entry.path === path && entry.byteSize > 0))
        context.addIssue({ code: "custom", message: "Missing required artifact" });
    if (
      !value.files.some(
        (entry) =>
          entry.path.startsWith("packages/db/migrations/") &&
          entry.path.endsWith(".sql") &&
          entry.byteSize > 0,
      )
    )
      context.addIssue({ code: "custom", message: "Missing migration artifact" });
  })
  .readonly();

/** Expectations only: this type confers no verified release or execution capability. */
export type UnverifiedUsHostedReleaseManifest = z.infer<typeof schema>;

/** Primitive text admission only; no file, environment, secret or runtime access. */
export function parseUsHostedReleaseManifest(text: string): UnverifiedUsHostedReleaseManifest {
  try {
    if (
      typeof text !== "string" ||
      !text.length ||
      Buffer.byteLength(text, "utf8") > DOCUMENT_BYTES ||
      Buffer.from(text, "utf8").toString("utf8") !== text
    )
      throw new Error("Invalid document");
    const value: unknown = JSON.parse(text);
    return schema.parse(value);
  } catch {
    throw new Error("us_hosted_release_manifest_invalid");
  }
}
