import { createHash } from "node:crypto";
import {
  historyPublicationRequestSchema,
  historyCanonical,
  type HistoryPublicationRequest,
} from "@markiro/platform-contracts";
import { validateSignerReleaseFiles } from "@markiro/release-validation";
import { z } from "zod";
import { CatalogFault, type VerifiedInputFiles } from "./catalog-types";
interface HistoricalSignerAcceptance extends Record<string, unknown> {
  product: "signer";
  version: string;
  sourceSha: string;
  pointer: Record<string, unknown>;
  evidence: Record<string, unknown>;
}
export function historyPublicationDigest(input: unknown) {
  const request = historyPublicationRequestSchema.parse(input),
    files = [...request.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash("sha256")
    .update(historyCanonical({ schema: 1, ...request, files }))
    .digest("hex");
}
export async function assertHistoricalSigner(
  input: HistoryPublicationRequest,
  files: VerifiedInputFiles,
): Promise<HistoricalSignerAcceptance> {
  const r = historyPublicationRequestSchema.parse(input);
  if (
    r.evidence.kind !== "signer" ||
    r.identity.product !== "signer" ||
    files.size !== r.files.length
  )
    throw new CatalogFault("conflict");
  const file = (name: string) => {
    const f = files.get(name),
      s = r.files.find((s) => s.name === name);
    if (
      !f ||
      !s ||
      f.sha256 !== s.sha256 ||
      f.sizeBytes !== s.sizeBytes ||
      f.spec.contentType !== s.contentType
    )
      throw new CatalogFault("conflict");
    return f;
  };
  for (const s of r.files) file(s.name);
  const result = await validateSignerReleaseFiles(
    {
      names: [...files.keys()],
      size: (n) => file(n).sizeBytes,
      digest: (n) => Promise.resolve(file(n).sha256),
      text: async (n, max) => {
        const b = await file(n).read(max);
        if (b.length !== file(n).sizeBytes || b.length > max) throw new CatalogFault("conflict");
        return new TextDecoder("utf-8", { fatal: true }).decode(b);
      },
    },
    { version: r.identity.version },
  );
  const evidence = z
    .object({
      source: z.object({
        repository: z.literal("thevladbog/markiro"),
        sha: z.literal(r.sourceSha),
      }),
    })
    .passthrough()
    .parse(result.evidence);
  return {
    product: "signer",
    version: r.identity.version,
    sourceSha: r.sourceSha,
    pointer: z.record(z.string(), z.unknown()).parse(result.manifest),
    evidence,
  };
}
