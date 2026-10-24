import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { platformCapabilitiesForRole, type PublicationRequest } from "@markiro/platform-contracts";
import { PLATFORM_ACCESS_POLICY } from "../src/platform-auth/platform-access-policy";
import { PlatformStandaloneReleasesController } from "../src/modules/standalone-releases/platform-standalone-releases.controller";
import { STANDALONE_RELEASE_KEYSET } from "../src/modules/standalone-releases/release-trust-keys";
import { standaloneLatestBuildSource } from "../src/modules/standalone-releases/release-runtime";
import { assertProductPublication } from "../src/modules/release-catalog/catalog-product";
import { manifest, KEYSET, release, stranger, sha } from "./support/standalone-releases";
import type { CatalogReadSnapshot } from "../src/modules/release-catalog/catalog-read";
function verify(installer: Buffer, proof: Buffer, keys = KEYSET) {
  const entries = [
    { name: "markiro-standalone-0.4.0-windows-x86_64-setup.exe", bytes: installer },
    { name: "markiro-standalone-0.4.0.update.jws", bytes: proof },
  ];
  const files = new Map(
    entries.map(({ name, bytes }) => [
      name,
      {
        spec: {
          name,
          sha256: sha(bytes),
          sizeBytes: bytes.length,
          contentType: "application/octet-stream" as const,
        },
        sha256: sha(bytes),
        sizeBytes: bytes.length,
        read: async () => bytes,
      },
    ]),
  );
  const request: PublicationRequest = {
    identity: { product: "standalone", channel: "stable", version: "0.4.0" },
    sourceSha: "0123456789abcdef0123456789abcdef01234567",
    files: [...files.values()].map((f) => f.spec),
    evidence: { kind: "standalone", manifestName: entries[1]!.name },
  };
  return assertProductPublication(request, files, keys);
}
describe("standalone canonical verification from full verified catalog leases", () => {
  const refusals: {
    name: string;
    code: string;
    status: number;
    arrange: (installer: Buffer) => Buffer;
    installer?: Buffer;
  }[] = [
    {
      name: "a signature that does not verify",
      code: "standalone_release_manifest_bad_signature",
      status: 422,
      arrange: (installer) =>
        manifest("0.4.0", installer, {}, { kid: release.kid, privateKey: stranger.privateKey }),
    },
    {
      name: "a key the hosts do not know",
      code: "standalone_release_manifest_unknown_key",
      status: 422,
      arrange: (installer) => manifest("0.4.0", installer, {}, stranger),
    },
    {
      name: "a manifest that is not a JWS",
      code: "standalone_release_manifest_malformed",
      status: 422,
      arrange: () => Buffer.from("not a manifest\n"),
    },
    {
      name: "a manifest of another channel",
      code: "standalone_release_manifest_mismatch",
      status: 422,
      arrange: (installer) => manifest("0.4.0", installer, { channel: "beta" }),
    },
    {
      name: "a manifest of another version",
      code: "standalone_release_manifest_mismatch",
      status: 422,
      arrange: (installer) => manifest("0.4.1", installer),
    },
    {
      name: "an installer of another size",
      code: "standalone_release_installer_size_mismatch",
      status: 422,
      arrange: (installer) =>
        manifest("0.4.0", installer, {
          installer: {
            name: "markiro-standalone-0.4.0-windows-x86_64-setup.exe",
            sha256: sha(installer),
            sizeBytes: installer.byteLength + 1,
          },
        }),
    },
    {
      name: "an installer whose bytes the manifest does not sign",
      code: "standalone_release_installer_hash_mismatch",
      status: 422,
      arrange: (installer) =>
        manifest("0.4.0", installer, {
          installer: {
            name: "markiro-standalone-0.4.0-windows-x86_64-setup.exe",
            sha256: "f".repeat(64),
            sizeBytes: installer.byteLength,
          },
        }),
    },
  ];

  for (const c of refusals)
    it(`refuses ${c.name} without changing evidence`, async () => {
      const bytes = Buffer.from("MZ fixture"),
        proof = c.arrange(bytes),
        original = Buffer.from(proof);
      await expect(verify(bytes, proof)).rejects.toMatchObject({
        code: "conflict",
        detail: c.code,
      });
      expect(proof).toEqual(original);
    });
  it("retains ES256 key identity, protocol, minUpgradeFrom and signed pointers", async () => {
    const bytes = Buffer.from("MZ fixture");
    const result = await verify(bytes, manifest("0.4.0", bytes));
    expect(result).toMatchObject({
      product: "standalone",
      kid: "upd-test",
      protocol: 2,
      minProtocol: 1,
      minUpgradeFrom: "0.1.0",
      pointer: { version: "0.4.0", installer: { sha256: sha(bytes) } },
    });
    await expect(
      verify(bytes, manifest("0.4.0", bytes), { keys: [], retiredKids: ["upd-test"] }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});
describe("standalone release access (spec 2026-10-20 §5.5)", () => {
  it("guards every route with standaloneReleases.manage, which only administrators hold", () => {
    for (const method of ["list", "upload", "register", "setLatest"] as const) {
      expect(
        Reflect.getMetadata(
          PLATFORM_ACCESS_POLICY,
          PlatformStandaloneReleasesController.prototype[method],
        ),
        method,
      ).toEqual({ mode: "capabilities", capabilities: ["standaloneReleases.manage"] });
    }
    expect(platformCapabilitiesForRole.platform_admin).toContain("standaloneReleases.manage");
    expect(platformCapabilitiesForRole.support).not.toContain("standaloneReleases.manage");
    expect(platformCapabilitiesForRole.accountant).not.toContain("standaloneReleases.manage");
  });
});

describe("standalone release trust keys", () => {
  it("are exactly the update keys the hosts are built with", () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, "../../standalone/proto/fixtures/trust-keys.json"), "utf8"),
    ) as { update: unknown };
    expect(STANDALONE_RELEASE_KEYSET).toEqual(fixture.update);
  });
});

describe("catalog diagnostics availability", () => {
  it("never reports a cached or mutable S3 version after catalog fencing", async () => {
    let snapshot: CatalogReadSnapshot | null = null;
    const source = standaloneLatestBuildSource({
      readSnapshot: async (path) => {
        expect(path).toBe("/standalone/stable/latest.json");
        return snapshot;
      },
    });
    expect(await source.latestPublishedVersion()).toBeNull();
    const bytes = Buffer.from("MZ fixture"),
      accepted = await verify(bytes, manifest("0.4.0", bytes));
    const pointer = Buffer.from(JSON.stringify(accepted.pointer));
    snapshot = { kind: "pointer", bytes: pointer, sha256: sha(pointer) };
    expect(await source.latestPublishedVersion()).toBe("0.4.0");
    snapshot = null;
    expect(await source.latestPublishedVersion()).toBeNull();
    expect(
      await standaloneLatestBuildSource({
        readSnapshot: async () => {
          throw Error("fenced");
        },
      }).latestPublishedVersion(),
    ).toBeNull();
    expect(await standaloneLatestBuildSource(null).latestPublishedVersion()).toBeNull();
  });
});
