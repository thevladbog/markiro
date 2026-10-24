import {
  STANDALONE_RELEASE_PRODUCT,
  standaloneInstallerFileName,
  standaloneManifestFileName,
  standaloneReleaseChannelSchema,
  standaloneReleaseVersionSchema,
  type StandaloneReleaseChannel,
} from "@markiro/platform-contracts";
import { z } from "zod";

/** Well above any signed manifest; a larger file is not one. */
export const MANIFEST_MAX_BYTES = 64 * 1024;

/**
 * Only what the panel shows before uploading. The signature is NOT checked
 * here: the API verifies the manifest against the release keys and the
 * installer bytes after the upload, so this preview is a convenience that
 * catches the wrong file early, never a trust decision.
 */
const previewSchema = z.object({
  product: z.string(),
  sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
  version: standaloneReleaseVersionSchema,
  channel: standaloneReleaseChannelSchema,
  installer: z.object({
    name: z.string(),
    sha256: z.string(),
    sizeBytes: z.number().int().positive(),
  }),
  notes: z.array(z.string()).optional(),
});

export interface ManifestPreview {
  sourceSha: string;
  version: string;
  channel: StandaloneReleaseChannel;
  installer: { name: string; sha256: string; sizeBytes: number };
  notes: string[];
}

export type ManifestProblem = "too_large" | "not_jws" | "unreadable" | "wrong_product";

export type ManifestReading =
  { ok: true; preview: ManifestPreview } | { ok: false; problem: ManifestProblem };

function decodeBase64Url(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  try {
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function readManifestText(text: string): ManifestReading {
  const segments = text.trim().split(".");
  if (segments.length !== 3 || segments.some((segment) => segment === "")) {
    return { ok: false, problem: "not_jws" };
  }
  const payloadText = decodeBase64Url(segments[1] ?? "");
  if (payloadText === null) return { ok: false, problem: "not_jws" };
  let value: unknown;
  try {
    value = JSON.parse(payloadText);
  } catch {
    return { ok: false, problem: "unreadable" };
  }
  const parsed = previewSchema.safeParse(value);
  if (!parsed.success) return { ok: false, problem: "unreadable" };
  if (parsed.data.product !== STANDALONE_RELEASE_PRODUCT) {
    return { ok: false, problem: "wrong_product" };
  }
  const { version, channel, sourceSha, installer, notes } = parsed.data;
  return { ok: true, preview: { version, channel, sourceSha, installer, notes: notes ?? [] } };
}

export async function readManifestFile(file: Blob): Promise<ManifestReading> {
  if (file.size > MANIFEST_MAX_BYTES) return { ok: false, problem: "too_large" };
  return readManifestText(await file.text());
}

export type SelectionIssue =
  | { kind: "installer_size"; expected: number; actual: number; blocking: true }
  | { kind: "installer_name"; expected: string; actual: string; blocking: false }
  | { kind: "manifest_name"; expected: string; actual: string; blocking: false };

/**
 * Friendly early checks of the chosen files against the manifest. A size
 * difference is certain to fail on the server; a different file name is only
 * a warning, because browsers rename repeated downloads (`… (1).exe`) and the
 * API names the objects itself.
 */
export function selectionIssues(
  preview: ManifestPreview,
  manifest: { name: string },
  installer: { name: string; size: number } | null,
): SelectionIssue[] {
  const issues: SelectionIssue[] = [];
  const manifestName = standaloneManifestFileName(preview.version);
  if (manifest.name !== manifestName) {
    issues.push({
      kind: "manifest_name",
      expected: manifestName,
      actual: manifest.name,
      blocking: false,
    });
  }
  if (installer) {
    if (installer.size !== preview.installer.sizeBytes) {
      issues.push({
        kind: "installer_size",
        expected: preview.installer.sizeBytes,
        actual: installer.size,
        blocking: true,
      });
    }
    const installerName = standaloneInstallerFileName(preview.version);
    if (installer.name !== installerName) {
      issues.push({
        kind: "installer_name",
        expected: installerName,
        actual: installer.name,
        blocking: false,
      });
    }
  }
  return issues;
}
