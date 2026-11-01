import { expect, it, vi } from "vitest";
import { UsHostedReleaseFiles } from "../src/deployment/us-hosted-release-files";
import {
  assertUsHostedAdminRelease,
  disposeUsHostedAdminRelease,
  usHostedAdminReleaseIdentity,
  verifyUsHostedAdminRelease,
} from "../src/deployment/us-hosted-admin-release";
import { assertUsHostedRelease } from "../src/deployment/us-hosted-release-verifier";

it("refuses structural, copied and unverified administrative facts at every accessor", () => {
  for (const value of [
    null,
    undefined,
    {},
    Object.freeze({ operation: "migrate", disposed: false }),
    Object.freeze({
      manifest: {},
      descriptorDigest: "a".repeat(64),
      inventoryDigest: "b".repeat(64),
    }),
  ]) {
    expect(() => assertUsHostedAdminRelease(value)).toThrow("us_hosted_admin_release_invalid");
    expect(() => usHostedAdminReleaseIdentity(value)).toThrow("us_hosted_admin_release_invalid");
    expect(() => disposeUsHostedAdminRelease(value)).toThrow("us_hosted_admin_release_invalid");
    expect(() => assertUsHostedRelease(value)).toThrow("us_hosted_release_invalid");
  }
});

it("rejects an invalid operation before any protected acquisition", async () => {
  const read = vi.spyOn(UsHostedReleaseFiles.prototype, "read");
  try {
    for (const operation of [null, undefined, "api", "seed\n", {}])
      await expect(
        Reflect.apply(verifyUsHostedAdminRelease, undefined, [operation]),
      ).rejects.toThrow("us_hosted_admin_release_invalid");
    expect(read).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
  }
});

it.each(["migrate", "seed", "provision"] as const)(
  "requires actual protected installation for %s and disposes its reader on failure",
  async (operation) => {
    const dispose = vi.spyOn(UsHostedReleaseFiles.prototype, "dispose");
    try {
      expect(verifyUsHostedAdminRelease.length).toBe(1);
      await expect(verifyUsHostedAdminRelease(operation)).rejects.toThrow(
        "us_hosted_admin_release_invalid",
      );
      expect(dispose).toHaveBeenCalled();
    } finally {
      dispose.mockRestore();
    }
  },
);
