import { describe, expect, it } from "vitest";

import {
  STANDALONE_RELEASE_ERROR_CODES,
  platformStandaloneReleaseContracts,
  standaloneInstallerFileName,
  standaloneLatestPointerSchema,
  standaloneManifestFileName,
  standaloneReleaseObjectKey,
  standaloneReleaseVersionSchema,
} from "../src/index.js";

const SHA = "a".repeat(64);
const pointer = {
  v: 1,
  product: "markiro-standalone",
  channel: "stable",
  version: "0.4.0",
  releasedAt: "2026-11-02T10:00:00Z",
  installer: {
    url: "https://releases.markiro.app/standalone/stable/0.4.0/markiro-standalone-0.4.0-windows-x86_64-setup.exe",
    sha256: SHA,
    sizeBytes: 61_234_567,
  },
  manifestUrl:
    "https://releases.markiro.app/standalone/stable/0.4.0/markiro-standalone-0.4.0.update.jws",
  notes: ["Первая публичная версия"],
};

describe("standalone release contracts (spec 2026-10-20 §5)", () => {
  it("names the release files and their immutable keys as the spec lays them out", () => {
    expect(standaloneInstallerFileName("0.4.0")).toBe(
      "markiro-standalone-0.4.0-windows-x86_64-setup.exe",
    );
    expect(standaloneManifestFileName("0.4.0")).toBe("markiro-standalone-0.4.0.update.jws");
    expect(standaloneReleaseObjectKey("stable", "0.4.0", "release.json")).toBe(
      "standalone/stable/0.4.0/release.json",
    );
  });

  it("accepts only the manifest's x.y.z versions", () => {
    for (const version of ["0.4.0", "10.0.12", "999999999.0.0"])
      expect(standaloneReleaseVersionSchema.safeParse(version).success, version).toBe(true);
    for (const version of ["0.4", "01.0.0", "0.4.0-beta.1", "../0.4.0", "0.4.0/", ""])
      expect(standaloneReleaseVersionSchema.safeParse(version).success, version).toBe(false);
  });

  it("reads latest.json exactly in the shape of §5.3", () => {
    expect(standaloneLatestPointerSchema.parse(pointer)).toEqual(pointer);
    expect(standaloneLatestPointerSchema.safeParse({ ...pointer, extra: 1 }).success).toBe(false);
    expect(standaloneLatestPointerSchema.safeParse({ ...pointer, product: "other" }).success).toBe(
      false,
    );
    expect(
      standaloneLatestPointerSchema.safeParse({
        ...pointer,
        installer: { ...pointer.installer, sha256: "A".repeat(64) },
      }).success,
    ).toBe(false);
  });

  it("asks for a channel and a version, nothing the client could forge", () => {
    expect(
      platformStandaloneReleaseContracts.upload.body.safeParse({
        channel: "stable",
        version: "0.4.0",
      }).success,
    ).toBe(true);
    expect(
      platformStandaloneReleaseContracts.upload.body.safeParse({
        channel: "stable",
        version: "0.4.0",
        sha256: SHA,
      }).success,
    ).toBe(false);
    expect(
      platformStandaloneReleaseContracts.register.body.safeParse({
        channel: "nightly",
        version: "0.4.0",
      }).success,
    ).toBe(false);
    expect(
      platformStandaloneReleaseContracts.setLatest.params.safeParse({ channel: "beta" }).success,
    ).toBe(true);
  });

  it("tells an unconfigured section apart from a configured one", () => {
    expect(platformStandaloneReleaseContracts.list.response.parse({ configured: false })).toEqual({
      configured: false,
    });
    expect(
      platformStandaloneReleaseContracts.list.response.safeParse({
        configured: true,
        publicOrigin: "https://releases.markiro.app",
        channels: [
          { channel: "stable", latest: null, latestReadable: true, releases: [], pending: [] },
        ],
      }).success,
    ).toBe(true);
  });

  it("keeps the error codes unique and namespaced", () => {
    expect(new Set(STANDALONE_RELEASE_ERROR_CODES).size).toBe(
      STANDALONE_RELEASE_ERROR_CODES.length,
    );
    for (const code of STANDALONE_RELEASE_ERROR_CODES) expect(code).toMatch(/^standalone_release/);
  });
});
