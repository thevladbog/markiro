import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  publicationRequestSchema,
  historyPublicationRequestSchema,
} from "@markiro/platform-contracts";
import { assertHistoricalSigner } from "../src/modules/release-catalog/catalog-history-product";
import type { VerifiedInputFile } from "../src/modules/release-catalog/catalog-types";
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function fixture() {
  const version = "0.1.4",
    sourceSha = "a".repeat(40),
    name = "markiro-signer-0.1.4-windows-x86_64-setup.exe";
  const installer = Buffer.from("historical installer"),
    sig = Buffer.from("preserved signature");
  const manifest = Buffer.from(
    JSON.stringify({
      version,
      pub_date: "2026-10-20T00:00:00Z",
      platforms: {
        "windows-x86_64": {
          url: `https://releases.markiro.app/signer/stable/releases/${version}/${name}`,
          signature: sig.toString(),
        },
      },
    }),
  );
  const primary = new Map([
    [name, installer],
    [name + ".sig", sig],
    ["latest.json", manifest],
  ]);
  const evidence = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      product: "signer",
      channel: "stable",
      version,
      pubDate: "2026-10-20T00:00:00Z",
      source: { repository: "thevladbog/markiro", sha: sourceSha },
      assets: Object.fromEntries(
        [...primary].map(([n, b]) => [n, { sha256: hash(b), size: b.length }]),
      ),
    }),
  );
  primary.set("release-evidence.json", evidence);
  primary.set(
    "SHA256SUMS",
    Buffer.from(
      [...primary]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([n, b]) => `${hash(b)}  ${n}`)
        .join("\n") + "\n",
    ),
  );
  const files = [...primary].map(([name, b]) => ({
    name,
    sha256: hash(b),
    sizeBytes: b.length,
    contentType: "application/octet-stream" as const,
  }));
  const request = {
    identity: { product: "signer", channel: "stable", version },
    sourceSha,
    files,
    evidence: {
      kind: "signer",
      manifestName: "latest.json",
      evidenceName: "release-evidence.json",
    },
  };
  const verified = new Map<string, VerifiedInputFile>(
    files.map((spec) => [
      spec.name,
      {
        spec,
        sha256: spec.sha256,
        sizeBytes: spec.sizeBytes,
        read: async () => primary.get(spec.name) ?? Buffer.alloc(0),
      },
    ]),
  );
  return { request, verified };
}
it("historical signer uses canonical five-file verification but remains excluded from publisher requests", async () => {
  const f = fixture();
  expect(publicationRequestSchema.safeParse(f.request).success).toBe(false);
  const request = historyPublicationRequestSchema.parse(f.request);
  await expect(assertHistoricalSigner(request, f.verified)).resolves.toMatchObject({
    product: "signer",
    version: "0.1.4",
    sourceSha: "a".repeat(40),
  });
  await expect(
    assertHistoricalSigner({ ...request, sourceSha: "b".repeat(40) }, f.verified),
  ).rejects.toThrow();
  f.verified.delete("SHA256SUMS");
  await expect(assertHistoricalSigner(request, f.verified)).rejects.toThrow();
});
