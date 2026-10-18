// Runs only inside the task-owned API container, with synthetic seed input mounted read-only.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const require = createRequire("/app/package.json");
const { createDb, schema } = require("@markiro/db");
const { eq } = require("drizzle-orm");
const { hashPassword } = await import(require.resolve("better-auth/crypto"));
const input = JSON.parse(readFileSync("/load-private/seed.json", "utf8"));
const { db, pool } = createDb(process.env.DATABASE_URL);
try {
  const password = await hashPassword(input.password);
  for (const u of input.users) {
    await db
      .insert(schema.platformUsers)
      .values({ ...u, role: "platform_admin", status: "active", emailVerified: true });
    await db.insert(schema.platformAccounts).values({
      id: randomUUID(),
      accountId: u.id,
      userId: u.id,
      providerId: "credential",
      password,
    });
  }
  const itemId = randomUUID(),
    versionId = randomUUID();
  await db.insert(schema.catalogItems).values({
    id: itemId,
    code: "synthetic-load-plan",
    nameRu: "Synthetic load plan",
    nameEn: "Synthetic load plan",
    kind: "plan",
    offlineAvailable: true,
  });
  await db.insert(schema.catalogItemVersions).values({
    id: versionId,
    catalogItemId: itemId,
    kind: "plan",
    version: 1,
    nameRu: "Synthetic load plan",
    nameEn: "Synthetic load plan",
    unit: "month",
    billingMode: "recurring",
    billingPeriod: "month",
    unitPrice: "1000.00",
    vatRate: "20.00",
    vatIncluded: true,
  });
  await db.insert(schema.planEntitlements).values({
    catalogVersionId: versionId,
    maxLines: 2,
    maxStations: 3,
    maxKiosks: 0,
    maxCabinetUsers: 5,
  });
  await db
    .update(schema.catalogItemVersions)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(schema.catalogItemVersions.id, versionId));
  for (let i = 0; i < input.tenants.length; i++) {
    const id = input.tenants[i];
    await db.insert(schema.organization).values({
      id,
      name: `Synthetic factory ${i}`,
      slug: `synthetic-${i}`,
      cabinetAccess: "none",
      createdAt: new Date(),
    });
    await db.insert(schema.orgProfiles).values({ tenantId: id, inn: "7707083893" });
    await db.insert(schema.tenantSubscriptions).values({
      id: randomUUID(),
      tenantId: id,
      planVersionId: versionId,
      status: "active",
      startsAt: new Date(Date.now() - 60000),
      endsAt: new Date(Date.now() + 86400000 * 90),
      source: "manual",
    });
    // Seed dated commercial facts; no customer/production data is imported.
    await db.insert(schema.platformAgreements).values(
      Array.from({ length: 30 }, (_, day) => ({
        id: randomUUID(),
        number: `SYNTHETIC-${i}-${day}`,
        status: "signed",
        tenantId: id,
        counterparty: { name: "Synthetic" },
        contractor: { name: "Synthetic" },
        terms: { synthetic: true },
        signedAt: new Date(Date.now() - day * 86400000),
        signedSnapshot: { synthetic: true },
        createdByPlatformUserId: input.users[0].id,
      })),
    );
  }
  console.log(
    JSON.stringify({
      users: input.users.length,
      tenants: input.tenants.length,
      agreements: input.tenants.length * 30,
    }),
  );
} finally {
  await pool.end();
}
