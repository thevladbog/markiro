import { describe, expect, it } from "vitest";
import {
  canonicalPublicationDigest,
  derivePublicPath,
  deriveUploadKey,
} from "../src/modules/release-catalog/catalog-policy";
const id = "3890cfde-dec7-44fe-885e-b7b4444db6b9";
const request = {
  identity: { product: "standalone", channel: "stable", version: "1.0.0" },
  sourceSha: "b".repeat(40),
  files: [
    {
      name: "manifest.jws",
      sha256: "a".repeat(64),
      sizeBytes: 20,
      contentType: "application/octet-stream",
    },
    {
      name: "installer.exe",
      sha256: "c".repeat(64),
      sizeBytes: 30,
      contentType: "application/octet-stream",
    },
  ],
  evidence: { kind: "standalone", manifestName: "manifest.jws" },
};
describe("catalog derived identity", () => {
  it.each([
    [
      { product: "standalone", channel: "stable", version: "1.0.0" },
      "manifest.jws",
      "/standalone/stable/1.0.0/manifest.jws",
    ],
    [
      { product: "station", channel: "beta", version: "2.4.0-beta.5" },
      "latest.json",
      "/station/beta/releases/2.4.0-beta.5/latest.json",
    ],
    [
      { product: "handheld", channel: "stable", version: "1.7.0" },
      "manifest.json",
      "/handheld/stable/releases/1.7.0/manifest.json",
    ],
    [
      { product: "signer", channel: "stable", version: "1.0.0" },
      "installer.exe",
      "/signer/stable/releases/1.0.0/installer.exe",
    ],
  ])("derives the exact existing URL %j", (identity, name, path) =>
    expect(derivePublicPath(identity, name)).toBe(path),
  );
  it("stages only inside the declared product and exact UUID", () => {
    expect(deriveUploadKey("standalone", id, "manifest.jws")).toBe(
      "standalone/_uploads/3890cfde-dec7-44fe-885e-b7b4444db6b9/manifest.jws",
    );
    for (const name of ["../file", "%2f", "a\\b", "file?x"])
      expect(() => deriveUploadKey("standalone", id, name)).toThrow();
    expect(() => deriveUploadKey("standalone", "../x", "file")).toThrow();
    expect(() => deriveUploadKey("_publication-ledger", id, "file")).toThrow();
  });
  it("rejects rather than normalizes a noncanonical path or unrecognized identity", () => {
    expect(() =>
      derivePublicPath({ ...request.identity, version: "1.0.0/../2.0.0" }, "file"),
    ).toThrow();
    expect(() =>
      derivePublicPath({ ...request.identity, product: "Standalone" }, "file"),
    ).toThrow();
    expect(() => derivePublicPath(request.identity, "%2e%2e")).toThrow();
  });
  it("canonicalizes property and file order without mutating the request", () => {
    const original = structuredClone(request);
    const first = canonicalPublicationDigest(request);
    const reordered = {
      evidence: { manifestName: "manifest.jws", kind: "standalone" },
      files: [...request.files].reverse(),
      sourceSha: request.sourceSha,
      identity: { version: "1.0.0", channel: "stable", product: "standalone" },
    };
    expect(canonicalPublicationDigest(reordered)).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(request).toEqual(original);
  });
  it("binds all semantic fields, not just a version label", () => {
    const first = canonicalPublicationDigest(request);
    const originalFile = request.files[0];
    if (!originalFile) throw new Error("fixture absent");
    for (const delta of [
      { sha256: "d".repeat(64) },
      { sizeBytes: 21 },
      { contentType: "application/json" },
    ]) {
      expect(
        canonicalPublicationDigest({
          ...request,
          files: [{ ...originalFile, ...delta }, ...request.files.slice(1)],
        }),
      ).not.toBe(first);
    }
    for (const changed of [
      { ...request, sourceSha: "d".repeat(40) },
      { ...request, identity: { ...request.identity, channel: "beta" } },
      { ...request, identity: { ...request.identity, version: "1.0.1" } },
      { ...request, evidence: { ...request.evidence, manifestName: "installer.exe" } },
      { ...request, files: request.files.slice(0, 1) },
    ])
      expect(canonicalPublicationDigest(changed)).not.toBe(first);
  });
  it("refuses unvalidated fields rather than hashing a silently stripped request", () => {
    expect(() => canonicalPublicationDigest({ ...request, versionId: "overwrite" })).toThrow();
  });
});
