import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, schema, type Db } from "@markiro/db";
import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NationalCatalogJobRepository } from "../src/modules/national-catalog/national-catalog-job-repository";
import { newRefreshCheckpoint } from "../src/modules/national-catalog/national-catalog-refresh-state";
import { createOrganization } from "./support/subscription-fixtures";

function localDispatchDatabaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    url.pathname.length <= 1 ||
    url.search !== ""
  )
    throw Error("Requires a local PostgreSQL test database");
  return url;
}
it("accepts portable CI/local URLs and rejects external/query overrides without connecting", () => {
  expect(
    localDispatchDatabaseUrl("postgres://markiro:markiro@localhost:5432/markiro").pathname,
  ).toBe("/markiro");
  expect(localDispatchDatabaseUrl("postgresql://test@127.0.0.1/test_nc").pathname).toBe("/test_nc");
  for (const url of [
    "postgres://host.invalid/db",
    "postgres://localhost/db?host=remote.invalid",
    "https://localhost/db",
    "postgres://localhost/",
  ])
    expect(() => localDispatchDatabaseUrl(url)).toThrow();
});
describe.skipIf(!process.env.DATABASE_URL)("National Catalog durable repair PostgreSQL", () => {
  let maintenance: ReturnType<typeof createDb> | undefined;
  const name = `markiro_nc_dispatch_${randomUUID().replaceAll("-", "_")}`;
  let connection: ReturnType<typeof createDb> | undefined;
  let created = false;
  let db: Db;
  let repository: NationalCatalogJobRepository;
  const actorId = randomUUID();
  const workIds: string[] = [];
  beforeAll(async () => {
    const value = process.env.DATABASE_URL;
    if (!value) throw Error("Missing local test database");
    const url = localDispatchDatabaseUrl(value);
    maintenance = createDb(url.toString());
    await maintenance.pool.query(`CREATE DATABASE "${name}"`);
    created = true;
    url.pathname = `/${name}`;
    connection = createDb(url.toString());
    db = connection.db;
    await migrate(db, { migrationsFolder: join(__dirname, "../../../packages/db/migrations") });
    repository = new NationalCatalogJobRepository(db);
    await db.insert(schema.user).values({
      id: actorId,
      name: "Dispatch fixture",
      email: `${actorId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }, 120000);
  afterAll(async () => {
    try {
      await connection?.pool.end();
    } finally {
      try {
        if (created && maintenance) await maintenance.pool.query(`DROP DATABASE "${name}"`);
      } finally {
        await maintenance?.pool.end();
      }
    }
  });
  async function seed(tenantId: string, at = new Date(Date.now() - 3600000)) {
    const id = randomUUID();
    const stepId = randomUUID();
    await db.insert(schema.nationalCatalogImportSessions).values({
      id,
      tenantId,
      actorId,
      environment: "production",
      mode: "gtins",
      startedAt: at,
      throughAt: at,
      expiresAt: new Date(Date.now() + 86400000),
      checkpoint: {
        version: 1,
        stepId,
        runId: null,
        phase: "primary",
        work: [{ kind: "gtins", gtins: ["04601234567893"] }],
        failures: [],
        attempts: 0,
        state: "pending",
        nextRetryAt: null,
        enqueuePending: true,
      },
    });
    workIds.push(id);
    return { id, stepId };
  }
  it("rotates beyond100 tenants after a claim/send crash and across new arrivals", async () => {
    for (let i = 0; i < 105; i++) await seed(await createOrganization(db));
    const first = await repository.claim();
    expect(first).toHaveLength(100);
    const second = await repository.claim();
    expect(new Set([...first, ...second].map((j) => j.tenantId)).size).toBe(105);
    const old = first[0];
    if (!old) throw Error("missing old work");
    await seed(old.tenantId, new Date());
    const third = await repository.claim();
    const fourth = await repository.claim();
    expect([...third, ...fourth].some((j) => j.workId === old.workId)).toBe(true);
    const states = await db
      .select({ checkpoint: schema.nationalCatalogImportSessions.checkpoint })
      .from(schema.nationalCatalogImportSessions)
      .where(inArray(schema.nationalCatalogImportSessions.id, workIds));
    expect(
      states.every(
        (s) =>
          !!s.checkpoint &&
          typeof s.checkpoint === "object" &&
          "enqueuePending" in s.checkpoint &&
          s.checkpoint.enqueuePending === true,
      ),
    ).toBe(true);
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ state: "cancelled" })
      .where(inArray(schema.nationalCatalogImportSessions.id, workIds));
  });
  it("excludes live lease/future recovery and reclaims same step without resetting attempts", async () => {
    const tenantId = await createOrganization(db);
    const { id, stepId } = await seed(tenantId);
    await db.insert(schema.nationalCatalogRequestLeases).values({
      tenantId,
      owner: randomUUID(),
      fence: 1n,
      leaseUntil: new Date(Date.now() + 60000),
      nextAllowedAt: new Date(),
    });
    expect((await repository.claim()).some((j) => j.workId === id)).toBe(false);
    await db
      .update(schema.nationalCatalogRequestLeases)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.nationalCatalogRequestLeases.tenantId, tenantId));
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({
        checkpoint: sql`checkpoint || jsonb_build_object('state','started','attempts',2,'runId',${randomUUID()}::text,'nextRetryAt',${new Date(Date.now() + 60000).toISOString()}::text)`,
      })
      .where(eq(schema.nationalCatalogImportSessions.id, id));
    expect((await repository.claim()).some((j) => j.workId === id)).toBe(false);
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({
        checkpoint: sql`checkpoint || jsonb_build_object('nextRetryAt',${new Date(Date.now() - 1000).toISOString()}::text)`,
      })
      .where(eq(schema.nationalCatalogImportSessions.id, id));
    expect((await repository.claim()).find((j) => j.workId === id)).toMatchObject({
      kind: "enumerate",
      stepId,
    });
    const [row] = await db
      .select()
      .from(schema.nationalCatalogImportSessions)
      .where(eq(schema.nationalCatalogImportSessions.id, id));
    expect(row?.checkpoint).toMatchObject({ attempts: 2, enqueuePending: true });
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ state: "cancelled" })
      .where(eq(schema.nationalCatalogImportSessions.id, id));
  });
  it("rotates kinds within a tenant and excludes closed links", async () => {
    const tenantId = await createOrganization(db);
    const session = await seed(tenantId);
    const productId = randomUUID();
    const linkId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      name: "Dispatch product",
      gtin14: "04601234567893",
      boxCapacity: 1,
      palletCapacity: 1,
      status: "active",
    });
    const cp = newRefreshCheckpoint(
      {
        linkId,
        revision: 1,
        cardId: "1",
        environment: "production",
        boundGtin14: "04601234567893",
      },
      { kind: "system" },
    );
    await db.insert(schema.nationalCatalogProductLinks).values({
      id: linkId,
      tenantId,
      productId,
      cardId: "1",
      boundGtin14: "04601234567893",
      environment: "production",
      confirmedBy: actorId,
      refreshCheckpoint: cp,
    });
    const first = await repository.claim(1);
    const second = await repository.claim(1);
    expect(new Set([...first, ...second].map((j) => j.kind))).toEqual(
      new Set(["enumerate", "refresh"]),
    );
    await db
      .update(schema.nationalCatalogProductLinks)
      .set({ closedAt: new Date(), closedBy: actorId, closedReason: "manual" })
      .where(eq(schema.nationalCatalogProductLinks.id, linkId));
    expect((await repository.claim()).some((j) => j.workId === linkId)).toBe(false);
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ state: "cancelled" })
      .where(eq(schema.nationalCatalogImportSessions.id, session.id));
  });
  it("repairs preparation/candidate and accepted failed-due image independently of provider leases and TTL", async () => {
    const tenantId = await createOrganization(db);
    const session = await seed(tenantId);
    const itemId = randomUUID();
    const previewId = randomUUID();
    const candidateId = randomUUID();
    const imageId = randomUUID();
    const preparationId = randomUUID();
    const operationId = randomUUID();
    const productOperationId = randomUUID();
    const productId = randomUUID();
    const stepId = randomUUID();
    const cp = {
      version: 1,
      stepId,
      runId: null,
      attempts: 2,
      enqueuePending: true,
      nextRetryAt: new Date(Date.now() - 1000).toISOString(),
    };
    await db
      .insert(schema.nationalCatalogImportItems)
      .values({ id: itemId, tenantId, sessionId: session.id, match: "new", selectable: true });
    await db.insert(schema.nationalCatalogImportPreviews).values({
      id: previewId,
      tenantId,
      sessionId: session.id,
      itemId,
      sourceHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60000),
    });
    await db.insert(schema.nationalCatalogImportPreparations).values({
      id: preparationId,
      tenantId,
      sessionId: session.id,
      actorId,
      requestId: randomUUID(),
      requestHash: "b".repeat(64),
      request: {},
      checkpoint: cp,
      expiresAt: new Date(Date.now() + 60000),
    });
    await db.insert(schema.nationalCatalogImportImages).values({
      id: imageId,
      tenantId,
      sessionId: session.id,
      previewId,
      candidateId,
      sourceHash: "a".repeat(64),
      expiresAt: new Date(Date.now() + 60000),
      preparationCheckpoint: cp,
      preparationActorId: actorId,
    });
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, name: "Accepted", gtin14: "04601234567893" });
    await db.insert(schema.nationalCatalogImportOperations).values(
      [operationId, productOperationId].map((id) => ({
        id,
        tenantId,
        sessionId: session.id,
        actorId,
        requestId: randomUUID(),
        decisionHash: "a".repeat(64),
      })),
    );
    await db.insert(schema.nationalCatalogImportOperationItems).values([
      {
        tenantId,
        sessionId: session.id,
        operationId,
        previewId,
        decision: {},
        productId,
        productResult: "applied",
        imageResult: "failed",
        acceptedImageId: imageId,
        imageRetryEligible: true,
        imageAttempts: 2,
        nextImageAttemptAt: new Date(Date.now() - 1000),
      },
      {
        tenantId,
        sessionId: session.id,
        operationId: productOperationId,
        previewId,
        decision: {},
        productResult: "pending",
      },
    ]);
    const first = await repository.claim();
    expect(new Set(first.filter((j) => j.tenantId === tenantId).map((j) => j.kind))).toEqual(
      new Set(["enumerate", "prepare", "candidate", "apply", "accepted_image"]),
    );
    await db.insert(schema.nationalCatalogRequestLeases).values({
      tenantId,
      owner: randomUUID(),
      fence: 1n,
      leaseUntil: new Date(Date.now() + 60000),
      nextAllowedAt: new Date(),
    });
    await db
      .update(schema.nationalCatalogImportSessions)
      .set({ startedAt: new Date(Date.now() - 86400000), expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.nationalCatalogImportSessions.id, session.id));
    const local = await repository.claim();
    expect(new Set(local.filter((j) => j.tenantId === tenantId).map((j) => j.kind))).toEqual(
      new Set(["apply", "accepted_image"]),
    );
    await db
      .update(schema.nationalCatalogImportOperations)
      .set({ state: "cancelled", cancelledAt: new Date() })
      .where(eq(schema.nationalCatalogImportOperations.tenantId, tenantId));
    expect((await repository.claim()).some((j) => j.tenantId === tenantId)).toBe(false);
  });
  it("skips a concurrent dispatcher lock immediately without consuming source work", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('national-catalog-dispatch',0))`,
      );
      expect(await repository.claim()).toEqual([]);
    });
  });
});
