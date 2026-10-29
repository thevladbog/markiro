import {
  usExportBuildIdentitySchema,
  type UsExportBuildIdentity,
} from "@markiro/platform-contracts";
import { z } from "zod";

export const DOCUMENT_BYTES = 1024 * 1024;
export const FILE_BYTES = 32 * 1024 * 1024;
export const TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_FILES = 10_000;
export const LIBRARIES = Object.freeze({
  "@react-pdf/renderer": "4.6.1",
  "write-excel-file": "4.1.1",
  fflate: "0.8.3",
} as const);
export const TREES = ["api", "contracts", "db", "domain"] as const;
export const DESCRIPTOR = "us-request-build.json";
const FONT_PATHS = [
  "modules/traceability/plans/assets/IBMPlexSans-Regular.ttf",
  "modules/traceability/plans/assets/IBMPlexSans-Bold.ttf",
];
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const safePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.includes("\\") &&
      !path.includes(":") &&
      !path.includes("\0") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  );
export const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    build: usExportBuildIdentitySchema,
    lockfileSha256: sha256,
    libraries: z
      .object({
        "@react-pdf/renderer": z.literal("4.6.1"),
        "write-excel-file": z.literal("4.1.1"),
        fflate: z.literal("0.8.3"),
      })
      .strict(),
    files: z
      .array(
        z
          .object({
            tree: z.enum(TREES),
            path: safePath,
            byteSize: z.number().int().min(0).max(FILE_BYTES),
            sha256,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_FILES),
  })
  .strict()
  .superRefine((document, context) => {
    let previous = "";
    let total = 0;
    for (const file of document.files) {
      const key = `${file.tree}/${file.path}`;
      if (key <= previous || (file.tree === "api" && file.path === DESCRIPTOR)) {
        context.addIssue({ code: "custom", message: "Invalid inventory" });
      }
      previous = key;
      total += file.byteSize;
    }
    if (total > TOTAL_BYTES) context.addIssue({ code: "custom", message: "Invalid byte limit" });
    for (const tree of TREES) {
      if (!document.files.some((file) => file.tree === tree))
        context.addIssue({ code: "custom", message: "Missing output tree" });
    }
    for (const path of FONT_PATHS) {
      if (
        !document.files.some(
          (file) => file.tree === "api" && file.path === path && file.byteSize > 0,
        )
      )
        context.addIssue({ code: "custom", message: "Missing bundled font" });
    }
  });
export type UsRequestBuildDocument = Readonly<{
  schemaVersion: 1;
  build: Readonly<UsExportBuildIdentity>;
  lockfileSha256: string;
  libraries: Readonly<typeof LIBRARIES>;
  files: readonly Readonly<z.infer<typeof documentSchema>["files"][number]>[];
}>;
