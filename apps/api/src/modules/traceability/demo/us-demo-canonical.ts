import { createHash } from "node:crypto";
import { canonicalExportJson } from "@markiro/domain";

/** Server-only hash of the shared validated bytes; every call traverses its input. */
export function canonicalExportDigest(input: unknown): string {
  return createHash("sha256").update(canonicalExportJson(input), "utf8").digest("hex");
}
