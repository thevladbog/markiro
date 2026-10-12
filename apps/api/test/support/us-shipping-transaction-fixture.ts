import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createDb, schema } from "@markiro/db";
import type { ShippingDraft } from "@markiro/platform-contracts";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { UsReceivingStore } from "../../src/modules/traceability/receiving/us-receiving-store";
import { UsShippingStore } from "../../src/modules/traceability/shipping/us-shipping-draft";
import { seedCompleteReceiving } from "./us-receiving-fixture";
import type { UsMasterDataTransaction } from "../../src/modules/traceability/master-data/us-master-data-support";
import { seedFinalizableTransformation } from "./us-transformation-finalization-fixture";
import type { OwnCleanup } from "./us-transformation-lock-fixture";

export function shippingConnection(
  f: ShippingTransactionFixture,
  own: OwnCleanup,
  name: string,
): ReturnType<typeof createDb> {
  const base = process.env.US_TEST_DATABASE_URL;
  if (!base) throw new Error("Missing isolated US database");
  const url = new URL(base);
  url.pathname = `/${f.databaseName}`;
  const connection = createDb(url.toString(), { max: 1, connectionTimeoutMillis: 5000 });
  own(`end-${name}`, () => connection.pool.end());
  return connection;
}

/** Test-only caller lifetime: reject cancelled work before committing its transaction. */
export function runShippingNative<T>(
  connection: ReturnType<typeof createDb>,
  signal: AbortSignal,
  run: (tx: UsMasterDataTransaction) => Promise<T>,
): Promise<T> {
  return connection.db.transaction(
    async (tx) => {
      signal.throwIfAborted();
      const result = await run(tx);
      signal.throwIfAborted();
      return result;
    },
    { isolationLevel: "repeatable read" },
  );
}

export type ShippingTransactionFixture = ReturnType<typeof createDb> & {
  databaseName: string;
  close(): Promise<void>;
  snapshot(): Promise<Record<string, string>>;
};

/** Every connection and disposal target belongs to this invocation's child. */
export async function createUsShippingTransactionFixture(
  base: string,
  initialize?: (child: ReturnType<typeof createDb>, databaseName: string) => Promise<void>,
): Promise<ShippingTransactionFixture> {
  const url = new URL(base);
  if (
    url.protocol !== "postgres:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== "55432" ||
    url.pathname !== "/markiro_us_dev" ||
    url.username !== "markiro_us" ||
    url.search ||
    url.hash
  )
    throw new Error("Shipping tests require the isolated US loopback database");
  const admin = createDb(base);
  const databaseName = `markiro_us_shipping_${randomUUID().replaceAll("-", "_")}`;
  url.pathname = `/${databaseName}`;
  const child = createDb(url.toString());
  let created = false;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    try {
      await child.pool.end();
    } catch (error) {
      failures.push(error);
    }
    try {
      if (created) {
        await admin.pool.query(`DROP DATABASE "${databaseName}"`);
        const absent = await admin.pool.query("SELECT datname FROM pg_database WHERE datname=$1", [
          databaseName,
        ]);
        if (absent.rowCount !== 0) throw new Error("shipping_fixture_disposal_failed");
        console.info(`Disposed owned Shipping database verified absent: ${databaseName}`);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        await admin.pool.end();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "shipping_fixture_cleanup_failed");
  }
  try {
    const identity = await admin.pool.query<{ name: string; owner: string }>(
      "SELECT current_database() AS name,current_user AS owner",
    );
    if (identity.rows[0]?.name !== "markiro_us_dev" || identity.rows[0]?.owner !== "markiro_us")
      throw new Error("shipping_fixture_identity_mismatch");
    await admin.pool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    console.info(`Owned Shipping database: ${databaseName}`);
    await migrate(child.db, { migrationsFolder: resolve("../../packages/db/migrations") });
    await initialize?.(child, databaseName);
    return {
      ...child,
      databaseName,
      close,
      async snapshot() {
        const tables = await child.pool.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
        );
        const statements = tables.rows.map(({ tablename }) => {
          if (!/^[a-z_][a-z0-9_]*$/.test(tablename))
            throw new Error("shipping_fixture_table_invalid");
          return `SELECT '${tablename}' AS name,coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS body FROM "${tablename}" t`;
        });
        // One statement gives a consistent snapshot of ALL persisted public tables.
        const result = await child.pool.query<{ name: string; body: unknown }>(
          statements.join(" UNION ALL "),
        );
        return Object.fromEntries(
          result.rows.map(({ name, body }) => [
            name,
            createHash("sha256").update(JSON.stringify(body)).digest("hex"),
          ]),
        );
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      // Preserve the actual setup failure; never replace it with cleanup failure.
      console.error(
        "Owned Shipping cleanup failed after setup failure",
        databaseName,
        cleanupError,
      );
    }
    throw error;
  }
}

export type ShippingFailureBoundary =
  | "counter"
  | "draft_audit"
  | "create_operation"
  | "item_snapshot"
  | "status_effect"
  | "finalize_audit"
  | "finalize_operation";

/** Explicit SQLSTATE injections, not evidence of induced serialization/deadlocks. */
export async function withShippingFailure(
  f: ShippingTransactionFixture,
  tenant: string,
  boundary: ShippingFailureBoundary,
  code: "40001" | "40P01",
  run: (attempts: () => Promise<number>) => Promise<void>,
  failAttempts = 2147483647,
) {
  const name = `shipping_failure_${randomUUID().replaceAll("-", "")}`;
  const sequence = `${name}_attempts`;
  const table = {
    counter: "shipping_counters",
    draft_audit: "tenant_audit_events",
    create_operation: "shipping_operations",
    item_snapshot: "shipping_event_items",
    status_effect: "shipping_lot_status_effects",
    finalize_audit: "tenant_audit_events",
    finalize_operation: "shipping_operations",
  }[boundary];
  const predicate =
    boundary === "draft_audit" || boundary === "finalize_audit"
      ? `NEW.organization_id='${tenant}' AND NEW.action='traceability.shipping.${boundary === "draft_audit" ? "draft_created" : "finalized"}'`
      : `NEW.tenant_id='${tenant}'${boundary === "create_operation" ? " AND NEW.command='shipping.create'" : boundary === "finalize_operation" ? " AND NEW.command='shipping.finalize'" : boundary === "item_snapshot" ? " AND NEW.tlc_snapshot IS NOT NULL" : ""}`;
  let primary: { error: unknown } | undefined;
  let sequenceCreated = false;
  let functionCreated = false;
  let triggerCreated = false;
  const cleanupFailures: unknown[] = [];
  try {
    await f.pool.query(`CREATE SEQUENCE ${sequence}`);
    sequenceCreated = true;
    await f.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF nextval('${sequence}') <= ${failAttempts} THEN
        RAISE EXCEPTION USING MESSAGE='owned_shipping_injection', ERRCODE='${code}';
      END IF; RETURN NEW; END $$`);
    functionCreated = true;
    await f.pool.query(
      `CREATE TRIGGER ${name} BEFORE ${boundary === "item_snapshot" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW WHEN (${predicate}) EXECUTE FUNCTION ${name}()`,
    );
    triggerCreated = true;
    await run(async () => {
      const result = await f.pool.query<{ n: string; called: boolean }>(
        `SELECT last_value::text AS n,is_called AS called FROM ${sequence}`,
      );
      return result.rows[0]?.called ? Number(result.rows[0].n) : 0;
    });
  } catch (error) {
    primary = { error };
  } finally {
    for (const command of [
      ...(triggerCreated ? [`DROP TRIGGER ${name} ON ${table}`] : []),
      ...(functionCreated ? [`DROP FUNCTION ${name}()`] : []),
      ...(sequenceCreated ? [`DROP SEQUENCE ${sequence}`] : []),
    ]) {
      try {
        await f.pool.query(command);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  }
  if (primary) {
    if (cleanupFailures.length)
      console.error(
        "Shipping trigger cleanup failed after original failure",
        name,
        cleanupFailures,
      );
    throw primary.error;
  }
  if (cleanupFailures.length)
    throw new AggregateError(cleanupFailures, "shipping_trigger_cleanup_failed");
}

/** Real finalized Receiving provides exactly 100 cases of the linked lot. */
export async function seedShippingOrigin(fixture: ShippingTransactionFixture) {
  const c = await seedCompleteReceiving(fixture.db);
  await fixture.db
    .update(schema.traceabilityLocations)
    .set({ roles: ["receive_at", "ship_from", "tlc_source"] })
    .where(eq(schema.traceabilityLocations.id, c.location));
  await fixture.db
    .update(schema.productTraceabilityProfiles)
    .set({
      coverageStatus: "covered",
      ftlCategory: "Fresh-cut fruits",
      ftlSourceUrl:
        "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
      ftlSourceVersion: "Synthetic 2026",
    })
    .where(eq(schema.productTraceabilityProfiles.productId, c.product));
  const recipient = randomUUID();
  await fixture.db.insert(schema.traceabilityLocations).values({
    id: recipient,
    tenantId: c.tenant,
    partyId: c.party,
    name: "Recipient",
    businessName: "Synthetic buyer",
    phoneNumber: "+1 555 010 0200",
    streetAddress: "2 Test Street",
    city: "Chicago",
    stateOrRegion: "IL",
    zipOrPostalCode: "60601",
    countryCode: "US",
    roles: ["recipient"],
  });
  const linked = c.draft.items[1];
  if (!linked) throw new Error("Missing linked Receiving origin");
  linked.quantity = "100";
  linked.unitOfMeasure = "case";
  const receiving = new UsReceivingStore(fixture.db);
  const draft = await receiving.createDraft(
    c.tenant,
    c.actor,
    { operationKey: randomUUID(), draft: c.draft },
    "shipping-origin-create",
  );
  const ready = await receiving.checkReadiness(c.tenant, c.actor, draft.id, {
    expectedDraftVersion: 1,
  });
  if (ready.state !== "complete") throw new Error("Receiving origin incomplete");
  const origin = await receiving.finalize(
    c.tenant,
    c.actor,
    draft.id,
    { operationKey: randomUUID(), expectedDraftVersion: 1, expectedInputDigest: ready.inputDigest },
    "shipping-origin-finalize",
  );
  const shippingDraft: ShippingDraft = {
    eventDate: "2026-09-27",
    shipFromLocationId: c.location,
    recipientLocationId: recipient,
    carrierReference: "Synthetic Truck 1",
    notes: null,
    items: [{ lotId: c.lot, quantity: "20", unitOfMeasure: "case" }],
    documentIds: [c.document],
  };
  return { ...c, origin, recipient, shippingDraft, store: new UsShippingStore(fixture.db) };
}

/** The 100-case output is created by actual Transformation finalization. */
export async function seedTransformationShippingOrigin(f: ShippingTransactionFixture) {
  const c = await seedFinalizableTransformation(f);
  const origin = await c.store.finalize(
    c.tenant,
    c.actor,
    c.saved.id,
    c.command,
    "shipping-transformation-origin",
  );
  const lot = origin.snapshot.outputs[0]?.lotId;
  if (!lot) throw new Error("Missing actual Transformation output lot");
  await f.db
    .update(schema.traceabilityLocations)
    .set({ roles: ["processor", "ship_from", "tlc_source"] })
    .where(eq(schema.traceabilityLocations.id, c.processor));
  await f.db
    .update(schema.traceabilityLocations)
    .set({ roles: ["receive_at", "recipient", "tlc_source"] })
    .where(eq(schema.traceabilityLocations.id, c.location));
  const shippingDraft: ShippingDraft = {
    eventDate: "2026-09-27",
    shipFromLocationId: c.processor,
    recipientLocationId: c.location,
    carrierReference: "Synthetic Truck 2",
    notes: null,
    items: [{ lotId: lot, quantity: "20", unitOfMeasure: "case" }],
    documentIds: [c.document],
  };
  return {
    ...c,
    lot,
    origin,
    recipient: c.location,
    shippingDraft,
    store: new UsShippingStore(f.db),
    transformation: c.store,
  };
}
