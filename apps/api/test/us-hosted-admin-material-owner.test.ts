import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { inspect } from "node:util";
import { beforeEach, expect, it, vi } from "vitest";
import {
  assertUsHostedAdminMaterial,
  collectUsHostedAdminMaterial,
  disposeUsHostedAdminMaterial,
  usHostedAdminDatabaseMaterial,
  usHostedAdminSeedStorageMaterial,
} from "../src/deployment/us-hosted-admin-material-owner";

// Isolated unit protocols only; no genuine installed authority is claimed here.
const unit = vi.hoisted(() => ({
  token: Object.freeze({ unitOnly: true }),
  operation: "migrate" as "migrate" | "seed" | "provision",
  live: true,
  buffers: new Map<string, Buffer>(),
  names: [] as string[],
  constructed: 0,
  disposed: false,
  fenced: false,
  failAt: "",
  disposeAtFence: false,
}));
vi.mock("../src/deployment/us-hosted-admin-release", () => ({
  assertUsHostedAdminRelease(value: unknown) {
    if (value !== unit.token || !unit.live) throw Error("unit-private-release-marker");
  },
  usHostedAdminReleaseIdentity(value: unknown) {
    if (value !== unit.token || !unit.live) throw Error("unit-private-release-marker");
    return { operation: unit.operation };
  },
}));
vi.mock("../src/deployment/us-hosted-admin-file-reader", () => ({
  createUsHostedAdminFileReader() {
    unit.constructed++;
    return {
      async read(name: string) {
        unit.names.push(name);
        if (unit.failAt === name) throw Error("unit-private-read-marker");
        const bytes = unit.buffers.get(name);
        if (!bytes) throw Error("unit-private-missing-marker");
        return bytes;
      },
      async assertUnchanged() {
        unit.fenced = true;
        if (unit.disposeAtFence) unit.live = false;
        if (unit.failAt === "fence") throw Error("unit-private-fence-marker");
      },
      dispose() {
        unit.disposed = true;
        for (const buffer of unit.buffers.values()) buffer.fill(0);
      },
    };
  },
}));

beforeEach(() => {
  unit.operation = "migrate";
  unit.live = true;
  unit.constructed = 0;
  unit.disposed = false;
  unit.fenced = false;
  unit.failAt = "";
  unit.disposeAtFence = false;
  unit.names.length = 0;
  unit.buffers.clear();
  const ca = rootCertificates.find((pem) => {
    const x = new X509Certificate(pem);
    return x.ca && Date.parse(x.validFrom) <= Date.now() && Date.parse(x.validTo) >= Date.now();
  });
  if (!ca) throw Error("unit_test_ca_unavailable");
  unit.buffers.set("database-password", Buffer.from("synthetic-unit-password\n"));
  unit.buffers.set("database-ca", Buffer.from(ca));
  unit.buffers.set("storage-ca", Buffer.from(ca));
  unit.buffers.set("storage-access-key", Buffer.from("synthetic-unit-access\n"));
  unit.buffers.set("storage-secret-key", Buffer.from("synthetic-unit-secret\n"));
});

it.each(["migrate", "seed", "provision"] as const)(
  "keeps independent %s material after reader disposal",
  async (operation) => {
    unit.operation = operation;
    const owner = await collectUsHostedAdminMaterial(unit.token);
    expect(unit.fenced).toBe(true);
    expect(unit.disposed).toBe(true);
    expect([...unit.buffers.values()].every((b) => b.every((n) => n === 0))).toBe(true);
    expect(usHostedAdminDatabaseMaterial(owner, unit.token).password).toBe(
      "synthetic-unit-password",
    );
    if (operation === "seed")
      expect(usHostedAdminSeedStorageMaterial(owner, unit.token).accessKey).toBe(
        "synthetic-unit-access",
      );
    else
      expect(() => usHostedAdminSeedStorageMaterial(owner, unit.token)).toThrow(
        "us_hosted_admin_material_invalid",
      );
    expect(unit.names).toEqual(
      operation === "seed"
        ? [
            "database-password",
            "database-ca",
            "storage-access-key",
            "storage-secret-key",
            "storage-ca",
          ]
        : ["database-password", "database-ca"],
    );
    disposeUsHostedAdminMaterial(owner);
    disposeUsHostedAdminMaterial(owner);
    expect(() => assertUsHostedAdminMaterial(owner, unit.token)).toThrow(
      "us_hosted_admin_material_invalid",
    );
  },
);

it("refuses foreign release before constructing a reader and rejects copied owners", async () => {
  await expect(collectUsHostedAdminMaterial({})).rejects.toThrow(
    "us_hosted_admin_material_invalid",
  );
  expect(unit.constructed).toBe(0);
  const owner = await collectUsHostedAdminMaterial(unit.token);
  const copy = Object.freeze({ ...owner });
  for (const value of [copy, {}, null]) {
    expect(() => assertUsHostedAdminMaterial(value, unit.token)).toThrow(
      "us_hosted_admin_material_invalid",
    );
    expect(() => disposeUsHostedAdminMaterial(value)).toThrow("us_hosted_admin_material_invalid");
  }
  expect(() => usHostedAdminDatabaseMaterial(owner, {})).toThrow(
    "us_hosted_admin_material_invalid",
  );
  unit.operation = "seed";
  expect(() => usHostedAdminDatabaseMaterial(owner, unit.token)).toThrow(
    "us_hosted_admin_material_invalid",
  );
  disposeUsHostedAdminMaterial(owner);
});

it.each(["database-ca", "fence"])("wipes partial acquisition after %s failure", async (failure) => {
  unit.failAt = failure;
  await expect(collectUsHostedAdminMaterial(unit.token)).rejects.toThrow(
    "us_hosted_admin_material_invalid",
  );
  expect(unit.disposed).toBe(true);
  expect([...unit.buffers.values()].every((b) => b.every((n) => n === 0))).toBe(true);
});

it("refuses release disposal during the final fence and disposes its reader", async () => {
  unit.disposeAtFence = true;
  await expect(collectUsHostedAdminMaterial(unit.token)).rejects.toThrow(
    "us_hosted_admin_material_invalid",
  );
  expect(unit.disposed).toBe(true);
});

it("redacts handles and projections while preserving private validation", async () => {
  const owner = await collectUsHostedAdminMaterial(unit.token);
  const values = usHostedAdminDatabaseMaterial(owner, unit.token);
  expect(Object.keys(owner)).toHaveLength(0);
  expect(Object.keys(values)).toHaveLength(0);
  expect(JSON.stringify([owner, values])).not.toContain("synthetic-unit-password");
  expect(inspect([owner, values])).not.toContain("synthetic-unit-password");
  unit.live = false;
  expect(() => usHostedAdminDatabaseMaterial(owner, unit.token)).toThrow(
    "us_hosted_admin_material_invalid",
  );
  disposeUsHostedAdminMaterial(owner);
});

it.each(["", "bad\u0000secret", "line\nsecond"])("refuses invalid secret %#", async (value) => {
  unit.buffers.set("database-password", Buffer.from(value));
  await expect(collectUsHostedAdminMaterial(unit.token)).rejects.toThrow(
    "us_hosted_admin_material_invalid",
  );
  expect(unit.disposed).toBe(true);
});

it("rejects malformed and excessive CA bundles without leaked causes", async () => {
  const good = unit.buffers.get("database-ca");
  if (!good) throw Error();
  for (const value of ["private-ca-marker", good.toString().repeat(9)]) {
    unit.buffers.set("database-password", Buffer.from("synthetic-unit-password\n"));
    unit.buffers.set("database-ca", Buffer.from(value));
    try {
      await collectUsHostedAdminMaterial(unit.token);
      throw Error("unexpected_success");
    } catch (error) {
      expect(error).toHaveProperty("message", "us_hosted_admin_material_invalid");
      expect(error).not.toHaveProperty("cause");
      expect(inspect(error)).not.toContain("private-ca-marker");
    }
  }
});

it("rejects malformed UTF8 bytes", async () => {
  unit.buffers.set("database-password", Buffer.from([0xff]));
  await expect(collectUsHostedAdminMaterial(unit.token)).rejects.toThrow(
    "us_hosted_admin_material_invalid",
  );
});
