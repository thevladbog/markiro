import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror.js";
import {
  createCredentialGeneration,
  sealCredentialGeneration,
} from "../src/lib/credential-recovery.js";
import {
  loadOrganizationBranding,
  refreshOrganizationBranding,
  type OrganizationBrandingOwner,
} from "../src/lib/organization-branding.js";
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const revision = "a1111111-1111-4111-8111-111111111111";
const bitmap = { width: 4, height: 1, stride: 1, pixels: Uint8Array.of(128) };
const none = { organizationName: "Plant", logoRevision: null, logoUrl: null, logo: null };
const ports = { decodeLogo: vi.fn(async () => bitmap), loadMarkiroLogo: vi.fn(async () => bitmap) };
async function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const exec: SqlExecutor = {
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    all: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as never[])) as T[],
  };
  await applyMigrations(exec);
  const get = vi.fn<(path: string) => Promise<unknown>>().mockResolvedValue(none),
    download = vi.fn(async () => new Blob());
  const generation = createCredentialGeneration("test-branding-key");
  const owner: OrganizationBrandingOwner = {
    exec,
    client: { get, download },
    tenantId: "tenant",
    generation,
    isCurrent: () => true,
  };
  return { db, exec, get, download, generation, owner };
}
async function configured() {
  const blob = new Blob([Uint8Array.of(1, 2, 3)], { type: "image/webp" });
  const checksum = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  return {
    blob,
    descriptor: {
      organizationName: "Plant",
      logoRevision: revision,
      logoUrl: `/station/branding/logo/${revision}`,
      logo: { contentType: "image/webp", byteSize: blob.size, checksum, width: 4, height: 1 },
    },
  };
}
it("uses bundled Markiro only for explicit absence and reloads a complete cache offline", async () => {
  const h = await fixture();
  await refreshOrganizationBranding(h.owner, ports);
  const cached = await loadOrganizationBranding({
    ...h.owner,
    generation: createCredentialGeneration("test-branding-key"),
  });
  expect(cached).toMatchObject({
    tenantId: "tenant",
    organizationName: "Plant",
    logoRevision: null,
    logo: { source: "markiro", width: 4, height: 1 },
  });
  expect(h.download).not.toHaveBeenCalled();
  expect(await loadOrganizationBranding({ ...h.owner, tenantId: "other" })).toBeNull();
  expect(
    await loadOrganizationBranding({
      ...h.owner,
      generation: createCredentialGeneration("other-key"),
    }),
  ).toBeNull();
});
it("keeps the last complete company logo if a newer configured revision fails; deletion is explicit", async () => {
  const h = await fixture(),
    { blob, descriptor } = await configured();
  h.get.mockResolvedValue(descriptor);
  h.download.mockResolvedValue(blob);
  await refreshOrganizationBranding(h.owner, ports);
  const saved = await loadOrganizationBranding(h.owner);
  expect(saved?.logo).toMatchObject({ source: "organization", revision, width: 4, height: 1 });
  h.download.mockRejectedValue(new Error("offline"));
  h.get.mockResolvedValue({ ...descriptor, organizationName: "New name" });
  await expect(refreshOrganizationBranding(h.owner, ports)).rejects.toThrow();
  expect(await loadOrganizationBranding(h.owner)).toEqual(saved);
  h.get.mockResolvedValue(none);
  await refreshOrganizationBranding(h.owner, ports);
  expect((await loadOrganizationBranding(h.owner))?.logo.source).toBe("markiro");
  expect(saved?.logo.source).toBe("organization");
});
it("does not publish a fallback for a configured logo before its first successful download", async () => {
  const h = await fixture(),
    { descriptor } = await configured();
  h.get.mockResolvedValue(descriptor);
  h.download.mockRejectedValue(new Error("offline"));
  await expect(refreshOrganizationBranding(h.owner, ports)).rejects.toThrow();
  expect(await loadOrganizationBranding(h.owner)).toBeNull();
});
it("discards a late download after credential sealing", async () => {
  const h = await fixture(),
    { blob, descriptor } = await configured();
  h.get.mockResolvedValue(descriptor);
  let resolve: (blob: Blob) => void = () => {};
  const pending = new Promise<Blob>((r) => {
    resolve = r;
  });
  h.download.mockReturnValue(pending);
  const refreshing = refreshOrganizationBranding(h.owner, ports);
  await vi.waitFor(() => expect(h.download).toHaveBeenCalled());
  await sealCredentialGeneration(h.generation);
  resolve(blob);
  await refreshing;
  expect(h.db.prepare("SELECT * FROM station_organization_branding").all()).toEqual([]);
});
it("rejects wrong source digest and corruption without replacing the last complete row", async () => {
  const h = await fixture();
  await refreshOrganizationBranding(h.owner, ports);
  const before = h.db.prepare("SELECT snapshot_json FROM station_organization_branding").get();
  const { blob, descriptor } = await configured();
  h.get.mockResolvedValue({
    ...descriptor,
    logo: { ...descriptor.logo, checksum: "0".repeat(64) },
  });
  h.download.mockResolvedValue(blob);
  await expect(refreshOrganizationBranding(h.owner, ports)).rejects.toThrow();
  expect(h.db.prepare("SELECT snapshot_json FROM station_organization_branding").get()).toEqual(
    before,
  );
  h.db
    .prepare(
      "UPDATE station_organization_branding SET snapshot_json=json_set(snapshot_json,'$.organizationName','Corrupt')",
    )
    .run();
  await expect(loadOrganizationBranding(h.owner)).rejects.toThrow();
});
