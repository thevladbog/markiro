import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, schema } from "@markiro/db";
import {
  renderUnmanagedTenantsReport,
  reportUnmanagedTenants,
} from "../src/cli/report-unmanaged-tenants";

const ready = Boolean(process.env.DATABASE_URL);

describe.skipIf(!ready)("unmanaged tenant reconciliation report", () => {
  const connection = createDb(process.env.DATABASE_URL!);

  afterAll(async () => {
    await connection.pool.end();
  });

  it("lists stable tenant identifiers in slug order without owner or activation data", async () => {
    const suffix = randomUUID();
    const ownerId = randomUUID();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const email = `report-owner-${suffix}@example.com`;
    const activationMarker = `activation-${randomUUID()}`;
    await connection.db.insert(schema.user).values({
      id: ownerId,
      email,
      name: "Report owner",
      emailVerified: false,
    });
    await connection.db.insert(schema.organization).values([
      {
        id: tenantB,
        name: "Report B",
        slug: `report-b-${suffix}`,
        createdAt: new Date(),
        metadata: activationMarker,
      },
      {
        id: tenantA,
        name: "Report A",
        slug: `report-a-${suffix}`,
        createdAt: new Date(),
      },
    ]);
    await connection.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenantB,
      userId: ownerId,
      role: "owner",
      createdAt: new Date(),
    });

    const report = await reportUnmanagedTenants(connection.db);
    const selectedIds = new Set<string>([tenantA, tenantB]);
    const selected = report.tenants.filter((tenant) => selectedIds.has(tenant.tenantId));
    expect(selected).toEqual([
      {
        tenantId: tenantA,
        tenantName: "Report A",
        tenantSlug: `report-a-${suffix}`,
        subscriptionState: "unmanaged",
      },
      {
        tenantId: tenantB,
        tenantName: "Report B",
        tenantSlug: `report-b-${suffix}`,
        subscriptionState: "unmanaged",
      },
    ]);
    const output = renderUnmanagedTenantsReport({ tenants: selected });
    expect(JSON.parse(output)).toEqual({ tenants: selected });
    expect(output).not.toContain(email);
    expect(output).not.toContain(activationMarker);
    expect(Object.keys(selected[0]!).sort()).toEqual([
      "subscriptionState",
      "tenantId",
      "tenantName",
      "tenantSlug",
    ]);

    await connection.db.delete(schema.organization).where(eq(schema.organization.id, tenantA));
    await connection.db.delete(schema.organization).where(eq(schema.organization.id, tenantB));
    await connection.db.delete(schema.user).where(eq(schema.user.id, ownerId));
  });
});
