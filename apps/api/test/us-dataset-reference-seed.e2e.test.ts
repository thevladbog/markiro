import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type TestContext,
} from "vitest";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import {
  parseUsDatasetReferenceResult,
  type UsDatasetReferenceResult,
} from "../src/modules/traceability/demo/us-dataset-reference-contract";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsDemoReferenceSeedStore } from "../src/modules/traceability/demo/us-demo-reference-seed";
import type { UsDatasetContext } from "../src/modules/traceability/demo/us-dataset-contract";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { makeUsSixMonthCatalogue } from "../src/modules/traceability/demo/us-six-month-references";
import { UsMasterDataStore } from "../src/modules/traceability/master-data/us-master-data-store";
import { UsCatalogStore } from "../src/modules/traceability/catalog/us-catalog-store";
import { UsProductProfileStore } from "../src/modules/traceability/products/us-product-profile-store";
import { UsReferenceDocumentStore } from "../src/modules/traceability/documents/us-reference-document-store";
import { UsProfileStore } from "../src/modules/traceability/profile/us-profile-store";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const catalogue = makeUsSixMonthCatalogue();
const input = {
  version: usSixMonthDefinition.version,
  definitionDigest: usSixMonthDefinition.digest,
  catalogue,
};
const partyKeys = [
  "previous_source",
  "processor",
  "recipient",
  ...Array.from({ length: 9 }, (_, i) => `supplier_${String(i + 2).padStart(2, "0")}`),
  ...Array.from({ length: 11 }, (_, i) => `recipient_${String(i + 2).padStart(2, "0")}`),
];
const productKeys = [
  "inbound",
  "output",
  ...["inbound", "output"].flatMap((kind) =>
    Array.from({ length: 7 }, (_, i) => `${kind}_${String(i + 2).padStart(2, "0")}`),
  ),
];
function mutableResult(result: UsDatasetReferenceResult) {
  return { ...result, bindings: { ...result.bindings }, evidence: { ...result.evidence } };
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
function withLockTestLifecycle(test: TestContext, run: (signal: AbortSignal) => Promise<void>) {
  const pending = Promise.resolve().then(() => run(test.signal));
  // A timed-out body must finish releasing its gate before the next fixture TRUNCATE.
  test.onTestFinished(async () => {
    await pending.catch(() => {});
  });
  return pending;
}

function startAbortObservation(
  test: Pick<TestContext, "signal" | "onTestFinished">,
  work: (signal: AbortSignal, ready: () => Promise<void>) => Promise<void>,
) {
  const abort = new AbortController();
  const signal = AbortSignal.any([test.signal, abort.signal]);
  let announce = () => {};
  let release = () => {};
  const announced = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const observation = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = Promise.resolve()
    .then(() =>
      work(signal, async () => {
        announce();
        await observation;
      }),
    )
    .then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
  const cleanup = async () => {
    abort.abort(new Error("abort_observation_cleanup"));
    release();
    await running;
  };
  // Register before the queued work begins: Vitest can finish a timed-out test
  // without awaiting its body, so normal finally alone cannot protect fixture reset.
  test.onTestFinished(cleanup);
  const ready = abortable(
    Promise.race([
      announced,
      running.then(({ error }) => {
        throw error ?? new Error("worker_finished_before_readiness");
      }),
    ]),
    signal,
  );
  return { abort, ready, running, cleanup };
}

describe.skipIf(!base)("six-month reference seed on owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let context: UsDatasetContext;
  let seed: UsDatasetReferenceSeedStore;
  let journal: UsDatasetJournalStore;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    f = await createUsDatasetJournalFixture(base);
    console.info(`Owned six-month reference database: ${f.databaseName}`);
  }, 60_000);
  beforeEach(async () => {
    context = await f.provision();
    seed = new UsDatasetReferenceSeedStore(f.db);
    journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  async function capture() {
    const header = await journal.initialize(context);
    const stage = await journal.captureIntent(context, header.id, {
      unitKey: "references",
      stage: "references",
      operationKey: randomUUID(),
      input,
      inputDigest: canonicalExportDigest(input),
    });
    return { header, stage };
  }
  async function readStage() {
    const header = await journal.read(context);
    if (!header) throw new Error("missing dataset header");
    const stage = await journal.readStage(context, header.id, "references", "references");
    if (!stage) throw new Error("missing reference stage");
    return stage;
  }
  async function denied(action: () => Promise<unknown>, code: string) {
    const before = await f.snapshot();
    await expect(action()).rejects.toThrow(code);
    expect(await f.snapshot()).toEqual(before);
  }
  async function mismatch() {
    for (const action of [() => seed.verify(context), () => seed.initialize(context)]) {
      const before = await f.snapshot();
      await expect(action()).rejects.toMatchObject({
        message: "us_dataset_reference_mismatch",
        unitKey: "references",
        stage: "references",
      });
      expect(await f.snapshot()).toEqual(before);
    }
  }
  async function writeResult(result: UsDatasetReferenceResult, recordIds?: readonly string[]) {
    await f.db.update(schema.traceabilityDemoDatasetStages).set({
      receipt: {
        result,
        resultDigest: canonicalExportDigest(result),
        recordIds:
          recordIds ??
          [
            ...result.bindings.parties,
            ...result.bindings.locations,
            ...result.bindings.products,
          ].map(({ id }) => id),
      },
    });
  }
  async function assertInstalled(result: UsDatasetReferenceResult) {
    expect(parseUsDatasetReferenceResult(result)).toEqual(result);
    expect(result.bindings.parties.map(({ key }) => key)).toEqual(partyKeys);
    expect(result.bindings.locations.map(({ key }) => key)).toEqual(partyKeys);
    expect(result.bindings.products.map(({ key }) => key)).toEqual(productKeys);
    expect(result.evidence.profiles).toHaveLength(16);
    const stage = await readStage();
    expect(stage.intent.input).toEqual(input);
    expect(stage.revision).toBe(2);
    expect(stage.receipt?.recordIds).toEqual(
      [...result.bindings.parties, ...result.bindings.locations, ...result.bindings.products].map(
        ({ id }) => id,
      ),
    );
    expect(new Set(stage.receipt?.recordIds).size).toBe(62);
    expect(stage.receipt?.resultDigest).toBe(canonicalExportDigest(result));
    expect(Buffer.byteLength(JSON.stringify(stage.receipt?.result))).toBeLessThan(256 * 1024);
    for (const [i, party] of result.evidence.parties.entries())
      expect(party).toMatchObject({
        ...catalogue.parties[i]?.input,
        archived: false,
        updatedAt: party.createdAt,
      });
    for (const [i, location] of result.evidence.locations.entries()) {
      const item = catalogue.locations[i];
      if (!item) throw new Error("missing catalogue location");
      expect(location).toMatchObject({
        ...item.input,
        partyId: result.bindings.parties.find(({ key }) => key === item.partyKey)?.id,
        archived: false,
        updatedAt: location.createdAt,
        descriptionStatus: { exportReady: true, issues: [] },
      });
    }
    for (const [i, product] of result.evidence.products.entries())
      expect(product).toEqual({
        id: result.bindings.products[i]?.id,
        name: catalogue.products[i]?.input.name,
        gtin14: null,
        archived: false,
        createdAt: product.createdAt,
        updatedAt: product.createdAt,
      });
    for (const [i, profile] of result.evidence.profiles.entries()) {
      const command = catalogue.products[i]?.profile;
      if (!command) throw new Error("missing catalogue profile");
      const { expectedRevision: _revision, ...editable } = command;
      void _revision;
      expect(profile).toEqual({
        ...editable,
        packagingSizeValue: `${command.packagingSizeValue}.000`,
        productId: result.bindings.products[i]?.id,
        revision: 1,
        reviewedBy: context.actorUserId,
        reviewedAt: profile.createdAt,
        createdAt: profile.createdAt,
        updatedAt: profile.createdAt,
      });
      expect(Date.parse(profile.createdAt ?? "")).toBeGreaterThan(
        Date.parse("2026-09-30T23:59:59Z"),
      );
    }
    const expected = [
      ...result.evidence.parties.map((after) => ({
        action: "traceability.party.created",
        targetType: "traceability_party",
        targetId: after.id,
        before: null,
        after,
      })),
      ...result.evidence.locations.map(({ descriptionStatus: _status, ...after }) => {
        void _status;
        return {
          action: "traceability.location.created",
          targetType: "traceability_location",
          targetId: after.id,
          before: null,
          after,
        };
      }),
      ...result.evidence.products.map((after) => ({
        action: "traceability.product.created",
        targetType: "traceability_product",
        targetId: after.id,
        before: null,
        after,
      })),
      ...result.evidence.profiles.flatMap((after) =>
        [
          "traceability.product_profile.updated",
          "traceability.product_profile.coverage_changed",
        ].map((action) => ({
          action,
          targetType: "traceability_product_profile",
          targetId: after.productId,
          after,
          before: {
            productId: after.productId,
            productName: after.productName,
            revision: 0,
            brandName: null,
            commodity: null,
            variety: null,
            packagingSizeValue: null,
            packagingSizeUom: null,
            packagingStyle: null,
            defaultQuantityUom: null,
            coverageStatus: "unknown",
            coverageRationale: null,
            ftlCategory: null,
            ftlSourceUrl: null,
            ftlSourceVersion: null,
            reviewedBy: null,
            reviewedAt: null,
            createdAt: null,
            updatedAt: null,
          },
        })),
      ),
    ].map((row) => ({
      ...row,
      organizationId: context.tenantId,
      actorUserId: context.actorUserId,
      outcome: "success",
      requestId: stage.intent.operationKey,
    }));
    const audits = (await f.db.select().from(schema.tenantAuditEvents)).filter(
      ({ action }) =>
        action.startsWith("traceability.") && !action.startsWith("traceability.profile."),
    );
    expect(audits).toHaveLength(94);
    expect(
      audits.map(
        ({
          organizationId,
          actorUserId,
          action,
          outcome,
          targetType,
          targetId,
          requestId,
          before,
          after,
        }) => ({
          organizationId,
          actorUserId,
          action,
          outcome,
          targetType,
          targetId,
          requestId,
          before,
          after,
        }),
      ),
    ).toEqual(expect.arrayContaining(expected));
    for (const audit of audits)
      expect(audit.createdAt.getTime()).toBeGreaterThan(Date.parse("2026-09-30T23:59:59Z"));
    for (const [table, count] of [
      ["traceability_parties", 23],
      ["traceability_locations", 23],
      ["products", 16],
      ["product_traceability_profiles", 16],
      ["reference_documents", 0],
      ["traceability_demo_seeds", 0],
      ["traceability_demo_dataset_stages", 1],
    ] as const)
      expect((await f.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n).toBe(
        count,
      );
  }
  it("installs the exact catalogue, native stamps and all 94 audit facts; fresh-store lost-reply replay changes no row", async () => {
    const first = await seed.initialize(context);
    await assertInstalled(first);
    const before = await f.snapshot();
    expect(await new UsDatasetReferenceSeedStore(f.db).verify(context)).toEqual(first);
    expect(await new UsDatasetReferenceSeedStore(f.db).initialize(context)).toEqual(first);
    expect(await f.snapshot()).toEqual(before);
    console.info(`Six-month reference result bytes: ${Buffer.byteLength(JSON.stringify(first))}`);
  });
  it("overlapping initializers adopt only the winning canonical intent", async () => {
    const results = await Promise.all([
      seed.initialize(context),
      new UsDatasetReferenceSeedStore(f.db).initialize(context),
      new UsDatasetReferenceSeedStore(f.db).initialize(context),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual(results[2]);
    if (!results[0]) throw new Error("missing concurrent result");
    await assertInstalled(results[0]);
  });
  it("verify never creates a header or captures/applies pending intent", async () => {
    await denied(() => seed.verify(context), "us_dataset_references_incomplete");
    await journal.initialize(context);
    await denied(() => seed.verify(context), "us_dataset_references_incomplete");
    await capture();
    await denied(() => seed.verify(context), "us_dataset_references_incomplete");
  });
  async function independentReferences(
    signal: AbortSignal,
    afterLocked?: (pid: number) => Promise<void>,
  ) {
    const first = await seed.initialize(context);
    const independent = await new UsMasterDataStore(f.db).createParty(
      context.tenantId,
      context.actorUserId,
      { name: "Independent synthetic party" },
      randomUUID(),
    );
    const independentLocation = await new UsMasterDataStore(f.db).createLocation(
      context.tenantId,
      context.actorUserId,
      { ...catalogue.locations[0]?.input, partyId: independent.id },
      randomUUID(),
    );
    const independentProduct = await new UsCatalogStore(f.db).createProduct(
      context.tenantId,
      context.actorUserId,
      { name: "Independent synthetic product", gtin: null },
      randomUUID(),
    );
    await new UsProductProfileStore(f.db).putProfile(
      context.tenantId,
      context.actorUserId,
      independentProduct.id,
      catalogue.products[0]?.profile,
      randomUUID(),
    );
    await new UsReferenceDocumentStore(f.db).createDocument(
      context.tenantId,
      context.actorUserId,
      {
        type: "invoice",
        number: "SYNTHETIC-LATER",
        issuedOn: "2026-04-01",
        partyId: independent.id,
        typeOtherLabel: null,
        notes: null,
      },
      randomUUID(),
    );
    signal.throwIfAborted();
    const client = await f.pool.connect();
    const pending: Promise<unknown>[] = [];
    const wait = <T>(query: Promise<T>) => {
      pending.push(query);
      return abortable(query, signal);
    };
    try {
      await wait(client.query("BEGIN"));
      await wait(client.query("SET LOCAL statement_timeout='5s'"));
      await wait(
        client.query(
          "SELECT id FROM traceability_parties WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
          [context.tenantId, independent.id],
        ),
      );
      await wait(
        client.query(
          "SELECT id FROM traceability_locations WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
          [context.tenantId, independentLocation.id],
        ),
      );
      await wait(
        client.query("SELECT id FROM products WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [
          context.tenantId,
          independentProduct.id,
        ]),
      );
      const pid = (await wait(client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")))
        .rows[0]?.pid;
      if (!pid) throw new Error("Missing owned gate PID");
      await abortable(afterLocked?.(pid) ?? Promise.resolve(), signal);
      const before = await wait(f.snapshot());
      expect(await wait(seed.verify(context))).toEqual(first);
      expect(await wait(seed.initialize(context))).toEqual(first);
      expect(await wait(f.snapshot())).toEqual(before);
    } finally {
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release(true);
        await Promise.allSettled(pending);
      }
    }
  }
  it("allows independent later references without locking them or changing owned evidence", async (test) => {
    await withLockTestLifecycle(test, (signal) => independentReferences(signal));
  });

  it.for(["failure", "cancellation"] as const)(
    "settles pre-barrier %s in the abort regression harness and drains owned work",
    async (mode, test) => {
      const testAbort = new AbortController();
      let releaseSetup = () => {};
      let entered = () => {};
      let rescueReady: (() => Promise<void>) | undefined;
      let finish: (() => Promise<void>) | undefined;
      let drained = false;
      let registeredBeforeWork = false;
      let pid = 0;
      const setup = new Promise<void>((resolve) => {
        releaseSetup = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const failure = new Error(`pre_barrier_${mode}`);
      const observation = startAbortObservation(
        {
          signal: AbortSignal.any([test.signal, testAbort.signal]),
          onTestFinished: (cleanup) => {
            finish = async () => {
              await cleanup(test);
            };
            test.onTestFinished(cleanup);
          },
        },
        async (signal, ready) => {
          registeredBeforeWork = finish !== undefined;
          rescueReady = ready;
          const client = await f.pool.connect();
          try {
            await client.query("BEGIN");
            pid =
              (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
                ?.pid ?? 0;
            entered();
            if (mode === "failure") throw failure;
            await abortable(setup, signal);
          } finally {
            try {
              await client.query("ROLLBACK");
            } finally {
              client.release(true);
              drained = true;
            }
          }
        },
      );
      let settled = false;
      const readiness = observation.ready
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        )
        .then((result) => {
          settled = true;
          return result;
        });
      try {
        await abortable(started, test.signal);
        if (mode === "cancellation") testAbort.abort(failure);
        await expect.poll(() => settled, { timeout: 500 }).toBe(true);
        expect((await readiness).error).toBe(failure);
        expect(registeredBeforeWork).toBe(true);
        await finish?.();
        expect(drained).toBe(true);
        expect((await observation.running).error).toBe(failure);
        expect(pid).toBeGreaterThan(0);
        expect(
          (
            await f.pool.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=$1",
              [pid],
            )
          ).rows[0]?.n,
        ).toBe(0);
      } finally {
        // Recover the intentionally broken RED without leaving pending DB work.
        observation.abort.abort(failure);
        releaseSetup();
        const rescued = rescueReady?.();
        await observation.cleanup();
        await rescued;
        await readiness;
      }
    },
  );

  it("releases independent reference locks when an observation is aborted", async (test) => {
    let settled = false;
    let gatePid = 0;
    const observation = startAbortObservation(test, (signal, ready) =>
      independentReferences(signal, async (pid) => {
        gatePid = pid;
        await ready();
      }),
    );
    const running = observation.running.then((result) => {
      settled = true;
      return result;
    });
    try {
      await observation.ready;
      observation.abort.abort(new Error("injected_reference_test_timeout"));
      await expect.poll(() => settled, { timeout: 500 }).toBe(true);
      expect((await running).error).toMatchObject({ message: "injected_reference_test_timeout" });
      expect(
        (
          await f.pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid=$1",
            [gatePid],
          )
        ).rows[0]?.n,
      ).toBe(0);
    } finally {
      await observation.cleanup();
    }
  });
  it.each(["database", "actual user", "tenant", "actor", "revoked", "provenance", "profile"])(
    "rejects %s on committed replay without changes",
    async (kind) => {
      await seed.initialize(context);
      const target = {
        ...context,
        ...(kind === "database" ? { expectedDatabaseName: "markiro_us_dev" } : {}),
        ...(kind === "tenant" ? { tenantId: randomUUID() } : {}),
        ...(kind === "actor" ? { actorUserId: randomUUID() } : {}),
      };
      if (kind === "revoked") await f.db.update(schema.member).set({ role: "traceability_qa" });
      if (kind === "provenance")
        await f.db.update(schema.organization).set({ metadata: "corrupt" });
      if (kind === "profile")
        await f.db.update(schema.orgProfiles).set({ timeZone: "America/Chicago" });
      const selected =
        kind === "actual user" ? new UsDatasetReferenceSeedStore(await f.alternateRole()) : seed;
      await denied(() => selected.verify(target), "us_dataset_target_invalid");
      await denied(() => selected.initialize(target), "us_dataset_target_invalid");
    },
  );
  it("rejects a different canonical recipe without recapture", async () => {
    const header = await journal.initialize(context);
    const wrong = { ...input, definitionDigest: "a".repeat(64) };
    await journal.captureIntent(context, header.id, {
      unitKey: "references",
      stage: "references",
      operationKey: randomUUID(),
      input: wrong,
      inputDigest: canonicalExportDigest(wrong),
    });
    await mismatch();
  });
  it.each(["party", "archived party", "location", "product", "profile", "document"])(
    "refuses unknown %s immediately in a pending stage",
    async (kind) => {
      await capture();
      const master = new UsMasterDataStore(f.db);
      const catalog = new UsCatalogStore(f.db);
      if (["party", "archived party", "location"].includes(kind)) {
        const party = await master.createParty(
          context.tenantId,
          context.actorUserId,
          catalogue.parties[0]?.input,
          randomUUID(),
        );
        if (kind === "archived party")
          await master.updateParty(
            context.tenantId,
            context.actorUserId,
            party.id,
            { archived: true },
            randomUUID(),
          );
        if (kind === "location")
          await master.createLocation(
            context.tenantId,
            context.actorUserId,
            { ...catalogue.locations[0]?.input, partyId: party.id },
            randomUUID(),
          );
      }
      if (["product", "profile"].includes(kind)) {
        const product = await catalog.createProduct(
          context.tenantId,
          context.actorUserId,
          catalogue.products[0]?.input,
          randomUUID(),
        );
        if (kind === "profile")
          await new UsProductProfileStore(f.db).putProfile(
            context.tenantId,
            context.actorUserId,
            product.id,
            catalogue.products[0]?.profile,
            randomUUID(),
          );
      }
      if (kind === "document")
        await new UsReferenceDocumentStore(f.db).createDocument(
          context.tenantId,
          context.actorUserId,
          {
            type: "invoice",
            number: "SYNTHETIC-UNOWNED",
            issuedOn: "2026-04-01",
            partyId: null,
            typeOtherLabel: null,
            notes: null,
          },
          randomUUID(),
        );
      await denied(() => seed.initialize(context), "us_dataset_reference_conflict");
    },
  );
  it("preserves initial journal freshness denial for an already populated tenant", async () => {
    await new UsMasterDataStore(f.db).createParty(
      context.tenantId,
      context.actorUserId,
      catalogue.parties[0]?.input,
      randomUUID(),
    );
    await denied(() => seed.initialize(context), "us_dataset_freshness_conflict");
  });
  it("preserves initial journal freshness denial for a populated compact installation", async () => {
    await new UsDemoReferenceSeedStore(f.db).initialize(context);
    await denied(() => seed.initialize(context), "us_dataset_freshness_conflict");
  });
  it.each([
    "party edit",
    "party archive",
    "location edit",
    "location archive",
    "product edit",
    "product archive",
    "profile edit",
    "profile missing",
    "location missing",
    "product missing",
    "party missing",
    "malformed profile",
    "creation time",
  ])("rejects owned drift: %s", async (kind) => {
    const result = await seed.initialize(context);
    const party = result.evidence.parties[0];
    const location = result.evidence.locations[0];
    const product = result.evidence.products[0];
    if (!party || !location || !product) throw new Error("missing installed records");
    const master = new UsMasterDataStore(f.db);
    if (kind.startsWith("party ") && kind !== "party missing")
      await master.updateParty(
        context.tenantId,
        context.actorUserId,
        party.id,
        kind.endsWith("archive") ? { archived: true } : { legalName: "Changed synthetic fact" },
        randomUUID(),
      );
    if (kind.startsWith("location ") && kind !== "location missing")
      await master.updateLocation(
        context.tenantId,
        context.actorUserId,
        location.id,
        kind.endsWith("archive") ? { archived: true } : { city: "Changed city" },
        randomUUID(),
      );
    if (kind.startsWith("product ") && kind !== "product missing")
      await new UsCatalogStore(f.db).updateProduct(
        context.tenantId,
        context.actorUserId,
        product.id,
        kind.endsWith("archive") ? { archived: true } : { name: "Changed synthetic product" },
        randomUUID(),
      );
    if (kind === "profile edit")
      await new UsProductProfileStore(f.db).putProfile(
        context.tenantId,
        context.actorUserId,
        product.id,
        { ...catalogue.products[0]?.profile, expectedRevision: 1, brandName: "Changed brand" },
        randomUUID(),
      );
    if (kind === "profile missing" || kind === "product missing")
      await f.db
        .delete(schema.productTraceabilityProfiles)
        .where(eq(schema.productTraceabilityProfiles.productId, product.id));
    if (kind === "product missing")
      await f.db.delete(schema.products).where(eq(schema.products.id, product.id));
    if (kind === "location missing" || kind === "party missing")
      await f.db
        .delete(schema.traceabilityLocations)
        .where(eq(schema.traceabilityLocations.id, location.id));
    if (kind === "party missing")
      await f.db
        .delete(schema.traceabilityParties)
        .where(eq(schema.traceabilityParties.id, party.id));
    if (kind === "malformed profile")
      await f.db
        .update(schema.productTraceabilityProfiles)
        .set({ ftlSourceUrl: "invalid" })
        .where(eq(schema.productTraceabilityProfiles.productId, product.id));
    if (kind === "creation time")
      await f.db
        .update(schema.traceabilityParties)
        .set({ createdAt: new Date("2026-04-01") })
        .where(eq(schema.traceabilityParties.id, party.id));
    await mismatch();
  });
  it.each(["party", "location", "product"])(
    "rejects a cross-tenant %s receipt with an otherwise valid digest",
    async (kind) => {
      const result = await seed.initialize(context);
      const tenant = randomUUID();
      await f.db.insert(schema.organization).values({
        id: tenant,
        name: "Other synthetic tenant",
        slug: randomUUID(),
        createdAt: new Date(),
      });
      await f.db.insert(schema.member).values({
        id: randomUUID(),
        organizationId: tenant,
        userId: context.actorUserId,
        role: "owner",
        createdAt: new Date(),
      });
      await new UsProfileStore(f.db).provision(
        tenant,
        context.actorUserId,
        { code: "US_FSMA204_PROCESSOR", timeZone: "America/Los_Angeles" },
        randomUUID(),
      );
      const changed = mutableResult(result);
      const foreignParty = await new UsMasterDataStore(f.db).createParty(
        tenant,
        context.actorUserId,
        catalogue.parties[0]?.input,
        randomUUID(),
      );
      if (kind === "party") {
        changed.bindings.parties = changed.bindings.parties.map((b, i) =>
          i ? b : { ...b, id: foreignParty.id },
        );
        changed.evidence.parties = changed.evidence.parties.map((p, i) => (i ? p : foreignParty));
      }
      if (kind === "location") {
        const foreign = await new UsMasterDataStore(f.db).createLocation(
          tenant,
          context.actorUserId,
          { ...catalogue.locations[0]?.input, partyId: foreignParty.id },
          randomUUID(),
        );
        changed.bindings.locations = changed.bindings.locations.map((b, i) =>
          i ? b : { ...b, id: foreign.id },
        );
        changed.evidence.locations = changed.evidence.locations.map((p, i) => (i ? p : foreign));
      }
      if (kind === "product") {
        const foreign = await new UsCatalogStore(f.db).createProduct(
          tenant,
          context.actorUserId,
          catalogue.products[0]?.input,
          randomUUID(),
        );
        const profile = await new UsProductProfileStore(f.db).putProfile(
          tenant,
          context.actorUserId,
          foreign.id,
          catalogue.products[0]?.profile,
          randomUUID(),
        );
        changed.bindings.products = changed.bindings.products.map((b, i) =>
          i ? b : { ...b, id: foreign.id },
        );
        changed.evidence.products = changed.evidence.products.map((p, i) => (i ? p : foreign));
        changed.evidence.profiles = changed.evidence.profiles.map((p, i) => (i ? p : profile));
      }
      await writeResult(changed);
      await mismatch();
    },
  );
  it.each([
    "forged binding",
    "wrong parent",
    "wrong reviewer",
    "wrong review time",
    "reordered ids",
    "missing ids",
    "additional ids",
  ])("rejects forged receipt %s", async (kind) => {
    const result = await seed.initialize(context);
    const changed = mutableResult(result);
    let ids: string[] | undefined;
    if (kind === "forged binding")
      changed.bindings.parties = changed.bindings.parties.map((p, i) =>
        i ? p : { ...p, id: randomUUID() },
      );
    if (kind === "wrong parent")
      changed.evidence.locations = changed.evidence.locations.map((p, i) =>
        i ? p : { ...p, partyId: result.evidence.parties[1]?.id ?? randomUUID() },
      );
    if (kind === "wrong reviewer")
      changed.evidence.profiles = changed.evidence.profiles.map((p, i) =>
        i ? p : { ...p, reviewedBy: randomUUID() },
      );
    if (kind === "wrong review time")
      changed.evidence.profiles = changed.evidence.profiles.map((p, i) =>
        i ? p : { ...p, reviewedAt: "2026-04-01T00:00:00.000Z" },
      );
    if (kind.endsWith("ids")) {
      ids = [
        ...result.bindings.parties,
        ...result.bindings.locations,
        ...result.bindings.products,
      ].map(({ id }) => id);
      if (kind === "reordered ids") ids.reverse();
      if (kind === "missing ids") ids.pop();
      if (kind === "additional ids") ids.push(randomUUID());
    }
    await writeResult(changed, ids);
    await mismatch();
  });
  it.each(["write", "audit", "canonical verifier", "receipt"])(
    "rolls back every persisted row after %s failure and retries the same pending operation",
    async (kind) => {
      const { stage } = await capture();
      const table =
        kind === "write"
          ? "products"
          : kind === "receipt"
            ? "traceability_demo_dataset_stages"
            : "tenant_audit_events";
      if (kind === "canonical verifier") {
        await f.pool.query(
          "CREATE FUNCTION synthetic_dataset_reference_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'traceability.product_profile.coverage_changed' THEN UPDATE product_traceability_profiles SET brand_name = 'Trigger drift' WHERE tenant_id = NEW.organization_id AND product_id = NEW.target_id::uuid; END IF; RETURN NEW; END $$",
        );
      } else {
        await f.pool.query(
          `CREATE FUNCTION synthetic_dataset_reference_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${kind === "audit" ? "IF NEW.action <> 'traceability.product.created' THEN RETURN NEW; END IF;" : ""} RAISE EXCEPTION 'synthetic_dataset_reference_failure'; END $$`,
        );
      }
      await f.pool.query(
        `CREATE TRIGGER synthetic_dataset_reference_failure ${kind === "canonical verifier" ? "AFTER" : "BEFORE"} ${kind === "receipt" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_dataset_reference_failure()`,
      );
      try {
        const before = await f.snapshot();
        if (kind === "canonical verifier")
          await expect(seed.initialize(context)).rejects.toMatchObject({
            message: "us_dataset_reference_mismatch",
            unitKey: "references",
            stage: "references",
          });
        else
          await expect(seed.initialize(context)).rejects.toMatchObject({
            cause: { code: "P0001" },
          });
        expect(await f.snapshot()).toEqual(before);
        expect((await readStage()).intent.operationKey).toBe(stage.intent.operationKey);
        expect((await readStage()).receipt).toBeNull();
      } finally {
        await f.pool.query(`DROP TRIGGER synthetic_dataset_reference_failure ON ${table}`);
        await f.pool.query("DROP FUNCTION synthetic_dataset_reference_failure()");
      }
      await assertInstalled(await seed.initialize(context));
      expect((await readStage()).intent.operationKey).toBe(stage.intent.operationKey);
    },
  );
  it("propagates a canonical read driver failure unchanged", async () => {
    await seed.initialize(context);
    await f.pool.query("ALTER TABLE traceability_locations RENAME TO synthetic_hidden_locations");
    try {
      const before = await f.snapshot();
      await expect(seed.verify(context)).rejects.toMatchObject({ cause: { code: "42P01" } });
      expect(await f.snapshot()).toEqual(before);
    } finally {
      await f.pool.query("ALTER TABLE synthetic_hidden_locations RENAME TO traceability_locations");
    }
  });
  it.each(["party", "location", "product"])(
    "holds the owned %s share lock throughout canonical comparison",
    async (kind) => {
      const result = await seed.initialize(context);
      const firstParty = result.evidence.parties[0];
      const firstLocation = result.evidence.locations[0];
      const firstProduct = result.evidence.products[0];
      if (!firstParty || !firstLocation || !firstProduct)
        throw new Error("missing installed reference");
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached: () => void = () => undefined;
      const waiting = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const original = UsMasterDataStore.prototype.getPartiesInTransaction;
      const spy = vi
        .spyOn(UsMasterDataStore.prototype, "getPartiesInTransaction")
        .mockImplementation(async function (this: UsMasterDataStore, ...args) {
          const value = await original.apply(this, args);
          if (Array.isArray(args[3]) && args[3].includes(firstParty.id)) {
            reached();
            await gate;
          }
          return value;
        });
      const verification = seed.verify(context);
      try {
        await waiting;
        const id =
          kind === "party"
            ? firstParty.id
            : kind === "location"
              ? firstLocation.id
              : firstProduct.id;
        const table =
          kind === "party"
            ? "traceability_parties"
            : kind === "location"
              ? "traceability_locations"
              : "products";
        const client = await f.pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL lock_timeout = '100ms'");
          await expect(
            client.query(`SELECT id FROM ${table} WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [
              context.tenantId,
              id,
            ]),
          ).rejects.toMatchObject({ code: "55P03" });
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
        release();
        expect(await verification).toEqual(result);
      } finally {
        release();
        spy.mockRestore();
        await verification.catch(() => undefined);
      }
    },
  );
  it("reports committed concurrent edit drift after the editor releases its lock", async () => {
    const result = await seed.initialize(context);
    const party = result.evidence.parties[0];
    if (!party) throw new Error("missing party");
    const client = await f.pool.connect();
    await client.query("BEGIN");
    await client.query(
      "UPDATE traceability_parties SET legal_name = 'Concurrent drift' WHERE tenant_id = $1 AND id = $2",
      [context.tenantId, party.id],
    );
    const verification = seed.verify(context);
    try {
      await client.query("COMMIT");
      await expect(verification).rejects.toThrow("us_dataset_reference_mismatch");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
