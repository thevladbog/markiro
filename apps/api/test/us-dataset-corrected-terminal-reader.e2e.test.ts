import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { canonicalExportDigest, US_CAPABILITY } from "@markiro/domain";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import * as verification from "../src/modules/traceability/demo/us-dataset-corrected-shipping-verify";
import * as masterSupport from "../src/modules/traceability/master-data/us-master-data-support";
import { freshUsMasterDataReaders } from "../src/modules/traceability/master-data/us-master-data-read";
import { freshUsLotReaders } from "../src/modules/traceability/lots/us-lot-read";
import { freshUsCatalogReaders } from "../src/modules/traceability/catalog/us-catalog-read";
import { freshUsProductProfileReaders } from "../src/modules/traceability/products/us-product-profile-read";
import * as receivingNative from "../src/modules/traceability/receiving/us-receiving-store";
import * as shippingHistory from "../src/modules/traceability/shipping/us-shipping-history";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetSpecialSeedStore } from "../src/modules/traceability/demo/us-dataset-special-seed";
import { UsDatasetCorrectedTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-transformation-seed";
import { UsDatasetCorrectedCasesSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-cases-seed";
import { UsDatasetCorrectedShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-shipping-seed";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetUnitCompositionStore } from "../src/modules/traceability/demo/us-dataset-unit-composition";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-store";
import { UsTraceStore } from "../src/modules/traceability/trace/us-trace-store";
import type { UsDemoTransaction } from "../src/modules/traceability/demo/us-demo-atomic-stage-contract";
import type { UsDatasetContext } from "../src/modules/traceability/demo/us-dataset-contract";
import { specialFixture } from "./support/us-dataset-special-fixture";
import {
  captureCorrectedShipping,
  correctedShippingStores,
} from "./support/us-dataset-corrected-shipping-fixture";
import { countActualQueries } from "./support/us-dataset-query-counter";
import {
  abortable,
  barrier,
  driverCode,
  outcome,
  waitBlocked,
  withOwnedWork,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
type CoreArgs = Parameters<typeof verification.verifyUsDatasetCorrectedShippingCore>;
type Harness = ReturnType<typeof specialFixture>;
type NativeShipping = Awaited<ReturnType<UsDatasetCorrectedShippingSeedStore["verify"]>>;
type NativeOrigin = Awaited<ReturnType<UsDatasetCorrectedTransformationSeedStore["verify"]>>;
type NativeCases = Awaited<ReturnType<UsDatasetCorrectedCasesSeedStore["verify"]>>;
type NativeLifecycle = Extract<
  Awaited<ReturnType<UsDatasetSpecialSeedStore["verify"]>>,
  { stage: "amend_receiving" }
>;
type NativeReferences = Awaited<ReturnType<UsDatasetReferenceSeedStore["verify"]>>;
type Installed = {
  references: NativeReferences;
  lifecycle: NativeLifecycle;
  origin: NativeOrigin;
  cases: NativeCases;
  shipping?: NativeShipping;
};

function identities(state: Installed) {
  const { lifecycle, origin, cases, shipping } = state;
  expect(lifecycle.stage).toBe("amend_receiving");
  expect(lifecycle.lots).toHaveLength(2);
  expect(cases.input.support.boxes).toHaveLength(60);
  const ids = [
    lifecycle.original.created.eventId,
    lifecycle.finalized.eventId,
    origin.created.id,
    ...lifecycle.lots.map(({ id }) => id),
    origin.outputLot.id,
    ...(shipping?.shipments.map(({ created }) => created.id) ?? []),
  ];
  expect(new Set(ids).size).toBe(ids.length);
  if (shipping) expect(shipping.shipments).toHaveLength(1);
}

// A finite test-local owner. All restoration/removal/closure is registered before
// acquisition or launch; both normal and test-finish exits release, drain, clean.
async function owned<T>(
  test: TestContext,
  run: (scope: {
    launch<R>(work: () => Promise<R>): Promise<R>;
    release(fn: () => void): void;
    cleanup(fn: () => Promise<void> | void): void;
  }) => Promise<T>,
): Promise<T> {
  const running = new Set<Promise<unknown>>();
  const releases: (() => void)[] = [];
  const cleanups: (() => Promise<void> | void)[] = [];
  let cleaned: Promise<void> | undefined;
  const clean = () =>
    (cleaned ??= (async () => {
      const errors: unknown[] = [];
      for (const release of releases)
        try {
          release();
        } catch (error) {
          errors.push(error);
        }
      while (running.size) await Promise.allSettled([...running]);
      for (const cleanup of cleanups.reverse())
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      if (errors.length) throw new AggregateError(errors, "corrected_terminal_cleanup_failed");
    })());
  test.onTestFinished(clean);
  return withOwnedWork(async (own) => {
    own("corrected-terminal-release-drain-clean", clean);
    // Track the complete body before its first continuation, including CREATE,
    // connection acquisition, snapshots and post-exit checks, not just facades.
    const body = Promise.resolve().then(() =>
      run({
        release: (fn) => {
          releases.push(fn);
          if (cleaned) fn();
        },
        cleanup: (fn) => {
          cleanups.push(fn);
        },
        launch<R>(work: () => Promise<R>) {
          const pending = Promise.resolve().then(work);
          running.add(pending);
          void pending.then(
            () => running.delete(pending),
            () => running.delete(pending),
          );
          return pending;
        },
      }),
    );
    running.add(body);
    void body.then(
      () => running.delete(body),
      () => running.delete(body),
    );
    return body;
  });
}

function descriptor(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  return {
    name: error.name,
    own: Object.fromEntries(
      Object.getOwnPropertyNames(error)
        .filter((key) => key !== "stack")
        .sort()
        .map((key) => {
          const value = Object.getOwnPropertyDescriptor(error, key);
          return [
            key,
            value && { ...value, ...("value" in value ? { value: descriptor(value.value) } : {}) },
          ];
        }),
    ),
  };
}
const bindingError = async (call: () => unknown) => {
  await expect(Promise.resolve().then(call)).rejects.toThrow(
    "us_dataset_terminal_reader_binding_invalid",
  );
};

// Every concrete exposed method appears once; no empty array can bypass binding.
function inventory(args: CoreArgs, state: Installed) {
  identities(state);
  const [tx, checked, , , d] = args;
  const { lifecycle: l, origin: o, references: r, shipping: s } = state;
  const party = r.bindings.parties[0],
    location = r.bindings.locations[0];
  const document = l.original.documents[0];
  if (!party || !location || !document) throw new Error("missing actual native identities");
  const products = r.bindings.products.map(({ id }) => id);
  const context = (t: UsDemoTransaction, c: UsDatasetContext) => ({
    t,
    c,
    tenant: c.tenantId,
    actor: c.actorUserId,
  });
  type Binding = ReturnType<typeof context>;
  type Entry = { name: string; actor: boolean; context: boolean; call: (b: Binding) => unknown };
  const entries: Entry[] = [
    {
      name: "authorize",
      actor: true,
      context: false,
      call: ({ t, tenant, actor }) => d.authorize(t, tenant, actor, US_CAPABILITY.SHIPPING_WRITE),
    },
    {
      name: "master.getPartyInTransaction",
      actor: true,
      context: false,
      call: ({ t, tenant, actor }) => d.master.getPartyInTransaction(t, tenant, actor, party.id),
    },
    {
      name: "master.getPartiesInTransaction",
      actor: true,
      context: false,
      call: ({ t, tenant, actor }) =>
        d.master.getPartiesInTransaction(t, tenant, actor, [party.id]),
    },
    {
      name: "master.getLocationInTransaction",
      actor: true,
      context: false,
      call: ({ t, tenant, actor }) =>
        d.master.getLocationInTransaction(t, tenant, actor, location.id),
    },
    {
      name: "master.getLocationsInTransaction",
      actor: true,
      context: false,
      call: ({ t, tenant, actor }) =>
        d.master.getLocationsInTransaction(t, tenant, actor, [location.id]),
    },
    {
      name: "catalog.getProductsInTransaction",
      actor: true,
      context: false,
      call: ({ t, tenant, actor }) =>
        d.catalog.getProductsInTransaction(t, tenant, actor, products),
    },
    {
      name: "profiles.getProfilesInTransaction",
      actor: true,
      context: false,
      call: ({ t, tenant, actor }) =>
        d.profiles.getProfilesInTransaction(t, tenant, actor, products),
    },
    {
      name: "documents.getDocumentInTransaction",
      actor: true,
      context: false,
      call: ({ t, tenant, actor }) =>
        d.documents.getDocumentInTransaction(t, tenant, actor, document.record.id),
    },
    {
      name: "lots.getLotInTransaction",
      actor: true,
      context: false,
      call: ({ t, tenant, actor }) => d.lots.getLotInTransaction(t, tenant, actor, o.outputLot.id),
    },
    {
      name: "receiving.getLiveRecordInTransaction",
      actor: true,
      context: false,
      call: ({ t, tenant, actor }) =>
        d.receiving.getLiveRecordInTransaction(t, tenant, actor, l.original.created.eventId),
    },
    {
      name: "receiving.getLotReceivingBasisInTransaction",
      actor: true,
      context: false,
      call: ({ t, tenant, actor }) =>
        d.receiving.getLotReceivingBasisInTransaction(t, tenant, actor, o.outputLot.id, {
          limit: 10,
          offset: 0,
        }),
    },
    {
      name: "transformation.getRecordInTransaction",
      actor: true,
      context: false,
      call: ({ t, tenant, actor }) =>
        d.transformation.getRecordInTransaction(t, tenant, actor, o.created.id),
    },
    {
      name: "shipping.getRecordInTransaction",
      actor: true,
      context: false,
      call: ({ t, tenant, actor }) =>
        d.shipping.getRecordInTransaction(
          t,
          tenant,
          actor,
          s?.shipments[0]?.created.id ?? o.created.id,
        ),
    },
    {
      name: "shippingRevisions",
      actor: false,
      context: false,
      call: ({ t, tenant }) =>
        d.shippingRevisions(t, tenant, s?.shipments[0]?.created.id ?? o.created.id, {
          limit: 10,
          offset: 0,
        }),
    },
    {
      name: "journal.readHeaderInTransaction",
      actor: true,
      context: true,
      call: ({ t, c }) => d.journal.readHeaderInTransaction(t, c),
    },
    {
      name: "journal.readStageInTransaction",
      actor: true,
      context: true,
      call: ({ t, c }) =>
        d.journal.readStageInTransaction(
          t,
          c,
          o.input.references.datasetId,
          "correction_0001",
          "shipping",
        ),
    },
    {
      name: "journal.readStagesInTransaction",
      actor: true,
      context: true,
      call: ({ t, c }) =>
        d.journal.readStagesInTransaction(t, c, o.input.references.datasetId, [
          { unitKey: "correction_0001", stage: "shipping" },
        ]),
    },
    {
      name: "points.lot",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.points.lot(t, tenant, o.outputLot.id),
    },
    {
      name: "points.document",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.points.document(t, tenant, document.record.id),
    },
    {
      name: "points.event",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.points.event(t, tenant, l.original.created.eventId),
    },
    {
      name: "points.receivingRoot",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.points.receivingRoot(t, tenant, l.original.created.eventId),
    },
    {
      name: "points.transformationRoot",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.points.transformationRoot(t, tenant, o.created.id),
    },
    {
      name: "points.shippingRoot",
      actor: false,
      context: false,
      call: ({ t, tenant }) =>
        d.points.shippingRoot(t, tenant, s?.shipments[0]?.created.id ?? o.created.id),
    },
    {
      name: "locks.receivingRoot",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.locks.receivingRoot(t, tenant, l.original.created.eventId),
    },
    {
      name: "locks.receivingRevision",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.locks.receivingRevision(t, tenant, l.original.created.eventId),
    },
    {
      name: "locks.transformationRevision",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.locks.transformationRevision(t, tenant, o.created.id),
    },
    {
      name: "locks.referenceParents",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.locks.referenceParents(t, tenant, r.bindings),
    },
    {
      name: "locks.receivingDocuments",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.locks.receivingDocuments(t, tenant, [document.record.id]),
    },
    {
      name: "locks.transformationDocuments",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.locks.transformationDocuments(t, tenant, [document.record.id]),
    },
    {
      name: "locks.shippingReferences",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.locks.shippingReferences(t, tenant, "correction_0001", r.bindings),
    },
    {
      name: "locks.shippingDocuments",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.locks.shippingDocuments(t, tenant, [document.record.id], []),
    },
    {
      name: "locks.transformation",
      actor: true,
      context: true,
      call: ({ t, c }) =>
        Reflect.apply(d.locks.transformation, undefined, [
          t,
          c,
          { receiving: l.original, transformation: o },
        ]),
    },
    {
      name: "locks.shipping",
      actor: true,
      context: true,
      call: ({ t, c }) =>
        Reflect.apply(d.locks.shipping, undefined, [t, c, l.original, o, s ?? null]),
    },
    {
      name: "locks.correctedShipping",
      actor: true,
      context: true,
      call: ({ t, c }) => d.locks.correctedShipping(t, c, o, s ?? null),
    },
    {
      name: "locks.correctedReferences",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.locks.correctedReferences(t, tenant, r.bindings),
    },
    {
      name: "locks.correctedDocuments",
      actor: false,
      context: false,
      call: ({ t, tenant }) => d.locks.correctedDocuments(t, tenant, [document.record.id], []),
    },
  ];
  const actual = Object.entries(d)
    .flatMap(([group, value]) =>
      typeof value === "function" ? [group] : Object.keys(value).map((key) => `${group}.${key}`),
    )
    .sort();
  expect(actual).toEqual(entries.map(({ name }) => name).sort());
  expect(entries).toHaveLength(36);
  return {
    async invalid(other: UsDemoTransaction) {
      for (const entry of entries) {
        await bindingError(() => entry.call(context(other, checked)));
        await bindingError(() => entry.call(context(tx, { ...checked, tenantId: randomUUID() })));
        if (entry.actor)
          await bindingError(() =>
            entry.call(context(tx, { ...checked, actorUserId: randomUUID() })),
          );
        if (entry.context) {
          await bindingError(() =>
            entry.call(context(tx, { ...checked, expectedDatabaseName: "wrong_database" })),
          );
          const wrongUser = { ...checked };
          Reflect.set(wrongUser, "expectedDatabaseUser", "wrong_user");
          await bindingError(() => entry.call(context(tx, wrongUser)));
        }
      }
    },
    async revoked() {
      for (const entry of entries) await bindingError(() => entry.call(context(tx, checked)));
    },
  };
}

function freshSpy(h: Harness, scope: { cleanup(fn: () => void): void }) {
  const original = UsDatasetJournalStore.prototype.runAtomicStage;
  let calls = 0;
  const spy = vi.spyOn(UsDatasetJournalStore.prototype, "runAtomicStage");
  scope.cleanup(() => spy.mockRestore());
  spy.mockImplementation(function (
    this: UsDatasetJournalStore,
    context,
    datasetId,
    revision,
    intent,
    work,
  ) {
    if (intent.unitKey !== "correction_0001" || intent.stage !== "shipping")
      return original.call(this, context, datasetId, revision, intent, work);
    return original.call(this, context, datasetId, revision, intent, {
      ...work,
      verify: async (tx, checked, i, r) => {
        calls++;
        return verification.verifyUsDatasetCorrectedShipping(
          tx,
          checked,
          i,
          r,
          correctedShippingStores(h.f.db),
          "replay",
        );
      },
    });
  });
  return { spy, calls: () => calls };
}

async function rejectedParity(h: Harness, test: TestContext) {
  return owned(test, async (scope) => {
    const before = await h.f.snapshot();
    const store = new UsDatasetCorrectedShippingSeedStore(h.f.db);
    const actual = await outcome(scope.launch(() => store.verify(h.context)));
    expect(actual.value).toBeUndefined();
    expect(actual.error).toMatchObject({
      message: "us_dataset_corrected_shipping_mismatch",
      unitKey: "correction_0001",
      stage: "shipping",
    });
    if (!(actual.error instanceof Error)) throw new Error("missing actual verifier error");
    expect(Object.hasOwn(actual.error, "cause")).toBe(true);
    expect(await h.f.snapshot()).toEqual(before);
    const control = freshSpy(h, scope);
    const fresh = await outcome(scope.launch(() => store.verify(h.context)));
    expect(control.calls()).toBe(1);
    expect(descriptor(actual.error)).toEqual(descriptor(fresh.error));
    expect(await h.f.snapshot()).toEqual(before);
  });
}

describe.skipIf(!base)("corrected Shipping terminal reader", () => {
  describe("completed correction", () => {
    const h = specialFixture(base);
    let state: Installed;
    beforeEach(
      h.phase(async () => {
        const references = await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
        const lifecycle = await new UsDatasetSpecialSeedStore(h.f.db).initialize(
          h.context,
          "correction",
        );
        if (lifecycle.stage !== "amend_receiving") throw new Error("missing amendment");
        const origin = await new UsDatasetCorrectedTransformationSeedStore(h.f.db).initialize(
          h.context,
        );
        const cases = await new UsDatasetCorrectedCasesSeedStore(h.f.db).initialize(h.context);
        const shipping = await new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(
          h.context,
        );
        state = { references, lifecycle, origin, cases, shipping };
      }),
      60_000,
    );

    it(
      "CT01 completed differential and exhaustive binding pair",
      h.phase(async (test: TestContext) =>
        owned(test, async (scope) => {
          const store = new UsDatasetCorrectedShippingSeedStore(h.f.db);
          const before = await h.f.snapshot();
          const fresh = freshSpy(h, scope);
          const control = await countActualQueries(h.f.pool, () =>
            scope.launch(() => store.verify(h.context)),
          );
          expect(fresh.calls()).toBe(1);
          fresh.spy.mockRestore();
          expect(await h.f.snapshot()).toEqual(before);
          const core = verification.verifyUsDatasetCorrectedShippingCore;
          let callbacks = 0;
          const spy = vi.spyOn(verification, "verifyUsDatasetCorrectedShippingCore");
          scope.cleanup(() => spy.mockRestore());
          spy.mockImplementation(async (...args) => {
            callbacks++;
            return core(...args);
          });
          const closed = await countActualQueries(h.f.pool, () =>
            scope.launch(() => store.verify(h.context)),
          );
          expect(callbacks).toBe(1);
          expect(closed.value).toEqual(control.value);
          expect(closed.value).toEqual(state.shipping);
          expect(closed.count).toBeLessThan(control.count);
          expect(await h.f.snapshot()).toEqual(before);
          const totals: number[] = [];
          for (const negative of [false, true]) {
            let captured: ReturnType<typeof inventory> | undefined;
            let count = 0;
            spy.mockImplementation(async (...args) => {
              count++;
              captured = inventory(args, state);
              await h.f.db.transaction(async (other) => {
                if (negative) await captured?.invalid(other);
              });
              return core(...args);
            });
            const measured = await countActualQueries(h.f.pool, async () => {
              const value = await scope.launch(() => store.verify(h.context));
              if (!captured) throw new Error("missing Core observation");
              if (negative) await captured.revoked();
              return value;
            });
            expect(count).toBe(1);
            expect(measured.value).toEqual(state.shipping);
            expect(measured.count).toBeGreaterThan(0);
            totals.push(measured.count);
            expect(await h.f.snapshot()).toEqual(before);
          }
          expect(totals[1]).toBe(totals[0]);
          console.info("CT01 inclusive whole-facade dispatches/time", {
            fresh: { count: control.count, durationMs: control.durationMs },
            closed: { count: closed.count, durationMs: closed.durationMs },
            binding: totals,
          });
        }),
      ),
    );

    it(
      "CT02 replay clone ownership and actual fresh forwarding witnesses",
      h.phase(async (test: TestContext) =>
        owned(test, async (scope) => {
          const before = await h.f.snapshot();
          const missing = randomUUID();
          expect(
            (
              await h.f.pool.query(
                "SELECT id FROM traceability_lots WHERE tenant_id=$1 AND id=$2 UNION ALL SELECT id FROM traceability_parties WHERE tenant_id=$1 AND id=$2",
                [h.context.tenantId, missing],
              )
            ).rowCount,
          ).toBe(0);
          const core = verification.verifyUsDatasetCorrectedShippingCore;
          let captured: ReturnType<typeof inventory> | undefined;
          const spy = vi.spyOn(verification, "verifyUsDatasetCorrectedShippingCore");
          scope.cleanup(() => spy.mockRestore());
          spy.mockImplementation(async (...args) => {
            const [tx, c, , , d] = args;
            captured = inventory(args, state);
            await core(...args);
            const lot = await d.points.lot(tx, c.tenantId, state.origin.outputLot.id);
            const event = await d.points.event(
              tx,
              c.tenantId,
              state.lifecycle.original.created.eventId,
            );
            if (
              !lot ||
              !event ||
              !event.finalizationSnapshot ||
              typeof event.finalizationSnapshot !== "object"
            )
              throw new Error("missing raw clone observations");
            const savedLot = structuredClone(lot),
              savedEvent = structuredClone(event);
            lot.createdAt.setTime(0);
            event.createdAt.setTime(0);
            Reflect.set(event.finalizationSnapshot, "notes", "CT02 privately owned nested JSON");
            expect(await d.points.lot(tx, c.tenantId, lot.id)).toEqual(savedLot);
            expect(await d.points.event(tx, c.tenantId, event.id)).toEqual(savedEvent);
            expect(await d.lots.getLotInTransaction(tx, c.tenantId, c.actorUserId, lot.id)).toEqual(
              state.shipping?.outputLotAfter,
            );
            expect(
              await d.receiving.getLiveRecordInTransaction(tx, c.tenantId, c.actorUserId, event.id),
            ).toEqual(state.lifecycle.predecessor);
            const lotForward = vi.spyOn(freshUsLotReaders, "lot");
            scope.cleanup(() => lotForward.mockRestore());
            for (let attempt = 0; attempt < 2; attempt++)
              expect(await d.points.lot(tx, c.tenantId, missing)).toBeUndefined();
            expect(lotForward.mock.calls).toEqual([
              [tx, c.tenantId, missing],
              [tx, c.tenantId, missing],
            ]);
            const parties = vi.spyOn(freshUsMasterDataReaders, "parties"),
              membership = vi.spyOn(masterSupport, "readUsMasterDataMembership");
            scope.cleanup(() => parties.mockRestore());
            scope.cleanup(() => membership.mockRestore());
            const party = state.references.bindings.parties[0];
            if (!party) throw new Error("missing party");
            for (let attempt = 0; attempt < 2; attempt++)
              await expect(
                d.master.getPartiesInTransaction(tx, c.tenantId, c.actorUserId, [
                  party.id,
                  missing,
                ]),
              ).rejects.toMatchObject({ response: { code: "party_not_found" } });
            expect(parties.mock.calls).toEqual([
              [tx, c.tenantId, [party.id, missing]],
              [tx, c.tenantId, [party.id, missing]],
            ]);
            expect(membership.mock.calls).toEqual([
              [tx, c.tenantId, c.actorUserId],
              [tx, c.tenantId, c.actorUserId],
            ]);
            expect(await Promise.all(membership.mock.results.map(({ value }) => value))).toEqual([
              { role: "owner" },
              { role: "owner" },
            ]);
            expect(await Promise.all(parties.mock.results.map(({ value }) => value))).toEqual([
              [expect.objectContaining({ id: party.id })],
              [expect.objectContaining({ id: party.id })],
            ]);
            parties.mockRestore();
            membership.mockRestore();
            lotForward.mockRestore();
            const location = state.references.bindings.locations[0],
              shipment = state.shipping?.shipments[0],
              input = state.lifecycle.lots[0];
            if (!location || !shipment || !input) throw new Error("missing freshness identities");
            const revisions = vi.spyOn(shippingHistory, "readShippingRevisionsCore"),
              basis = vi.spyOn(receivingNative, "readUsReceivingBasisCore"),
              locations = vi.spyOn(freshUsMasterDataReaders, "location"),
              products = vi.spyOn(freshUsCatalogReaders, "products"),
              profiles = vi.spyOn(freshUsProductProfileReaders, "profiles"),
              journal = vi.spyOn(UsDatasetJournalStore.prototype, "readStageInTransaction");
            for (const s of [revisions, basis, locations, products, profiles, journal])
              scope.cleanup(() => s.mockRestore());
            const productIds = state.references.bindings.products.map(({ id }) => id);
            const observed: unknown[][] = [];
            for (let attempt = 0; attempt < 2; attempt++)
              observed.push([
                await d.shippingRevisions(tx, c.tenantId, shipment.created.id, {
                  limit: 10,
                  offset: 0,
                }),
                await d.receiving.getLotReceivingBasisInTransaction(
                  tx,
                  c.tenantId,
                  c.actorUserId,
                  input.id,
                  { limit: 10, offset: 0 },
                ),
                await d.master.getLocationInTransaction(tx, c.tenantId, c.actorUserId, location.id),
                await d.catalog.getProductsInTransaction(tx, c.tenantId, c.actorUserId, productIds),
                await d.profiles.getProfilesInTransaction(
                  tx,
                  c.tenantId,
                  c.actorUserId,
                  productIds,
                ),
                await d.journal.readStageInTransaction(
                  tx,
                  c,
                  state.origin.input.references.datasetId,
                  "correction_0001",
                  "shipping",
                ),
              ]);
            expect(observed[1]).toEqual(observed[0]);
            expect(revisions.mock.calls[0]?.slice(0, 4)).toEqual([
              tx,
              c.tenantId,
              shipment.created.id,
              { limit: 10, offset: 0 },
            ]);
            expect(basis.mock.calls[0]?.slice(0, 5)).toEqual([
              tx,
              c.tenantId,
              c.actorUserId,
              input.id,
              { limit: 10, offset: 0 },
            ]);
            expect(locations.mock.calls[0]).toEqual([tx, c.tenantId, location.id]);
            expect(products.mock.calls[0]).toEqual([tx, c.tenantId, productIds]);
            expect(profiles.mock.calls[0]).toEqual([tx, c.tenantId, productIds]);
            expect(journal.mock.calls[0]).toEqual([
              tx,
              c,
              state.origin.input.references.datasetId,
              "correction_0001",
              "shipping",
            ]);
            for (const s of [revisions, basis, locations, products, profiles, journal]) {
              expect(s).toHaveBeenCalledTimes(2);
              expect(s.mock.calls[1]).toEqual(s.mock.calls[0]);
              expect(await s.mock.results[1]?.value).toEqual(await s.mock.results[0]?.value);
            }
          });
          const actual = await scope.launch(() =>
            new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context),
          );
          expect(actual).toEqual(state.shipping);
          if (!captured) throw new Error("missing Core observation");
          await captured.revoked();
          expect(await h.f.snapshot()).toEqual(before);
        }),
      ),
    );

    it(
      "CT05 same-transaction fresh membership denial pair and revoked readers",
      h.phase(async (test: TestContext) =>
        owned(test, async (scope) => {
          const before = await h.f.snapshot();
          const core = verification.verifyUsDatasetCorrectedShippingCore;
          const spy = vi.spyOn(verification, "verifyUsDatasetCorrectedShippingCore");
          scope.cleanup(() => spy.mockRestore());
          const totals: number[] = [];
          for (const negative of [false, true]) {
            let captured: ReturnType<typeof inventory> | undefined, thrown: unknown;
            spy.mockImplementation(async (...args) => {
              captured = inventory(args, state);
              await core(...args);
              const [tx, c, , , d] = args;
              const membership = vi.spyOn(masterSupport, "readUsMasterDataMembership"),
                profile = vi.spyOn(masterSupport, "readUsMasterDataProfile");
              scope.cleanup(() => membership.mockRestore());
              scope.cleanup(() => profile.mockRestore());
              await d.authorize(tx, c.tenantId, c.actorUserId, US_CAPABILITY.SHIPPING_WRITE);
              const selected = await tx.execute(
                sql`SELECT * FROM member WHERE organization_id=${c.tenantId} AND user_id=${c.actorUserId}`,
              );
              expect(selected.rows).toHaveLength(1);
              const row = selected.rows[0];
              expect(row).toMatchObject({ role: "owner" });
              const changed = await tx.execute(
                sql`UPDATE member SET role='viewer' WHERE organization_id=${c.tenantId} AND user_id=${c.actorUserId} AND role='owner' RETURNING *`,
              );
              expect(changed.rowCount).toBe(1);
              expect(changed.rows).toEqual([{ ...row, role: "viewer" }]);
              const profileCalls = profile.mock.calls.length;
              const denied = await outcome(
                d.authorize(tx, c.tenantId, c.actorUserId, US_CAPABILITY.SHIPPING_WRITE),
              );
              expect(membership).toHaveBeenCalledTimes(2);
              expect(profile.mock.calls).toHaveLength(profileCalls);
              expect(denied.error).toMatchObject({
                response: { code: "insufficient_permission" },
                status: 403,
              });
              if (!(denied.error instanceof Error))
                throw new Error("missing real authorization error");
              expect(Reflect.get(denied.error, "response")).toEqual({
                code: "insufficient_permission",
              });
              thrown = denied.error;
              membership.mockRestore();
              profile.mockRestore();
              throw denied.error;
            });
            const measured = await countActualQueries(h.f.pool, async () => {
              const actual = await outcome(
                scope.launch(() =>
                  new UsDatasetCorrectedShippingSeedStore(h.f.db).verify(h.context),
                ),
              );
              expect(actual.error).toBe(thrown);
              expect(actual.value).toBeUndefined();
              expect(actual.error).toMatchObject({
                unitKey: "correction_0001",
                stage: "shipping",
                response: { code: "insufficient_permission" },
                status: 403,
              });
              for (const [key, value] of [
                ["unitKey", "correction_0001"],
                ["stage", "shipping"],
              ] as const)
                expect(Object.getOwnPropertyDescriptor(actual.error, key)).toEqual({
                  value,
                  writable: true,
                  enumerable: true,
                  configurable: true,
                });
              if (!captured) throw new Error("missing Core observation");
              if (negative) await captured.revoked();
              return actual;
            });
            totals.push(measured.count);
            expect(await h.f.snapshot()).toEqual(before);
          }
          expect(totals[0]).toBeGreaterThan(0);
          expect(totals[1]).toBe(totals[0]);
          console.info("CT05 inclusive whole-facade dispatches", totals);
        }),
      ),
    );

    it(
      "CT07 original Receiving header drift preserves fresh error parity",
      h.phase(async (test: TestContext) => {
        const client = await h.f.pool.connect();
        try {
          await client.query("BEGIN");
          const before = await client.query(
            "SELECT * FROM traceability_events WHERE tenant_id=$1 AND id=$2",
            [h.context.tenantId, state.lifecycle.original.created.eventId],
          );
          expect(before.rows).toHaveLength(1);
          expect(before.rows[0]).toMatchObject({ revision: 1, status: "amended" });
          await client.query("ALTER TABLE traceability_events DISABLE TRIGGER USER");
          const changed = await client.query(
            "UPDATE traceability_events SET notes='CT07 original header drift' WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [h.context.tenantId, state.lifecycle.original.created.eventId],
          );
          expect(changed.rowCount).toBe(1);
          expect(changed.rows).toEqual([
            { ...before.rows[0], notes: "CT07 original header drift" },
          ]);
          await client.query("ALTER TABLE traceability_events ENABLE TRIGGER USER");
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "corruption rollback failed", {
              cause: cleanup,
            });
          }
          throw error;
        } finally {
          client.release();
        }
        await rejectedParity(h, test);
      }),
    );
    it(
      "CT08 amended-current Receiving header stays fresh",
      h.phase(async (test: TestContext) => {
        const client = await h.f.pool.connect();
        try {
          await client.query("BEGIN");
          const before = await client.query(
            "SELECT * FROM traceability_events WHERE tenant_id=$1 AND id=$2",
            [h.context.tenantId, state.lifecycle.finalized.eventId],
          );
          expect(before.rows).toHaveLength(1);
          expect(before.rows[0]).toMatchObject({ revision: 2, status: "finalized" });
          await client.query("ALTER TABLE traceability_events DISABLE TRIGGER USER");
          const changed = await client.query(
            "UPDATE traceability_events SET notes='CT08 current header drift' WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [h.context.tenantId, state.lifecycle.finalized.eventId],
          );
          expect(changed.rowCount).toBe(1);
          expect(changed.rows).toEqual([{ ...before.rows[0], notes: "CT08 current header drift" }]);
          await client.query("ALTER TABLE traceability_events ENABLE TRIGGER USER");
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "corruption rollback failed", {
              cause: cleanup,
            });
          }
          throw error;
        } finally {
          client.release();
        }
        await rejectedParity(h, test);
      }),
    );
    it(
      "CT09 Receiving root lifecycle drift preserves original mismatch",
      h.phase(async (test: TestContext) => {
        const client = await h.f.pool.connect();
        try {
          await client.query("BEGIN");
          const before = await client.query(
            "SELECT * FROM receiving_event_roots WHERE tenant_id=$1 AND id=$2",
            [h.context.tenantId, state.lifecycle.original.created.eventId],
          );
          expect(before.rows).toHaveLength(1);
          expect(before.rows[0]).toMatchObject({
            lifecycle_version: 4,
            current_event_id: state.lifecycle.finalized.eventId,
            pending_draft_id: null,
          });
          await client.query("ALTER TABLE receiving_event_roots DISABLE TRIGGER USER");
          const changed = await client.query(
            "UPDATE receiving_event_roots SET lifecycle_version=5 WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [h.context.tenantId, state.lifecycle.original.created.eventId],
          );
          expect(changed.rowCount).toBe(1);
          expect(changed.rows).toEqual([{ ...before.rows[0], lifecycle_version: 5 }]);
          await client.query("ALTER TABLE receiving_event_roots ENABLE TRIGGER USER");
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "corruption rollback failed", {
              cause: cleanup,
            });
          }
          throw error;
        } finally {
          client.release();
        }
        await rejectedParity(h, test);
      }),
    );
    it(
      "CT10 retained input lot drift remains visible",
      h.phase(async (test: TestContext) => {
        const input = state.lifecycle.lots[0];
        if (!input) throw new Error("missing input lot");
        const client = await h.f.pool.connect();
        try {
          await client.query("BEGIN");
          const before = await client.query<{ tlc: string }>(
            "SELECT * FROM traceability_lots WHERE tenant_id=$1 AND id=$2",
            [h.context.tenantId, input.id],
          );
          expect(before.rows).toHaveLength(1);
          const row = before.rows[0];
          if (!row?.tlc) throw new Error("missing original TLC");
          expect(row.tlc).toBe(input.tlc);
          await client.query("ALTER TABLE traceability_lots DISABLE TRIGGER USER");
          const changed = await client.query(
            "UPDATE traceability_lots SET tlc=tlc || '-CT10' WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [h.context.tenantId, input.id],
          );
          expect(changed.rowCount).toBe(1);
          expect(changed.rows).toEqual([{ ...row, tlc: row.tlc + "-CT10" }]);
          await client.query("ALTER TABLE traceability_lots ENABLE TRIGGER USER");
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "corruption rollback failed", {
              cause: cleanup,
            });
          }
          throw error;
        } finally {
          client.release();
        }
        await rejectedParity(h, test);
      }),
    );
    it(
      "CT11 corrected output lot drift remains visible",
      h.phase(async (test: TestContext) => {
        const client = await h.f.pool.connect();
        try {
          await client.query("BEGIN");
          const before = await client.query<{ tlc: string }>(
            "SELECT * FROM traceability_lots WHERE tenant_id=$1 AND id=$2",
            [h.context.tenantId, state.origin.outputLot.id],
          );
          expect(before.rows).toHaveLength(1);
          const row = before.rows[0];
          if (!row?.tlc) throw new Error("missing original TLC");
          expect(row.tlc).toBe(state.origin.outputLot.tlc);
          await client.query("ALTER TABLE traceability_lots DISABLE TRIGGER USER");
          const changed = await client.query(
            "UPDATE traceability_lots SET tlc=tlc || '-CT11' WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [h.context.tenantId, state.origin.outputLot.id],
          );
          expect(changed.rowCount).toBe(1);
          expect(changed.rows).toEqual([{ ...row, tlc: row.tlc + "-CT11" }]);
          await client.query("ALTER TABLE traceability_lots ENABLE TRIGGER USER");
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "corruption rollback failed", {
              cause: cleanup,
            });
          }
          throw error;
        } finally {
          client.release();
        }
        await rejectedParity(h, test);
      }),
    );
    it(
      "CT12 owned support document drift remains visible",
      h.phase(async (test: TestContext) => {
        const document = state.lifecycle.original.documents[0];
        if (!document) throw new Error("missing document");
        const client = await h.f.pool.connect();
        try {
          await client.query("BEGIN");
          const before = await client.query(
            "SELECT * FROM reference_documents WHERE tenant_id=$1 AND id=$2",
            [h.context.tenantId, document.record.id],
          );
          expect(before.rows).toHaveLength(1);
          expect(before.rows[0]).toMatchObject({ notes: document.record.notes });
          await client.query("ALTER TABLE reference_documents DISABLE TRIGGER USER");
          const changed = await client.query(
            "UPDATE reference_documents SET notes='CT12 owned document drift' WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [h.context.tenantId, document.record.id],
          );
          expect(changed.rowCount).toBe(1);
          expect(changed.rows).toEqual([{ ...before.rows[0], notes: "CT12 owned document drift" }]);
          await client.query("ALTER TABLE reference_documents ENABLE TRIGGER USER");
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "corruption rollback failed", {
              cause: cleanup,
            });
          }
          throw error;
        } finally {
          client.release();
        }
        await rejectedParity(h, test);
      }),
    );
    it(
      "CT13 owned party drift remains visible",
      h.phase(async (test: TestContext) => {
        const party = state.references.bindings.parties[0];
        if (!party) throw new Error("missing party");
        const client = await h.f.pool.connect();
        try {
          await client.query("BEGIN");
          const before = await client.query<{ name: string }>(
            "SELECT * FROM traceability_parties WHERE tenant_id=$1 AND id=$2",
            [h.context.tenantId, party.id],
          );
          expect(before.rows).toHaveLength(1);
          const row = before.rows[0];
          if (!row) throw new Error("missing party row");
          expect(row.name).toBe(
            state.references.evidence.parties.find(({ id }) => id === party.id)?.name,
          );
          await client.query("ALTER TABLE traceability_parties DISABLE TRIGGER USER");
          const changed = await client.query(
            "UPDATE traceability_parties SET name=name || ' CT13' WHERE tenant_id=$1 AND id=$2 RETURNING *",
            [h.context.tenantId, party.id],
          );
          expect(changed.rowCount).toBe(1);
          expect(changed.rows).toEqual([{ ...row, name: row.name + " CT13" }]);
          await client.query("ALTER TABLE traceability_parties ENABLE TRIGGER USER");
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "corruption rollback failed", {
              cause: cleanup,
            });
          }
          throw error;
        } finally {
          client.release();
        }
        await rejectedParity(h, test);
      }),
    );
    it(
      "CT14 exact synthetic case marker drift remains live",
      h.phase(async (test: TestContext) => {
        const box = state.cases.input.support.boxes[0];
        if (!box) throw new Error("missing case");
        const client = await h.f.pool.connect();
        try {
          await client.query("BEGIN");
          const before = await client.query(
            "SELECT * FROM traceability_synthetic_case_origins WHERE tenant_id=$1 AND box_id=$2",
            [h.context.tenantId, box.id],
          );
          expect(before.rows).toHaveLength(1);
          expect(before.rows[0]).toMatchObject({ seed_version: 1 });
          await client.query(
            "ALTER TABLE traceability_synthetic_case_origins DISABLE TRIGGER USER",
          );
          const changed = await client.query(
            "UPDATE traceability_synthetic_case_origins SET seed_version=2 WHERE tenant_id=$1 AND box_id=$2 RETURNING *",
            [h.context.tenantId, box.id],
          );
          expect(changed.rowCount).toBe(1);
          expect(changed.rows).toEqual([{ ...before.rows[0], seed_version: 2 }]);
          await client.query("ALTER TABLE traceability_synthetic_case_origins ENABLE TRIGGER USER");
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "corruption rollback failed", {
              cause: cleanup,
            });
          }
          throw error;
        } finally {
          client.release();
        }
        await rejectedParity(h, test);
      }),
    );
    it(
      "CT15 Shipping child drift cannot hide behind parent points",
      h.phase(async (test: TestContext) => {
        const shipment = state.shipping?.shipments[0];
        if (!shipment) throw new Error("missing shipment");
        const client = await h.f.pool.connect();
        try {
          await client.query("BEGIN");
          const before = await client.query(
            "SELECT * FROM shipping_event_items WHERE tenant_id=$1 AND event_id=$2 AND line_no=1",
            [h.context.tenantId, shipment.created.id],
          );
          expect(before.rows).toHaveLength(1);
          expect(before.rows[0]).toMatchObject({ quantity: "50" });
          await client.query("ALTER TABLE shipping_event_items DISABLE TRIGGER USER");
          const changed = await client.query(
            "UPDATE shipping_event_items SET quantity=49 WHERE tenant_id=$1 AND event_id=$2 AND line_no=1 RETURNING *",
            [h.context.tenantId, shipment.created.id],
          );
          expect(changed.rowCount).toBe(1);
          expect(changed.rows).toEqual([{ ...before.rows[0], quantity: "49" }]);
          await client.query("ALTER TABLE shipping_event_items ENABLE TRIGGER USER");
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "corruption rollback failed", {
              cause: cleanup,
            });
          }
          throw error;
        } finally {
          client.release();
        }
        await rejectedParity(h, test);
      }),
    );
    it(
      "CT16 exact original audit drift stays fresh",
      h.phase(async (test: TestContext) => {
        const client = await h.f.pool.connect();
        const values = [
          h.context.tenantId,
          state.lifecycle.original.created.eventId,
          state.lifecycle.original.finalized.operationKey,
        ];
        try {
          await client.query("BEGIN");
          const before = await client.query(
            "SELECT * FROM tenant_audit_events WHERE organization_id=$1 AND target_id=$2 AND request_id=$3 AND action='traceability.receiving.finalized'",
            values,
          );
          expect(before.rows).toHaveLength(1);
          expect(before.rows[0]).toMatchObject({ outcome: "success" });
          await client.query("ALTER TABLE tenant_audit_events DISABLE TRIGGER USER");
          const changed = await client.query(
            "UPDATE tenant_audit_events SET outcome='failure' WHERE organization_id=$1 AND target_id=$2 AND request_id=$3 AND action='traceability.receiving.finalized' RETURNING *",
            values,
          );
          expect(changed.rowCount).toBe(1);
          expect(changed.rows).toEqual([{ ...before.rows[0], outcome: "failure" }]);
          await client.query("ALTER TABLE tenant_audit_events ENABLE TRIGGER USER");
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "corruption rollback failed", {
              cause: cleanup,
            });
          }
          throw error;
        } finally {
          client.release();
        }
        await rejectedParity(h, test);
      }),
    );

    it(
      "CT17 protected input lot blocks a real writer until verifier COMMIT",
      h.phase(async (test: TestContext) =>
        owned(test, async (scope) => {
          const input = state.lifecycle.lots[0];
          if (!input) throw new Error("missing input lot");
          if (!base) throw new Error("missing isolated URL");
          const url = new URL(base);
          url.pathname = "/" + h.f.databaseName;
          const writer = createDb(url.toString(), { max: 1 });
          scope.cleanup(() => writer.pool.end());
          const writerPid = (
            await writer.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]?.pid;
          if (!writerPid) throw new Error("missing writer PID");
          const ready = barrier(),
            release = barrier();
          scope.release(release.release);
          const core = verification.verifyUsDatasetCorrectedShippingCore;
          let readerPid: number | undefined;
          const spy = vi.spyOn(verification, "verifyUsDatasetCorrectedShippingCore");
          scope.cleanup(() => spy.mockRestore());
          spy.mockImplementation(async (...args) => {
            await core(...args);
            readerPid = (
              await args[0].execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
            ).rows[0]?.pid;
            ready.release();
            await release.promise;
          });
          const owner = outcome(
            scope.launch(() => new UsDatasetCorrectedShippingSeedStore(h.f.db).verify(h.context)),
          );
          await abortable(
            Promise.race([
              ready.promise,
              owner.then(({ error }) => {
                throw error ?? new Error("owner returned before barrier");
              }),
            ]),
            test.signal,
          );
          if (!readerPid) throw new Error("missing reader PID");
          const before = await h.f.pool.query(
            "SELECT * FROM traceability_lots WHERE tenant_id=$1 AND id=$2",
            [h.context.tenantId, input.id],
          );
          expect(before.rows).toHaveLength(1);
          expect(before.rows[0]).toMatchObject({ status: "active", revision: input.revision });
          const pending = outcome(
            scope.launch(() =>
              new UsLotStore(writer.db).changeStatus(
                h.context.tenantId,
                h.context.actorUserId,
                input.id,
                {
                  expectedRevision: input.revision,
                  status: "archived",
                  reason: "CT17 protected lot writer",
                },
                "CT17-protected-lot-writer",
              ),
            ),
          );
          await abortable(
            Promise.race([
              waitBlocked(h.f, readerPid, writerPid, test.signal),
              pending.then(({ error }) => {
                throw error ?? new Error("writer finished before protected lock");
              }),
            ]),
            test.signal,
          );
          release.release();
          expect((await owner).error).toBeUndefined();
          const committed = await pending;
          expect(committed.error).toBeUndefined();
          expect(committed.value).toMatchObject({
            id: input.id,
            status: "archived",
            revision: input.revision + 1,
          });
          const after = await h.f.pool.query(
            "SELECT * FROM traceability_lots WHERE tenant_id=$1 AND id=$2",
            [h.context.tenantId, input.id],
          );
          expect(after.rows).toHaveLength(1);
          expect(after.rows[0]).toMatchObject({ status: "archived", revision: input.revision + 1 });
          spy.mockRestore();
          const snapshot = await h.f.snapshot();
          await expect(
            new UsDatasetCorrectedShippingSeedStore(h.f.db).verify(h.context),
          ).rejects.toMatchObject({
            message: "us_dataset_corrected_shipping_mismatch",
            unitKey: "correction_0001",
            stage: "shipping",
          });
          expect(await h.f.snapshot()).toEqual(snapshot);
        }),
      ),
    );

    it(
      "CT06 a committed profile change is observed between public calls",
      h.phase(async () => {
        const store = new UsDatasetCorrectedShippingSeedStore(h.f.db);
        expect(await store.verify(h.context)).toEqual(state.shipping);
        const before = (
          await h.f.pool.query("SELECT * FROM org_profiles WHERE tenant_id=$1", [
            h.context.tenantId,
          ])
        ).rows;
        expect(before).toHaveLength(1);
        expect(before[0]).toMatchObject({ time_zone: "America/Los_Angeles" });
        const changed = await h.f.pool.query(
          "UPDATE org_profiles SET time_zone='America/New_York' WHERE tenant_id=$1 RETURNING *",
          [h.context.tenantId],
        );
        expect(changed.rowCount).toBe(1);
        expect(changed.rows).toEqual([{ ...before[0], time_zone: "America/New_York" }]);
        const snapshot = await h.f.snapshot();
        await expect(store.verify(h.context)).rejects.toMatchObject({
          message: "us_dataset_target_invalid",
          unitKey: "correction_0001",
          stage: "shipping",
        });
        expect(await h.f.snapshot()).toEqual(snapshot);
      }),
    );
  });
  describe("fresh Shipping boundary", () => {
    const h = specialFixture(base);
    let state: Installed;
    beforeEach(
      h.phase(async () => {
        const references = await new UsDatasetReferenceSeedStore(h.f.db).initialize(h.context);
        const lifecycle = await new UsDatasetSpecialSeedStore(h.f.db).initialize(
          h.context,
          "correction",
        );
        if (lifecycle.stage !== "amend_receiving") throw new Error("missing amendment");
        const origin = await new UsDatasetCorrectedTransformationSeedStore(h.f.db).initialize(
          h.context,
        );
        const cases = await new UsDatasetCorrectedCasesSeedStore(h.f.db).initialize(h.context);
        state = { references, lifecycle, origin, cases };
      }),
      60_000,
    );
    it(
      "CT03 fresh native Shipping creates fifty shipped of sixty active cases",
      h.phase(async () => {
        const actual = await new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context);
        expect(actual.shipments).toHaveLength(1);
        expect(actual.shipments[0]?.createInput.draft.items[0]).toMatchObject({
          quantity: "50",
          unitOfMeasure: "case",
          lotId: state.origin.outputLot.id,
        });
        expect(state.cases.input.support.boxes).toHaveLength(60);
        expect(actual.outputLotAfter).toMatchObject({
          id: state.origin.outputLot.id,
          status: "active",
        });
        const shipment = actual.shipments[0];
        if (!shipment) throw new Error("missing shipment");
        expect(
          await new UsShippingStore(h.f.db).getRecord(
            h.context.tenantId,
            h.context.actorUserId,
            shipment.created.id,
          ),
        ).toEqual(shipment.finalized);
        const stages = await h.f.pool.query(
          "SELECT unit_key,stage,revision,receipt FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key='correction_0001' ORDER BY stage",
          [h.context.tenantId],
        );
        expect(stages.rows.find((row) => row.stage === "shipping")).toMatchObject({
          revision: 2,
          receipt: expect.any(Object),
        });
        expect(stages.rows.filter((row) => row.stage === "trace_readiness")).toEqual([]);
        expect(
          await new UsLotStore(h.f.db).getLot(
            h.context.tenantId,
            h.context.actorUserId,
            state.origin.outputLot.id,
          ),
        ).toEqual(actual.outputLotAfter);
      }),
    );

    it(
      "CT04 actual deferred COMMIT rollback pair revokes all adapters",
      h.phase(async (test: TestContext) =>
        owned(test, async (scope) => {
          const pre = await h.f.snapshot();
          const rawBefore = await h.f.pool.query(
            "SELECT to_jsonb(s) AS row FROM traceability_demo_dataset_stages s WHERE tenant_id=$1 ORDER BY unit_key,stage",
            [h.context.tenantId],
          );
          const captured = await captureCorrectedShipping(h.f, h.context);
          const rawAfter = await h.f.pool.query(
            "SELECT to_jsonb(s) AS row FROM traceability_demo_dataset_stages s WHERE tenant_id=$1 ORDER BY unit_key,stage",
            [h.context.tenantId],
          );
          const added = rawAfter.rows.filter(
            (row) =>
              !rawBefore.rows.some(
                (old) => canonicalExportDigest(old) === canonicalExportDigest(row),
              ),
          );
          expect(added).toHaveLength(1);
          expect(rawAfter.rows.filter((row) => !added.includes(row))).toEqual(rawBefore.rows);
          const addedRow = added[0]?.row;
          expect(Object.keys(addedRow).sort()).toEqual(
            [
              "id",
              "tenant_id",
              "dataset_id",
              "unit_key",
              "stage",
              "revision",
              "operation_key",
              "input_digest",
              "input",
              "receipt",
              "created_at",
            ].sort(),
          );
          expect(addedRow).toMatchObject({
            tenant_id: h.context.tenantId,
            dataset_id: captured.header.id,
            unit_key: "correction_0001",
            stage: "shipping",
            revision: 1,
            operation_key: captured.stage.intent.operationKey,
            input_digest: canonicalExportDigest(captured.input),
            input: captured.input,
            receipt: null,
          });
          expect(captured.stage.intent.operationKey).toMatch(/^[0-9a-f-]{36}$/);
          const baseline = await h.f.snapshot();
          expect({
            ...baseline,
            traceability_demo_dataset_stages: pre.traceability_demo_dataset_stages,
          }).toEqual(pre);
          const name = "ct04_" + randomUUID().replaceAll("-", "");
          let functionCreated = false,
            triggerCreated = false;
          scope.cleanup(async () => {
            if (functionCreated) {
              await h.f.pool.query(`DROP FUNCTION ${name}()`);
              functionCreated = false;
            }
          });
          scope.cleanup(async () => {
            if (triggerCreated) {
              await h.f.pool.query(`DROP TRIGGER ${name} ON traceability_demo_dataset_stages`);
              triggerCreated = false;
            }
          });
          await h.f.pool.query(
            `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${h.context.tenantId}' AND NEW.dataset_id='${captured.header.id}' AND NEW.unit_key='correction_0001' AND NEW.stage='shipping' AND OLD.receipt IS NULL AND NEW.receipt IS NOT NULL AND NEW.revision=2 THEN RAISE EXCEPTION 'closed_terminal_commit_failure' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$`,
          );
          functionCreated = true;
          await h.f.pool.query(
            `CREATE CONSTRAINT TRIGGER ${name} AFTER UPDATE ON traceability_demo_dataset_stages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`,
          );
          triggerCreated = true;
          const core = verification.verifyUsDatasetCorrectedShippingCore;
          const spy = vi.spyOn(verification, "verifyUsDatasetCorrectedShippingCore");
          scope.cleanup(() => spy.mockRestore());
          const journal = UsDatasetJournalStore.prototype.runAtomicStage;
          const journalSpy = vi.spyOn(UsDatasetJournalStore.prototype, "runAtomicStage");
          scope.cleanup(() => journalSpy.mockRestore());
          const totals: number[] = [];
          const failures: unknown[] = [];
          for (const negative of [false, true]) {
            let readers: ReturnType<typeof inventory> | undefined,
              journalError: unknown,
              verified = 0;
            spy.mockImplementation(async (...args) => {
              readers = inventory(args, state);
              await core(...args);
              verified++;
            });
            journalSpy.mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
              try {
                return await journal.apply(this, args);
              } catch (error) {
                journalError = error;
                throw error;
              }
            });
            const measured = await countActualQueries(h.f.pool, async () => {
              const actual = await outcome(
                scope.launch(() =>
                  new UsDatasetCorrectedShippingSeedStore(h.f.db).initialize(h.context),
                ),
              );
              expect(actual.value).toBeUndefined();
              expect(verified).toBe(1);
              expect(actual.error).toBe(journalError);
              expect(driverCode(actual.error)).toBe("P0001");
              let cause = actual.error;
              while (cause instanceof Error && cause.cause) cause = cause.cause;
              expect(cause).toMatchObject({
                message: "closed_terminal_commit_failure",
                code: "P0001",
              });
              if (!(cause instanceof Error)) throw new Error("missing actual PostgreSQL error");
              expect(Object.hasOwn(cause, "code")).toBe(true);
              for (const [key, value] of [
                ["unitKey", "correction_0001"],
                ["stage", "shipping"],
              ])
                expect(Object.getOwnPropertyDescriptor(actual.error, key ?? "")).toEqual({
                  value,
                  writable: true,
                  enumerable: true,
                  configurable: true,
                });
              if (!readers) throw new Error("missing actual Core");
              if (negative) await readers.revoked();
              return descriptor(actual.error);
            });
            totals.push(measured.count);
            failures.push(measured.value);
            expect(await h.f.snapshot()).toEqual(baseline);
            expect(
              (
                await h.f.pool.query(
                  "SELECT to_jsonb(s) AS row FROM traceability_demo_dataset_stages s WHERE tenant_id=$1 ORDER BY unit_key,stage",
                  [h.context.tenantId],
                )
              ).rows,
            ).toEqual(rawAfter.rows);
          }
          expect(totals[0]).toBeGreaterThan(0);
          expect(totals[1]).toBe(totals[0]);
          expect(failures[1]).toEqual(failures[0]);
          console.info("CT04 inclusive whole-facade dispatches", totals);
        }),
      ),
    );

    it(
      "CT18 committed native Shipping void is observed by actual subsequent Trace",
      h.phase(async (test: TestContext) =>
        owned(test, async (scope) => {
          if (!base) throw new Error("missing isolated URL");
          const url = new URL(base);
          url.pathname = "/" + h.f.databaseName;
          const writer = createDb(url.toString(), { max: 1 });
          scope.cleanup(() => writer.pool.end());
          const committed = barrier(),
            allowTrace = barrier();
          scope.release(allowTrace.release);
          let shipment: NativeShipping | undefined,
            writerCommitted = false,
            traceCalls = 0;
          const initialize = UsDatasetCorrectedShippingSeedStore.prototype.initialize;
          const nativeSpy = vi.spyOn(UsDatasetCorrectedShippingSeedStore.prototype, "initialize");
          scope.cleanup(() => nativeSpy.mockRestore());
          nativeSpy.mockImplementation(async function (
            this: UsDatasetCorrectedShippingSeedStore,
            context,
          ) {
            const actual = await initialize.call(this, context);
            if (context.tenantId === h.context.tenantId) {
              shipment = actual;
              committed.release();
              await allowTrace.promise;
            }
            return actual;
          });
          const read = UsTraceStore.prototype.read;
          const traceSpy = vi.spyOn(UsTraceStore.prototype, "read");
          scope.cleanup(() => traceSpy.mockRestore());
          traceSpy.mockImplementation(function (this: UsTraceStore, ...args) {
            expect(writerCommitted).toBe(true);
            traceCalls++;
            return read.apply(this, args);
          });
          const owner = outcome(
            scope.launch(() =>
              new UsDatasetUnitCompositionStore(h.f.db).initialize(h.context, {
                kind: "correction",
              }),
            ),
          );
          await abortable(
            Promise.race([
              committed.promise,
              owner.then(({ error }) => {
                throw error ?? new Error("owner returned before native COMMIT");
              }),
            ]),
            test.signal,
          );
          const selected = shipment?.shipments[0];
          if (!selected) throw new Error("missing committed Shipping");
          const rootBefore = await writer.pool.query(
            "SELECT r.*,e.status AS event_status FROM shipping_event_roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.id WHERE r.tenant_id=$1 AND r.id=$2",
            [h.context.tenantId, selected.created.id],
          );
          expect(rootBefore.rows).toHaveLength(1);
          expect(rootBefore.rows[0]).toMatchObject({
            current_event_id: selected.created.id,
            lifecycle_version: 2,
            event_status: "finalized",
          });
          expect(traceCalls).toBe(0);
          const voidOperationKey = randomUUID();
          const receipt = await scope.launch(() =>
            new UsShippingStore(writer.db).void(
              h.context.tenantId,
              h.context.actorUserId,
              selected.created.id,
              {
                operationKey: voidOperationKey,
                expectedLifecycleVersion: 2,
                reason: "CT18 postcommit Shipping void",
              },
              "CT18-postcommit-Shipping-void",
            ),
          );
          writerCommitted = true;
          expect(receipt).toMatchObject({
            command: "shipping.void",
            eventId: selected.created.id,
            operationKey: voidOperationKey,
            record: { status: "void", lifecycle: { currentEventId: null, lifecycleVersion: 3 } },
          });
          const rootAfter = await writer.pool.query(
            "SELECT r.*,e.status AS event_status FROM shipping_event_roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.id WHERE r.tenant_id=$1 AND r.id=$2",
            [h.context.tenantId, selected.created.id],
          );
          expect(rootAfter.rows).toHaveLength(1);
          expect(rootAfter.rows).toEqual([
            {
              ...rootBefore.rows[0],
              current_event_id: null,
              lifecycle_version: 3,
              event_status: "void",
            },
          ]);
          const audits = await writer.pool.query(
            "SELECT organization_id,actor_user_id,action,target_type,target_id,outcome,request_id,before,after FROM tenant_audit_events WHERE organization_id=$1 AND request_id='CT18-postcommit-Shipping-void'",
            [h.context.tenantId],
          );
          expect(audits.rows).toEqual([
            {
              organization_id: h.context.tenantId,
              actor_user_id: h.context.actorUserId,
              action: "traceability.shipping.voided",
              target_type: "traceability_event",
              target_id: selected.created.id,
              outcome: "success",
              request_id: "CT18-postcommit-Shipping-void",
              before: selected.finalized,
              after: {
                rootId: selected.created.id,
                revision: receipt.record.revision,
                reason: "CT18 postcommit Shipping void",
                result: "voided",
                record: receipt.record,
              },
            },
          ]);
          expect(
            (
              await writer.pool.query(
                "SELECT result FROM shipping_operations WHERE tenant_id=$1 AND operation_key=$2 AND command='shipping.void'",
                [h.context.tenantId, voidOperationKey],
              )
            ).rows,
          ).toEqual([{ result: receipt }]);
          const snapshot = await h.f.snapshot();
          allowTrace.release();
          const actual = await owner;
          expect(actual.value).toBeUndefined();
          expect(actual.error).toMatchObject({
            message: "us_dataset_trace_readiness_mismatch",
            unitKey: "correction_0001",
            stage: "trace",
          });
          expect(Object.getOwnPropertyDescriptor(actual.error, "cause")).toMatchObject({
            value: undefined,
          });
          expect(traceCalls).toBeGreaterThan(0);
          expect(
            (
              await h.f.pool.query(
                "SELECT receipt FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key='correction_0001' AND stage='trace_readiness' AND receipt IS NOT NULL",
                [h.context.tenantId],
              )
            ).rows,
          ).toEqual([]);
          expect(await h.f.snapshot()).toEqual(snapshot);
        }),
      ),
    );
  });
});
