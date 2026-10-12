import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { verifyUsDatasetReferences } from "../src/modules/traceability/demo/us-dataset-reference-verify";
import { specialFixture, specialStores } from "./support/us-dataset-special-fixture";
import { countActualQueries } from "./support/us-dataset-query-counter";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("native reference batches on owned PostgreSQL", () => {
  const harness = specialFixture(base);
  async function installed() {
    const { f, context } = harness;
    const result = await new UsDatasetReferenceSeedStore(f.db).initialize(context);
    const stores = specialStores(f.db);
    return { f, context, result, stores };
  }
  it(
    "counts reused clients once and forwards real driver errors with restoration",
    harness.phase(async () => {
      const { f } = harness;
      const measured = await countActualQueries(f.pool, async () => {
        const first = await f.pool.query<{ n: number }>("SELECT 1::int AS n");
        const second = await f.pool.query<{ n: number }>("SELECT 2::int AS n");
        return [first.rows, second.rows];
      });
      expect(measured.count).toBe(2);
      expect(measured.value).toEqual([[{ n: 1 }], [{ n: 2 }]]);
      const client = await f.pool.connect();
      const original = client.query;
      client.release();
      await expect(
        countActualQueries(f.pool, () => f.pool.query("SELECT 1 / 0")),
      ).rejects.toMatchObject({ code: "22012" });
      expect(client.query).toBe(original);
      expect((await f.pool.query<{ n: number }>("SELECT 3::int AS n")).rows).toEqual([{ n: 3 }]);
    }),
    60_000,
  );
  it(
    "bounds actual reference proof queries and preserves all table hashes",
    harness.phase(async () => {
      const { f, context } = harness;
      await new UsDatasetReferenceSeedStore(f.db).initialize(context);
      const stores = specialStores(f.db);
      const header = await stores.journal.read(context);
      if (!header) throw new Error("Missing reference header");
      const stage = await stores.journal.readStage(context, header.id, "references", "references");
      if (!stage?.receipt) throw new Error("Missing installed reference receipt");
      const receipt = stage.receipt;
      const before = await f.snapshot();
      // Catches a return to per-row authorization/SQL, while measuring the same owned transaction.
      const measured = await countActualQueries(f.pool, () =>
        f.db.transaction((tx) =>
          verifyUsDatasetReferences(tx, context, stage.intent, receipt, stores),
        ),
      );
      console.info(
        `Reference query budget: count=${measured.count} durationMs=${measured.durationMs.toFixed(3)}`,
      );
      expect(await f.snapshot()).toEqual(before);
      expect(measured.count).toBeLessThanOrEqual(32);
    }),
    60_000,
  );
  it(
    "preserves ordinary native projections, requested order and repeated IDs",
    harness.phase(async () => {
      const { f, context, result, stores } = await installed();
      const before = await f.snapshot();
      await f.db.transaction(async (tx) => {
        const { tenantId, actorUserId } = context;
        const partyIds = result.bindings.parties.map((v) => v.id).reverse();
        const locationIds = result.bindings.locations.map((v) => v.id).reverse();
        const productIds = result.bindings.products.map((v) => v.id).reverse();
        for (const ids of [partyIds, locationIds, productIds]) ids.push(ids[0] ?? randomUUID());
        // Catches unordered IN results, accidental de-duplication and divergent response mapping.
        for (const [ids, batch, single] of [
          [
            partyIds,
            stores.master.getPartiesInTransaction.bind(stores.master),
            stores.master.getPartyInTransaction.bind(stores.master),
          ],
          [
            locationIds,
            stores.master.getLocationsInTransaction.bind(stores.master),
            stores.master.getLocationInTransaction.bind(stores.master),
          ],
          [
            productIds,
            stores.catalog.getProductsInTransaction.bind(stores.catalog),
            stores.catalog.getProductInTransaction.bind(stores.catalog),
          ],
          [
            productIds,
            stores.profiles.getProfilesInTransaction.bind(stores.profiles),
            stores.profiles.getProfileInTransaction.bind(stores.profiles),
          ],
        ] as const) {
          const input = [...ids];
          const expected = [];
          for (const id of ids) expected.push(await single(tx, tenantId, actorUserId, id));
          expect(await batch(tx, tenantId, actorUserId, input)).toEqual(expected);
          expect(input).toEqual(ids);
          expect(await batch(tx, tenantId, actorUserId, [])).toEqual([]);
          expect(
            await batch(
              tx,
              tenantId,
              actorUserId,
              Array.from({ length: 256 }, () => ids[0]),
            ),
          ).toHaveLength(256);
        }
      });
      expect(await f.snapshot()).toEqual(before);
    }),
    60_000,
  );
  it(
    "rejects malformed, oversized, missing and foreign IDs without writes",
    harness.phase(async () => {
      const { f, context, result, stores } = await installed();
      const foreign = randomUUID();
      await f.db
        .insert(schema.organization)
        .values({ id: foreign, name: "Synthetic foreign", slug: foreign, createdAt: new Date() });
      const [party] = await f.db
        .insert(schema.traceabilityParties)
        .values({ tenantId: foreign, name: "Synthetic foreign" })
        .returning();
      const [location] = await f.db
        .insert(schema.traceabilityLocations)
        .values({
          tenantId: foreign,
          partyId: party?.id ?? randomUUID(),
          name: "Synthetic foreign",
          businessName: "Synthetic foreign",
          addressKind: "street",
          countryCode: "US",
          roles: ["supplier"],
        })
        .returning();
      const [product] = await f.db
        .insert(schema.products)
        .values({ tenantId: foreign, name: "Synthetic foreign" })
        .returning();
      if (!party || !location || !product) throw new Error("Missing foreign fixture rows");
      const before = await f.snapshot();
      // Catches omitted tenant predicates, silent partial results and relaxed bounded input parsing.
      for (const [batch, ownedId, foreignId, code] of [
        [
          stores.master.getPartiesInTransaction.bind(stores.master),
          result.bindings.parties[0]?.id,
          party.id,
          "party_not_found",
        ],
        [
          stores.master.getLocationsInTransaction.bind(stores.master),
          result.bindings.locations[0]?.id,
          location.id,
          "location_not_found",
        ],
        [
          stores.catalog.getProductsInTransaction.bind(stores.catalog),
          result.bindings.products[0]?.id,
          product.id,
          "product_not_found",
        ],
        [
          stores.profiles.getProfilesInTransaction.bind(stores.profiles),
          result.bindings.products[0]?.id,
          product.id,
          "product_not_found",
        ],
      ] as const) {
        for (const input of [
          null,
          "bad",
          ["bad"],
          [ownedId, null],
          Array.from({ length: 257 }, () => ownedId),
        ])
          await expect(
            f.db.transaction<unknown[]>((tx) =>
              batch(tx, context.tenantId, context.actorUserId, input),
            ),
          ).rejects.toMatchObject({ response: { code: "invalid_master_data" } });
        for (const input of [[ownedId, randomUUID()], [foreignId]])
          await expect(
            f.db.transaction<unknown[]>((tx) =>
              batch(tx, context.tenantId, context.actorUserId, input),
            ),
          ).rejects.toMatchObject({ response: { code } });
      }
      expect(await f.snapshot()).toEqual(before);
    }),
    60_000,
  );
  it.each(["role", "profile"])(
    "reloads current %s authorization even for empty batches",
    harness.phase(async (kind) => {
      const { f, context, stores } = await installed();
      // Catches caches across calls or an early empty-array return before authorization.
      for (const batch of [
        stores.master.getPartiesInTransaction.bind(stores.master),
        stores.master.getLocationsInTransaction.bind(stores.master),
        stores.catalog.getProductsInTransaction.bind(stores.catalog),
        stores.profiles.getProfilesInTransaction.bind(stores.profiles),
      ]) {
        const before = await f.snapshot();
        await expect(
          f.db.transaction(async (tx) => {
            await batch(tx, context.tenantId, context.actorUserId, []);
            if (kind === "role") await tx.update(schema.member).set({ role: "revoked" });
            else await tx.update(schema.traceabilityProfiles).set({ baselineVersion: "invalid" });
            await batch(tx, context.tenantId, context.actorUserId, []);
          }),
        ).rejects.toMatchObject({
          response: {
            code: kind === "role" ? "insufficient_permission" : "traceability_profile_invalid",
          },
        });
        expect(await f.snapshot()).toEqual(before);
      }
    }),
    60_000,
  );
  it(
    "reads same-transaction changes and existing profile defaults/invalid response semantics",
    harness.phase(async () => {
      const { f, context, result, stores } = await installed();
      const partyId = result.bindings.parties[0]?.id;
      const locationId = result.bindings.locations[0]?.id;
      const productId = result.bindings.products[0]?.id;
      if (!partyId || !locationId || !productId) throw new Error("Missing fixture bindings");
      await f.db.transaction(async (tx) => {
        const { tenantId, actorUserId } = context;
        await stores.master.getPartiesInTransaction(tx, tenantId, actorUserId, [partyId]);
        await stores.master.getLocationsInTransaction(tx, tenantId, actorUserId, [locationId]);
        await stores.catalog.getProductsInTransaction(tx, tenantId, actorUserId, [productId]);
        await stores.profiles.getProfilesInTransaction(tx, tenantId, actorUserId, [productId]);
        await tx
          .update(schema.traceabilityParties)
          .set({ notes: "Synthetic fresh" })
          .where(eq(schema.traceabilityParties.id, partyId));
        await tx
          .update(schema.traceabilityLocations)
          .set({ name: "Synthetic fresh" })
          .where(eq(schema.traceabilityLocations.id, locationId));
        await tx
          .update(schema.products)
          .set({ name: "Synthetic fresh" })
          .where(eq(schema.products.id, productId));
        await tx
          .update(schema.productTraceabilityProfiles)
          .set({ brandName: "Synthetic fresh" })
          .where(eq(schema.productTraceabilityProfiles.productId, productId));
        // Catches proof/response caching that hides an own write.
        expect(
          (await stores.master.getPartiesInTransaction(tx, tenantId, actorUserId, [partyId]))[0]
            ?.notes,
        ).toBe("Synthetic fresh");
        expect(
          (
            await stores.master.getLocationsInTransaction(tx, tenantId, actorUserId, [locationId])
          )[0]?.name,
        ).toBe("Synthetic fresh");
        expect(
          (await stores.catalog.getProductsInTransaction(tx, tenantId, actorUserId, [productId]))[0]
            ?.name,
        ).toBe("Synthetic fresh");
        expect(
          (
            await stores.profiles.getProfilesInTransaction(tx, tenantId, actorUserId, [productId])
          )[0]?.brandName,
        ).toBe("Synthetic fresh");
        await tx
          .delete(schema.productTraceabilityProfiles)
          .where(eq(schema.productTraceabilityProfiles.productId, productId));
        expect(
          await stores.profiles.getProfilesInTransaction(tx, tenantId, actorUserId, [productId]),
        ).toEqual([
          await stores.profiles.getProfileInTransaction(tx, tenantId, actorUserId, productId),
        ]);
        expect(
          (
            await stores.profiles.getProfilesInTransaction(tx, tenantId, actorUserId, [productId])
          )[0],
        ).toMatchObject({ revision: 0, productName: "Synthetic fresh" });
      });
      const otherId = result.bindings.products[1]?.id;
      if (!otherId) throw new Error("Missing stored profile");
      await f.db
        .update(schema.productTraceabilityProfiles)
        .set({ ftlSourceUrl: "invalid" })
        .where(eq(schema.productTraceabilityProfiles.productId, otherId));
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) =>
          stores.profiles.getProfilesInTransaction(tx, context.tenantId, context.actorUserId, [
            otherId,
          ]),
        ),
      ).rejects.toMatchObject({ response: { code: "us_database_unavailable" } });
      expect(await f.snapshot()).toEqual(before);
    }),
    60_000,
  );
  it(
    "share-locks all requested products including profile defaults until transaction exit",
    harness.phase(async () => {
      const { f, context, result, stores } = await installed();
      const ids = result.bindings.products
        .slice(0, 2)
        .map((row) => row.id)
        .reverse();
      const missingProfileId = ids[0];
      if (!missingProfileId || ids.length !== 2) throw new Error("Missing lock fixture");
      await f.db
        .delete(schema.productTraceabilityProfiles)
        .where(eq(schema.productTraceabilityProfiles.productId, missingProfileId));
      const before = await f.snapshot();
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached = () => {};
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const running = f.db
        .transaction(async (tx) => {
          const profiles = await stores.profiles.getProfilesInTransaction(
            tx,
            context.tenantId,
            context.actorUserId,
            ids,
          );
          expect(profiles[0]?.revision).toBe(0);
          reached();
          await gate;
        })
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
      try {
        await Promise.race([
          waiting,
          running.then(({ error }) => {
            throw error ?? new Error("Lock transaction ended early");
          }),
        ]);
        // Catches missing product locks, including the otherwise unlocked first profile insertion.
        for (const id of ids) {
          const client = await f.pool.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL lock_timeout = '100ms'");
            await expect(
              client.query("SELECT id FROM products WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
                context.tenantId,
                id,
              ]),
            ).rejects.toMatchObject({ code: "55P03" });
          } finally {
            await client.query("ROLLBACK");
            client.release();
          }
        }
      } finally {
        release();
        await running;
      }
      const outcome = await running;
      if (outcome.error !== undefined) throw outcome.error;
      expect(await f.snapshot()).toEqual(before);
    }),
    60_000,
  );
  it(
    "measures comparable real chain initialization and verification",
    harness.phase(async () => {
      const { f, context } = harness;
      const seed = new UsDatasetRegularSeedStore(f.db);
      const range = { startIndex: 0, count: 1 };
      const initialized = await countActualQueries(f.pool, () => seed.initialize(context, range));
      const before = await f.snapshot();
      const verified = await countActualQueries(f.pool, () => seed.verify(context, range));
      console.info(
        `Native chain0 initialize: count=${initialized.count} durationMs=${initialized.durationMs.toFixed(3)}`,
      );
      console.info(
        `Native chain0 verify: count=${verified.count} durationMs=${verified.durationMs.toFixed(3)}`,
      );
      expect(verified.value).toEqual(initialized.value);
      expect(await f.snapshot()).toEqual(before);
    }),
    60_000,
  );
});
