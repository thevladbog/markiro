import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KEYSET, manifest as signedManifest } from "./support/standalone-releases";
import type { PublicationRequest } from "@markiro/platform-contracts";
import { stationAssetNames } from "@markiro/release-validation";
import {
  assertProductPublication,
  assertStationPromotion,
} from "../src/modules/release-catalog/catalog-product";
import type { VerifiedInputFile } from "../src/modules/release-catalog/catalog-types";
const hash = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
function fixture() {
  const apk = Buffer.from("verified APK bytes");
  const manifest = {
    versionName: "1.7.0",
    versionCode: 16,
    sha256: hash(apk),
    bytes: apk.length,
    url: "https://releases.markiro.app/handheld/stable/releases/1.7.0/markiro-tsd-1.7.0.apk",
    notes: "Update",
    releasedAt: "2026-10-24T12:00:00Z",
    sourceSha: "a".repeat(40),
  };
  const files = new Map<string, VerifiedInputFile>();
  for (const [name, bytes, contentType] of [
    ["manifest.json", Buffer.from(JSON.stringify(manifest)), "application/json"],
    ["markiro-tsd-1.7.0.apk", apk, "application/vnd.android.package-archive"],
  ] as const) {
    const spec = { name, sha256: hash(bytes), sizeBytes: bytes.length, contentType };
    files.set(name, {
      spec,
      sha256: spec.sha256,
      sizeBytes: spec.sizeBytes,
      read: async () => bytes,
    });
  }
  const request: PublicationRequest = {
    identity: { product: "handheld", channel: "stable", version: "1.7.0" },
    sourceSha: manifest.sourceSha,
    files: [...files.values()].map((f) => f.spec),
    evidence: { kind: "handheld", manifestName: "manifest.json", versionCode: 16 },
  };
  return { files, request, manifest };
}
describe("verified product acceptance", () => {
  it("uses the existing handheld manifest and exact APK digest/size", async () => {
    const f = fixture();
    const accepted = await assertProductPublication(f.request, f.files);
    expect(accepted.pointer).toEqual(f.manifest);
    expect(accepted.versionCode).toBe(16);
  });
  it.each(["source", "hash", "missing", "extra", "code"])(
    "refuses %s disagreement before registration",
    async (what) => {
      const f = fixture();
      if (what === "source") f.request.sourceSha = "b".repeat(40);
      if (what === "code")
        f.request.evidence = { kind: "handheld", manifestName: "manifest.json", versionCode: 17 };
      if (what === "missing") f.files.delete("markiro-tsd-1.7.0.apk");
      const apk = f.files.get("markiro-tsd-1.7.0.apk");
      if (apk && what === "hash") f.files.set(apk.spec.name, { ...apk, sha256: "c".repeat(64) });
      if (apk && what === "extra") f.files.set("extra", apk);
      await expect(assertProductPublication(f.request, f.files)).rejects.toMatchObject({
        code: "conflict",
      });
    },
  );
});

describe("standalone signature and byte acceptance", () => {
  function standalone() {
    const version = "1.0.0",
      installerName = `markiro-standalone-${version}-windows-x86_64-setup.exe`,
      manifestName = `markiro-standalone-${version}.update.jws`;
    const installer = Buffer.from("installer");
    const bytes = new Map([
      [installerName, installer],
      [manifestName, signedManifest(version, installer)],
    ]);
    const files = new Map<string, VerifiedInputFile>(
      [...bytes].map(([name, b]) => {
        const spec = {
          name,
          sha256: hash(b),
          sizeBytes: b.length,
          contentType: "application/octet-stream" as const,
        };
        return [name, { spec, sha256: spec.sha256, sizeBytes: b.length, read: async () => b }];
      }),
    );
    const request: PublicationRequest = {
      identity: { product: "standalone", channel: "stable", version },
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
      files: [...files.values()].map((f) => f.spec),
      evidence: { kind: "standalone", manifestName },
    };
    return { request, files, installerName, manifestName };
  }
  it("derives public links only from a trusted ES256 manifest and matching installer", async () => {
    const f = standalone();
    const checked = await assertProductPublication(f.request, f.files, KEYSET);
    expect(checked).toMatchObject({
      product: "standalone",
      version: "1.0.0",
      protocol: 2,
      minProtocol: 1,
      minUpgradeFrom: "0.1.0",
      pointer: {
        manifestUrl: `https://releases.markiro.app/standalone/stable/1.0.0/${f.manifestName}`,
        installer: {
          url: `https://releases.markiro.app/standalone/stable/1.0.0/${f.installerName}`,
        },
      },
    });
    await expect(assertProductPublication(f.request, f.files)).rejects.toMatchObject({
      code: "conflict",
    });
  });
  it("rejects retired signing key and installer different from the signed facts", async () => {
    const f = standalone();
    await expect(
      assertProductPublication(f.request, f.files, { ...KEYSET, retiredKids: ["upd-test"] }),
    ).rejects.toMatchObject({ code: "conflict" });
    const installer = f.files.get(f.installerName);
    if (!installer) throw new Error();
    const spec = { ...installer.spec, sha256: "f".repeat(64) };
    f.files.set(f.installerName, { ...installer, spec, sha256: spec.sha256 });
    f.request.files = f.request.files.map((s) => (s.name === f.installerName ? spec : s));
    await expect(assertProductPublication(f.request, f.files, KEYSET)).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

it("Station accepts canonical full evidence and refuses forged product provenance", async () => {
  const version = "1.0.0-beta.1",
    names = stationAssetNames(version),
    publishedAt = "2026-08-11T12:00:00.000Z",
    sourceSha = "a".repeat(40);
  const manifest = {
    version,
    pub_date: publishedAt,
    platforms: {
      "windows-x86_64": {
        url: `https://releases.markiro.app/station/beta/releases/${version}/${names.bundle}`,
        signature: "fixture-signature",
      },
    },
  };
  const bytes = new Map([
    [names.installer, Buffer.from("installer")],
    [names.bundle, Buffer.from("bundle")],
    [names.signature, Buffer.from("fixture-signature")],
    [names.manifest, Buffer.from(JSON.stringify(manifest))],
  ]);
  const assets = Object.fromEntries([...bytes].map(([name, b]) => [name, hash(b)]));
  bytes.set(
    names.checksums,
    Buffer.from(
      Object.entries(assets)
        .map(([name, h]) => `${h}  ${name}\n`)
        .join(""),
    ),
  );
  bytes.set(names.notes, Buffer.from("Release notes"));
  const evidence = {
    schemaVersion: 2,
    channel: "beta",
    version,
    publishedAt,
    baseSha: sourceSha,
    releaseSha: "b".repeat(40),
    assets,
    distribution: {
      origin: "yandex",
      channelUrl: "https://releases.markiro.app/station/beta/latest.json",
      releaseBaseUrl: `https://releases.markiro.app/station/beta/releases/${version}`,
    },
  };
  bytes.set(names.evidence, Buffer.from(JSON.stringify(evidence)));
  const files = new Map<string, VerifiedInputFile>(
    [...bytes].map(([name, b]) => {
      const spec = {
        name,
        sha256: hash(b),
        sizeBytes: b.length,
        contentType: "application/octet-stream" as const,
      };
      return [name, { spec, sha256: spec.sha256, sizeBytes: b.length, read: async () => b }];
    }),
  );
  const publication: PublicationRequest = {
    identity: { product: "station", channel: "beta", version },
    sourceSha: evidence.releaseSha,
    files: [...files.values()].map((f) => f.spec),
    evidence: {
      kind: "station",
      manifestName: "latest.json",
      evidenceName: "release-evidence.json",
    },
  };
  const result = await assertProductPublication(publication, files);
  expect(result.pointer).toEqual(manifest);
  expect(result.sourceSha).toBe(evidence.releaseSha);
  await expect(
    assertProductPublication({ ...publication, sourceSha: evidence.baseSha }, files),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    assertProductPublication({ ...publication, sourceSha: "c".repeat(40) }, files),
  ).rejects.toMatchObject({ code: "conflict" });
  const stableNames = stationAssetNames("1.0.0"),
    betaHashes = new Map([...bytes].map(([n, b]) => [n, hash(b)])),
    stableHashes = new Map<string, string>();
  for (const kind of ["installer", "bundle", "signature"] as const) {
    const value = betaHashes.get(names[kind]);
    if (!value) throw new Error();
    stableHashes.set(stableNames[kind], value);
  }
  const stable = {
    ...result,
    version: "1.0.0",
    evidence: {
      baseSha: sourceSha,
      betaVersion: version,
      betaReleaseSha: evidence.releaseSha,
      betaEvidenceSha256: betaHashes.get(names.evidence),
    },
  };
  expect(() => assertStationPromotion(stable, result, stableHashes, betaHashes)).not.toThrow();
  stableHashes.set(stableNames.bundle, "c".repeat(64));
  expect(() => assertStationPromotion(stable, result, stableHashes, betaHashes)).toThrow();
});
