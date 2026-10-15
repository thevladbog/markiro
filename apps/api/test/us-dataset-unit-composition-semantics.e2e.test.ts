import { createHash, randomUUID } from "node:crypto";
import { createDb, type Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import {
  createTransformationDraftSchema,
  finalizeTransformationSchema,
  createShippingDraftSchema,
  finalizeShippingSchema,
} from "@markiro/platform-contracts";
import type {
  ReceivingLiveRecord,
  TraceabilityLot,
  TransformationFinalizedRecord,
  UsCurrentTraceResult,
  UsReadinessResult,
  UsTraceHistoryPage,
} from "@markiro/platform-contracts";
import type { UsDatasetShippingShipmentResult } from "../src/modules/traceability/demo/us-dataset-shipping-contract";
import { makeUsSixMonthRegularChain } from "../src/modules/traceability/demo/us-six-month-chains";
import { makeUsSixMonthSpecialExamples } from "../src/modules/traceability/demo/us-six-month-definition";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import type {
  UsDatasetContext,
  UsDatasetStageRow,
} from "../src/modules/traceability/demo/us-dataset-contract";
import { UsDatasetUnitCompositionStore } from "../src/modules/traceability/demo/us-dataset-unit-composition";
import type {
  NativeTraceOutput,
  UsDatasetTraceReadinessUnit,
} from "../src/modules/traceability/demo/us-dataset-trace-readiness";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetReceivingSeedStore } from "../src/modules/traceability/demo/us-dataset-receiving-seed";
import { UsDatasetTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-transformation-seed";
import { UsDatasetCasesSeedStore } from "../src/modules/traceability/demo/us-dataset-cases-seed";
import { UsDatasetShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-shipping-seed";
import { UsDatasetSpecialSeedStore } from "../src/modules/traceability/demo/us-dataset-special-seed";
import { UsDatasetCorrectedTransformationSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-transformation-seed";
import { UsDatasetCorrectedCasesSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-cases-seed";
import { UsDatasetCorrectedShippingSeedStore } from "../src/modules/traceability/demo/us-dataset-corrected-shipping-seed";
import { UsDatasetSpecialChainsSeedStore } from "../src/modules/traceability/demo/us-dataset-special-chains-seed";
import { UsDatasetTraceReadinessStageStore } from "../src/modules/traceability/demo/us-dataset-trace-readiness-stage";
import {
  makeUsDatasetReceivingInput,
  makeUsDatasetReferenceIdentity,
} from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { makeUsSixMonthCatalogue } from "../src/modules/traceability/demo/us-six-month-references";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { UsTransformationStore } from "../src/modules/traceability/transformation/us-transformation-store";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { UsShippingStore } from "../src/modules/traceability/shipping/us-shipping-store";
import { UsTraceStore } from "../src/modules/traceability/trace/us-trace-store";
import { specialFixture } from "./support/us-dataset-special-fixture";
import { prepareDatasetTransformation } from "./support/us-dataset-transformation-fixture";
import { prepareDatasetCasesFixture } from "./support/us-dataset-cases-fixture";
import { prepareDatasetShippingFixture } from "./support/us-dataset-shipping-fixture";
import {
  outcome,
  withOwnedWork,
  barrier,
  abortable,
  type OwnCleanup,
  type OwnedClient,
} from "./support/us-transformation-lock-fixture";

type Mode = "initialize" | "verify";
type State =
  | "F"
  | "H"
  | "RP"
  | "R"
  | "N1"
  | "N2"
  | "N3"
  | "N4"
  | "CP"
  | "CT"
  | "CC"
  | "NC"
  | "NO"
  | "PReceiving"
  | "PTransformation"
  | "PCases"
  | "PShipping";
const regular = { kind: "regular", index: 0 } as const;
const base = process.env.US_TEST_DATABASE_URL;

// Hash comparisons retain exact full values without emitting synthetic identities in failures.
function exact(actual: unknown, expected: unknown) {
  expect(canonicalExportDigest(actual)).toBe(canonicalExportDigest(expected));
}
function identical(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error("Expected identical observed value");
}
function data(value: unknown, enumerable = true, writable = true, configurable = true) {
  return { value, enumerable, writable, configurable };
}
function annotations(error: object, unitKey: string, stage: string) {
  expect(Object.getOwnPropertyDescriptor(error, "unitKey")).toEqual(data(unitKey));
  expect(Object.getOwnPropertyDescriptor(error, "stage")).toEqual(data(stage));
}
function absent(error: object, ...keys: string[]) {
  for (const key of keys) expect(Object.getOwnPropertyDescriptor(error, key)).toBeUndefined();
}
function errorValue(error: unknown, message: string): Error {
  if (!(error instanceof Error)) throw new Error("Expected actual Error rejection");
  expect(error.message).toBe(message);
  return error;
}
function causeValue(error: object, cause: unknown, expectedEnumerable: boolean = false) {
  const descriptor = Object.getOwnPropertyDescriptor(error, "cause");
  if (!descriptor || !("value" in descriptor)) throw new Error("Expected own data cause");
  identical(descriptor.value, cause);
  expect({ ...descriptor, value: undefined }).toEqual(data(undefined, expectedEnumerable));
}

describe.skipIf(!base)("bounded owner composition semantics", () => {
  const h = specialFixture(base);
  const journal = () => new UsDatasetJournalStore(h.f.db, usSixMonthDefinition);
  const owner = (db = h.f.db) => new UsDatasetUnitCompositionStore(db);
  const progress = () => new UsDatasetTraceReadinessStageStore(h.f.db);
  async function header() {
    const value = await journal().read(h.context);
    if (!value) throw new Error("Missing owned dataset header");
    return value;
  }
  async function stage(name: UsDatasetStageRow["stage"], key = "chain_0000") {
    return journal().readStage(h.context, (await header()).id, key, name);
  }
  async function rawJournal() {
    return (
      await h.f.pool.query<{
        row: {
          unit_key: string;
          stage: string;
          revision: number;
          receipt: unknown;
          operation_key: string;
          input: unknown;
          input_digest: string;
        };
      }>(
        "SELECT to_jsonb(s) AS row FROM traceability_demo_dataset_stages s ORDER BY unit_key, stage",
      )
    ).rows;
  }
  async function checkpoint() {
    return { snapshot: await h.f.snapshot(), journal: await rawJournal() };
  }
  async function noWrites(before: Awaited<ReturnType<typeof checkpoint>>) {
    exact(await rawJournal(), before.journal);
    expect(await h.f.snapshot()).toEqual(before.snapshot);
  }
  async function prepare(state: State, index = 0) {
    const { f, context } = h;
    if (state === "F") return;
    if (state === "H" || state === "RP") {
      const current = await journal().initialize(context);
      if (state === "RP") {
        const input = {
          version: usSixMonthDefinition.version,
          definitionDigest: usSixMonthDefinition.digest,
          catalogue: makeUsSixMonthCatalogue(),
        };
        const saved = await journal().captureIntent(context, current.id, {
          unitKey: "references",
          stage: "references",
          operationKey: randomUUID(),
          input,
          inputDigest: canonicalExportDigest(input),
        });
        expect(saved.revision).toBe(1);
        expect(saved.receipt).toBeNull();
      }
      return;
    }
    if (state === "PTransformation") {
      const ready = await prepareDatasetTransformation(f.db, context, index);
      const saved = await ready.stores.journal.captureIntent(
        context,
        ready.header.id,
        ready.intent,
      );
      expect(saved.revision).toBe(1);
      expect(saved.receipt).toBeNull();
      return;
    }
    if (state === "PCases") {
      await prepareDatasetCasesFixture(f, context, index);
      return;
    }
    if (state === "PShipping") {
      await prepareDatasetShippingFixture(f, context, index);
      return;
    }
    await new UsDatasetReferenceSeedStore(f.db).initialize(context);
    if (state === "R") return;
    if (state === "NO") {
      await new UsDatasetSpecialSeedStore(f.db).initialize(context, "orphan");
      return;
    }
    if (["CP", "CT", "CC", "NC"].includes(state)) {
      await new UsDatasetSpecialSeedStore(f.db).initialize(context, "correction");
      if (state === "CP") return;
      await new UsDatasetCorrectedTransformationSeedStore(f.db).initialize(context);
      if (state === "CT") return;
      await new UsDatasetCorrectedCasesSeedStore(f.db).initialize(context);
      if (state === "CC") return;
      await new UsDatasetCorrectedShippingSeedStore(f.db).initialize(context);
      return;
    }
    if (state === "PReceiving") {
      const current = await header(),
        references = await stage("references", "references");
      if (!references?.receipt) throw new Error("Missing owned References");
      const input = makeUsDatasetReceivingInput(
        index,
        makeUsDatasetReferenceIdentity(current.id, references),
      );
      const saved = await journal().captureIntent(context, current.id, {
        unitKey: input.chain.unitKey,
        stage: "receiving",
        operationKey: randomUUID(),
        input,
        inputDigest: canonicalExportDigest(input),
      });
      expect(saved.revision).toBe(1);
      expect(saved.receipt).toBeNull();
      return;
    }
    await new UsDatasetReceivingSeedStore(f.db).initialize(context, index);
    if (state === "N1") return;
    await new UsDatasetTransformationSeedStore(f.db).initialize(context, index);
    if (state === "N2") return;
    await new UsDatasetCasesSeedStore(f.db).initialize(context, index);
    if (state === "N3") return;
    await new UsDatasetShippingSeedStore(f.db).initialize(context, index);
  }

  // Only public selected-unit entries are observed; recursive real in-transaction proof still runs.
  function observe(mode: Mode) {
    const calls: string[] = [],
      rejected: { at: string; error: unknown }[] = [];
    const receive = UsDatasetReceivingSeedStore.prototype[mode];
    const transform = UsDatasetTransformationSeedStore.prototype[mode];
    const cases = UsDatasetCasesSeedStore.prototype[mode];
    const reference = UsDatasetReferenceSeedStore.prototype[mode];
    const terminal = UsDatasetShippingSeedStore.prototype.verifyTerminalProjection;
    const initialize = UsDatasetShippingSeedStore.prototype.initializeTerminalProjection;
    async function forward<T>(at: string, call: () => Promise<T>): Promise<T> {
      calls.push(at);
      try {
        return await call();
      } catch (error) {
        rejected.push({ at, error });
        throw error;
      }
    }
    const spies = [
      vi.spyOn(UsDatasetReferenceSeedStore.prototype, mode).mockImplementation(function (
        this: UsDatasetReferenceSeedStore,
        ...args
      ) {
        return forward("references", () => reference.apply(this, args));
      }),
      vi.spyOn(UsDatasetReceivingSeedStore.prototype, mode).mockImplementation(function (
        this: UsDatasetReceivingSeedStore,
        ...args
      ) {
        return forward("receiving", () => receive.apply(this, args));
      }),
      vi.spyOn(UsDatasetTransformationSeedStore.prototype, mode).mockImplementation(function (
        this: UsDatasetTransformationSeedStore,
        ...args
      ) {
        return forward("transformation", () => transform.apply(this, args));
      }),
      vi.spyOn(UsDatasetCasesSeedStore.prototype, mode).mockImplementation(function (
        this: UsDatasetCasesSeedStore,
        ...args
      ) {
        return forward("cases", () => cases.apply(this, args));
      }),
      vi
        .spyOn(UsDatasetShippingSeedStore.prototype, "verifyTerminalProjection")
        .mockImplementation(function (this: UsDatasetShippingSeedStore, ...args) {
          return forward("shipping", () => terminal.apply(this, args));
        }),
      vi
        .spyOn(UsDatasetShippingSeedStore.prototype, "initializeTerminalProjection")
        .mockImplementation(function (this: UsDatasetShippingSeedStore, ...args) {
          return forward("shipping-initialize", () => initialize.apply(this, args));
        }),
    ];
    return { calls, rejected, restore: () => spies.forEach((spy) => spy.mockRestore()) };
  }

  const targetCases = [
    ["A1-1I foreign-existing-tenant-I", "tenant", "initialize"],
    ["A1-1V foreign-existing-tenant-V", "tenant", "verify"],
    ["A1-2I foreign-existing-actor-I", "actor", "initialize"],
    ["A1-2V foreign-existing-actor-V", "actor", "verify"],
    ["A1-3I wrong-expected-database-I", "database", "initialize"],
    ["A1-3V wrong-expected-database-V", "database", "verify"],
    ["A1-4I wrong-expected-user-I", "user", "initialize"],
    ["A1-4V wrong-expected-user-V", "user", "verify"],
    ["A1-5I actual-alternate-role-I", "role", "initialize"],
    ["A1-5V actual-alternate-role-V", "role", "verify"],
    ["A1-6I membership-removed-I", "membership", "initialize"],
    ["A1-6V membership-removed-V", "membership", "verify"],
    ["A1-7I nonowner-role-I", "nonowner", "initialize"],
    ["A1-7V nonowner-role-V", "nonowner", "verify"],
    ["A1-8I required-profile-missing-I", "profile", "initialize"],
    ["A1-8V required-profile-missing-V", "profile", "verify"],
    ["A1-9I timezone-not-target-I", "timezone", "initialize"],
    ["A1-9V timezone-not-target-V", "timezone", "verify"],
  ] as const;
  for (const [name, mutation, mode] of targetCases)
    describe(name, () => {
      let context: UsDatasetContext, db: Db, before: Awaited<ReturnType<typeof checkpoint>>;
      beforeEach(
        h.phase(async () => {
          context = { ...h.context };
          db = h.f.db;
          const id = randomUUID();
          if (mutation === "tenant") {
            await h.f.pool.query(
              "INSERT INTO organization (id,name,slug,created_at) VALUES ($1,'Synthetic foreign organization',$2,now())",
              [id, id],
            );
            context = { ...context, tenantId: id };
          } else if (mutation === "actor") {
            await h.f.pool.query(
              "INSERT INTO \"user\" (id,name,email,created_at,updated_at) VALUES ($1,'Synthetic foreign actor',$2,now(),now())",
              [id, `${id}@example.test`],
            );
            context = { ...context, actorUserId: id };
          } else if (mutation === "database")
            context = { ...context, expectedDatabaseName: "markiro_us_dev" };
          // A deliberately invalid wire value exercises runtime target validation.
          else if (mutation === "user")
            context = {
              ...context,
              expectedDatabaseUser: "postgres",
            } as unknown as UsDatasetContext;
          else if (mutation === "role") {
            db = await h.f.alternateRole();
            const result = await db.execute<{ role: string }>(sql`SELECT current_user AS role`);
            expect(result.rows.map((row) => row.role)).toEqual(["pg_read_all_data"]);
          } else if (mutation === "membership")
            await h.f.pool.query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2", [
              context.tenantId,
              context.actorUserId,
            ]);
          else if (mutation === "nonowner")
            await h.f.pool.query(
              "UPDATE member SET role='viewer' WHERE organization_id=$1 AND user_id=$2",
              [context.tenantId, context.actorUserId],
            );
          else if (mutation === "profile")
            await h.f.pool.query("DELETE FROM traceability_profiles WHERE tenant_id=$1", [
              context.tenantId,
            ]);
          else
            await h.f.pool.query("UPDATE org_profiles SET time_zone='UTC' WHERE tenant_id=$1", [
              context.tenantId,
            ]);
          before = await checkpoint();
        }),
        60_000,
      );
      it(
        name,
        h.phase(async () => {
          let reads = 0;
          const hostile = {
            get kind() {
              reads++;
              return "regular" as const;
            },
            index: 0,
          };
          const seen = observe(mode);
          try {
            const result = await outcome(owner(db)[mode](context, hostile));
            expect(result.value).toBeUndefined();
            const error = errorValue(result.error, "us_dataset_target_invalid");
            annotations(error, "unknown", "target");
            absent(error, "cause");
            expect(reads).toBe(0);
            expect(seen.calls).toEqual([]);
            await noWrites(before);
          } finally {
            seen.restore();
          }
        }),
      );
    });

  const selectors = [
    ["A2-1I selector-null-I", null, "initialize", "us_demo_json_invalid"],
    ["A2-1V selector-null-V", null, "verify", "us_demo_json_invalid"],
    ["A2-2I selector-empty-I", {}, "initialize"],
    ["A2-2V selector-empty-V", {}, "verify"],
    ["A2-3I selector-negative-zero-I", { kind: "regular", index: -0 }, "initialize"],
    ["A2-3V selector-negative-zero-V", { kind: "regular", index: -0 }, "verify"],
    ["A2-4I selector-negative-one-I", { kind: "regular", index: -1 }, "initialize"],
    ["A2-4V selector-negative-one-V", { kind: "regular", index: -1 }, "verify"],
    ["A2-5I selector-out-of-range-I", { kind: "regular", index: 260 }, "initialize"],
    ["A2-5V selector-out-of-range-V", { kind: "regular", index: 260 }, "verify"],
    ["A2-6I selector-fractional-I", { kind: "regular", index: 0.5 }, "initialize"],
    ["A2-6V selector-fractional-V", { kind: "regular", index: 0.5 }, "verify"],
    ["A2-7I selector-extra-property-I", { kind: "regular", index: 0, extra: true }, "initialize"],
    ["A2-7V selector-extra-property-V", { kind: "regular", index: 0, extra: true }, "verify"],
    ["A2-8I selector-correction-index-I", { kind: "correction", index: 0 }, "initialize"],
    ["A2-8V selector-correction-index-V", { kind: "correction", index: 0 }, "verify"],
    ["A2-9I selector-orphan-extra-I", { kind: "orphan", extra: true }, "initialize"],
    ["A2-9V selector-orphan-extra-V", { kind: "orphan", extra: true }, "verify"],
  ] as const;
  for (const row of selectors)
    describe(row[0], () => {
      let before: Awaited<ReturnType<typeof checkpoint>>;
      beforeEach(
        h.phase(async () => {
          before = await checkpoint();
        }),
        60_000,
      );
      it(
        row[0],
        h.phase(async () => {
          const [name, selector, mode] = row;
          void name;
          // Deliberately violate the typed API only at its untrusted runtime selector boundary.
          const result = await outcome(
            owner()[mode](h.context, selector as UsDatasetTraceReadinessUnit),
          );
          expect(result.value).toBeUndefined();
          const error = errorValue(
            result.error,
            row.length === 4 ? row[3] : "us_dataset_trace_readiness_unit_invalid",
          );
          annotations(error, "unknown", "selector");
          absent(error, "cause");
          await noWrites(before);
        }),
      );
    });
  const incompleteCases = [
    ["A3-1 references-no-header-V", "F", "references", "us_dataset_references_incomplete"],
    ["A3-2 references-no-row-V", "H", "references", "us_dataset_references_incomplete"],
    ["A3-3 references-pending-V", "RP", "references", "us_dataset_references_incomplete"],
    ["B1-1 missing-receiving-V", "R", "receiving", "us_dataset_receiving_prerequisite_incomplete"],
    [
      "B1-2 missing-transformation-V",
      "N1",
      "transformation",
      "us_dataset_transformation_prerequisite_incomplete",
    ],
    ["B1-3 missing-cases-V", "N2", "cases", "us_dataset_cases_prerequisite_incomplete"],
    ["B1-4 missing-shipping-V", "N3", "shipping", "us_dataset_shipping_prerequisite_incomplete"],
    [
      "B2-1 pending-receiving-V",
      "PReceiving",
      "receiving",
      "us_dataset_receiving_prerequisite_incomplete",
    ],
    [
      "B2-2 pending-transformation-V",
      "PTransformation",
      "transformation",
      "us_dataset_transformation_prerequisite_incomplete",
    ],
    ["B2-3 pending-cases-V", "PCases", "cases", "us_dataset_cases_prerequisite_incomplete"],
    [
      "B2-4 pending-shipping-V",
      "PShipping",
      "shipping",
      "us_dataset_shipping_prerequisite_incomplete",
    ],
  ] as const;
  for (const [name, state, boundary, message] of incompleteCases)
    describe(name, () => {
      let before: Awaited<ReturnType<typeof checkpoint>>;
      beforeEach(
        h.phase(async () => {
          await prepare(state);
          if (state.startsWith("P")) {
            const pending = await stage(boundary);
            expect(pending?.revision).toBe(1);
            expect(pending?.receipt).toBeNull();
          }
          before = await checkpoint();
        }),
        60_000,
      );
      it(
        name,
        h.phase(async () => {
          const seen = observe("verify");
          try {
            const result = await outcome(owner().verify(h.context, regular));
            expect(result.value).toBeUndefined();
            const error = errorValue(result.error, message);
            annotations(error, boundary === "references" ? "references" : "chain_0000", boundary);
            absent(error, "cause");
            const order = ["references", "receiving", "transformation", "cases", "shipping"];
            expect(seen.calls).toEqual(order.slice(0, order.indexOf(boundary) + 1));
            await noWrites(before);
          } finally {
            seen.restore();
          }
        }),
      );
    });

  const driftCases = [
    ["A4-I reference-drift-before-receiving-I", "R", "references", "initialize"],
    ["A4-V reference-drift-before-receiving-V", "R", "references", "verify"],
    ["B3-1MI receiving-drift-before-transformation-missing-I", "N1", "receiving", "initialize"],
    ["B3-1MV receiving-drift-before-transformation-missing-V", "N1", "receiving", "verify"],
    [
      "B3-1PI receiving-drift-before-transformation-pending-I",
      "PTransformation",
      "receiving",
      "initialize",
    ],
    [
      "B3-1PV receiving-drift-before-transformation-pending-V",
      "PTransformation",
      "receiving",
      "verify",
    ],
    ["B3-2MI transformation-drift-before-cases-missing-I", "N2", "transformation", "initialize"],
    ["B3-2MV transformation-drift-before-cases-missing-V", "N2", "transformation", "verify"],
    [
      "B3-2PI transformation-drift-before-cases-pending-I",
      "PCases",
      "transformation",
      "initialize",
    ],
    ["B3-2PV transformation-drift-before-cases-pending-V", "PCases", "transformation", "verify"],
    ["B3-3MI cases-drift-before-shipping-missing-I", "N3", "cases", "initialize"],
    ["B3-3MV cases-drift-before-shipping-missing-V", "N3", "cases", "verify"],
    ["B3-3PI cases-drift-before-shipping-pending-I", "PShipping", "cases", "initialize"],
    ["B3-3PV cases-drift-before-shipping-pending-V", "PShipping", "cases", "verify"],
  ] as const;
  for (const [name, state, boundary, mode] of driftCases)
    describe(name, () => {
      let before: Awaited<ReturnType<typeof checkpoint>>;
      beforeEach(
        h.phase(async () => {
          await prepare(state);
          const { f, context } = h;
          const command = {
            operationKey: randomUUID(),
            expectedLifecycleVersion: 2,
            reason: "Synthetic owner semantics drift",
          };
          if (boundary === "references") {
            const refs = await new UsDatasetReferenceSeedStore(f.db).verify(context);
            const product = refs.bindings.products[0];
            if (!product) throw new Error("Missing seeded product");
            expect(
              (
                await f.pool.query(
                  "UPDATE products SET name=name||' synthetic drift' WHERE tenant_id=$1 AND id=$2",
                  [context.tenantId, product.id],
                )
              ).rowCount,
            ).toBe(1);
          } else if (boundary === "receiving") {
            const result = await new UsDatasetReceivingSeedStore(f.db).verify(context, 0);
            await new UsReceivingStore(f.db).amend(
              context.tenantId,
              context.actorUserId,
              result.finalized.eventId,
              { ...command, commandVersion: 2 },
              "synthetic-owner-receiving",
            );
          } else if (boundary === "transformation") {
            const result = await new UsDatasetTransformationSeedStore(f.db).verify(context, 0);
            await new UsTransformationStore(f.db).amend(
              context.tenantId,
              context.actorUserId,
              result.finalized.id,
              command,
              "synthetic-owner-transformation",
            );
          } else {
            const result = await new UsDatasetCasesSeedStore(f.db).verify(context, 0);
            const first = result.linked.created[0];
            if (!first) throw new Error("Missing active case link");
            await new UsCaseStore(f.db).unlink(
              context.tenantId,
              context.actorUserId,
              result.input.outputLotId,
              first.linkId,
              { operationKey: command.operationKey, reason: command.reason },
              "synthetic-owner-case",
            );
          }
          before = await checkpoint();
        }),
        60_000,
      );
      it(
        name,
        h.phase(async () => {
          const seen = observe(mode);
          try {
            const result = await outcome(owner()[mode](h.context, regular));
            expect(result.value).toBeUndefined();
            const error = errorValue(result.error, "us_dataset_native_drift");
            const native = seen.rejected.find((entry) => entry.at === boundary)?.error;
            const message =
              boundary === "references"
                ? "us_dataset_reference_mismatch"
                : `us_dataset_${boundary}_mismatch`;
            const e = errorValue(native, message);
            causeValue(error, e);
            expect(error === e).toBe(false);
            const key = boundary === "references" ? "references" : "chain_0000";
            annotations(error, key, boundary);
            annotations(e, key, boundary);
            if (boundary === "cases") {
              const c = errorValue(
                Object.getOwnPropertyDescriptor(e, "cause")?.value,
                "us_dataset_cases_mismatch",
              );
              causeValue(e, c);
              expect(e === c).toBe(false);
              absent(c, "cause");
              annotations(c, key, boundary);
            } else absent(e, "cause");
            const order = ["references", "receiving", "transformation", "cases", "shipping"];
            expect(seen.calls).toEqual(order.slice(0, order.indexOf(boundary) + 1));
            await noWrites(before);
          } finally {
            seen.restore();
          }
        }),
      );
    });
  // The oracle uses checked standalone outputs and literal recipe facts, never the owner/engine/comparator.
  type RegularNativeFacts = {
    receiving: Awaited<ReturnType<UsDatasetReceivingSeedStore["verify"]>>;
    transformation: Awaited<ReturnType<UsDatasetTransformationSeedStore["verify"]>>;
    cases: Awaited<ReturnType<UsDatasetCasesSeedStore["verify"]>>;
    shipping: Awaited<ReturnType<UsDatasetShippingSeedStore["verify"]>>;
  };
  async function oracle(
    unit: UsDatasetTraceReadinessUnit,
  ): Promise<{ output: NativeTraceOutput; regularFacts: RegularNativeFacts | null }> {
    const { db } = h.f,
      context = h.context;
    const current = await header();
    let native: NativeTraceOutput["native"];
    let lots: readonly TraceabilityLot[];
    let receiving: ReceivingLiveRecord | undefined;
    let transformation: TransformationFinalizedRecord | undefined;
    let shipments: readonly UsDatasetShippingShipmentResult[] = [];
    let historical: ReceivingLiveRecord | undefined;
    let receivingQuantities: readonly string[];
    let outputQuantity: string | undefined;
    let shippingQuantities: readonly string[] = [];
    let regularFacts: RegularNativeFacts | null = null;
    const key =
      unit.kind === "regular"
        ? `chain_${String(unit.index).padStart(4, "0")}`
        : `${unit.kind}_0001`;
    if (unit.kind === "regular") {
      const r = await new UsDatasetReceivingSeedStore(db).verify(context, unit.index);
      const t = await new UsDatasetTransformationSeedStore(db).verify(context, unit.index);
      const c = await new UsDatasetCasesSeedStore(db).verify(context, unit.index);
      const s = await new UsDatasetShippingSeedStore(db).verify(context, unit.index);
      regularFacts = { receiving: r, transformation: t, cases: c, shipping: s };
      const facts = {
        0: { input: ["300", "400"], output: "55", shipped: ["22", "23"], status: "active" },
        1: { input: ["325.5", "425"], output: "65", shipped: ["26", "39"], status: "shipped" },
        181: { input: ["325.5", "425"], output: "75", shipped: ["57"], status: "active" },
        259: { input: ["500", "500"], output: "100", shipped: ["100"], status: "shipped" },
      } as const;
      if (unit.index !== 0 && unit.index !== 1 && unit.index !== 181 && unit.index !== 259)
        throw new Error("Unlisted oracle index");
      const want = facts[unit.index],
        recipe = makeUsSixMonthRegularChain(unit.index);
      exact(
        recipe.receiving.lines.map((line) => [line.quantity, line.unitOfMeasure]),
        want.input.map((quantity) => [quantity, "lb"]),
      );
      exact(
        recipe.shipping.map((line) => [line.quantity, line.unitOfMeasure]),
        want.shipped.map((quantity) => [quantity, "case"]),
      );
      expect(recipe.transformation.output.quantity).toBe(want.output);
      expect(s.outputLotAfter.status).toBe(want.status);
      expect(s.shipments.length).toBe(want.shipped.length);
      native = {
        index: unit.index,
        unitKey: key,
        shipmentCount: want.shipped.length,
        shippingResultDigest: canonicalExportDigest(s),
      };
      lots = [...r.lots, t.outputLot];
      receiving = r.finalized.record;
      transformation = t.finalized;
      shipments = s.shipments;
      receivingQuantities = want.input;
      outputQuantity = want.output;
      shippingQuantities = want.shipped;
    } else {
      const lifecycle = await new UsDatasetSpecialSeedStore(db).verify(context, unit.kind);
      if (unit.kind === "orphan") {
        if (lifecycle.stage !== "void_receiving") throw new Error("Expected real void lifecycle");
        native = {
          unitKey: "orphan_0001",
          lifecycleResultDigest: canonicalExportDigest(lifecycle),
        };
        lots = lifecycle.lots;
        historical = lifecycle.voided.record;
        receivingQuantities = ["200", "200"];
        expect(lots).toHaveLength(2);
      } else {
        if (lifecycle.stage !== "amend_receiving")
          throw new Error("Expected real amendment lifecycle");
        const t = await new UsDatasetCorrectedTransformationSeedStore(db).verify(context);
        const c = await new UsDatasetCorrectedCasesSeedStore(db).verify(context);
        const s = await new UsDatasetCorrectedShippingSeedStore(db).verify(context);
        native = {
          unitKey: "correction_0001",
          lifecycleResultDigest: canonicalExportDigest(lifecycle),
          transformationResultDigest: canonicalExportDigest(t),
          casesResultDigest: canonicalExportDigest(c),
          shippingResultDigest: canonicalExportDigest(s),
          shipmentCount: 1,
        };
        lots = [...lifecycle.lots, t.outputLot];
        receiving = lifecycle.finalized.record;
        transformation = t.finalized;
        shipments = s.shipments;
        historical = lifecycle.predecessor;
        receivingQuantities = ["300", "400"];
        outputQuantity = "60";
        shippingQuantities = ["50"];
        expect(s.shipments.length).toBe(1);
        expect(s.outputLotAfter.status).toBe("active");
        expect(lifecycle.predecessor.revision).toBe(1);
        expect(receiving.revision).toBe(2);
      }
      const recipe = makeUsSixMonthSpecialExamples();
      exact(
        (unit.kind === "orphan"
          ? recipe.orphan.receiving
          : recipe.correction.correctedChain.receiving
        ).lines.map((line) => [line.quantity, line.unitOfMeasure]),
        receivingQuantities.map((quantity) => [quantity, "lb"]),
      );
    }
    const events: UsCurrentTraceResult["currentEvents"] = [];
    const edges: UsCurrentTraceResult["edges"] = [];
    const nodes: UsCurrentTraceResult["nodes"] = lots.map((lot) => ({
      id: `lot:${lot.id}`,
      kind: "lot",
      lotId: lot.id,
      tlc: lot.tlc,
    }));
    if (receiving && transformation) {
      if (receiving.content.kind !== "finalized")
        throw new Error("Expected actual finalized Receiving");
      const r = receiving.content.snapshot,
        t = transformation;
      exact(
        r.items.map((line) => [line.quantity, line.unitOfMeasure]),
        receivingQuantities.map((quantity) => [quantity, "lb"]),
      );
      exact(
        t.snapshot.inputs.map((line) => [line.quantity, line.unitOfMeasure]),
        receivingQuantities.map((quantity) => [quantity, "lb"]),
      );
      exact(
        t.snapshot.outputs.map((line) => [line.quantity, line.unitOfMeasure]),
        [[outputQuantity, "case"]],
      );
      const rEvent = {
        id: receiving.id,
        rootId: receiving.lifecycle.rootId,
        type: "receiving" as const,
        eventNumber: receiving.eventNumber,
        revision: receiving.revision,
        eventDate: r.dateReceived,
        timeZone: receiving.timeZone,
      };
      const tEvent = {
        id: t.id,
        rootId: t.lifecycle?.rootId ?? t.id,
        type: "transformation" as const,
        eventNumber: t.eventNumber,
        revision: t.revision,
        eventDate: t.snapshot.eventDate,
        timeZone: t.timeZone,
      };
      events.push(rEvent, tEvent);
      const source = r.previousSourceDescription;
      // Both literal input lines share one source; the event's second line owns its display edge.
      nodes.push(
        {
          id: `location:${source.locationId}`,
          kind: "location",
          locationId: source.locationId,
          display: source.businessName,
          displayEdgeId: `${receiving.id}:receiving:2`,
        },
        {
          id: `transformation:${t.id}`,
          kind: "transformation",
          eventId: t.id,
          display: t.snapshot.processor.description,
        },
      );
      for (const line of r.items)
        edges.push({
          id: `${receiving.id}:receiving:${line.lineNo}`,
          kind: "receiving",
          from: `location:${source.locationId}`,
          to: `lot:${line.lotId}`,
          eventId: receiving.id,
          eventNumber: rEvent.eventNumber,
          revision: rEvent.revision,
          lineNo: line.lineNo,
          eventDate: rEvent.eventDate,
          timeZone: rEvent.timeZone,
          quantity: line.quantity,
          unitOfMeasure: line.unitOfMeasure,
          locationDisplay: source.businessName,
        });
      for (const line of t.snapshot.inputs) {
        if (line.kind !== "ftl_lot") throw new Error("Expected recipe FTL input");
        edges.push({
          id: `${t.id}:input:${line.lineNo}`,
          kind: "transformation_input",
          from: `lot:${line.lotId}`,
          to: `transformation:${t.id}`,
          eventId: t.id,
          eventNumber: tEvent.eventNumber,
          revision: tEvent.revision,
          lineNo: line.lineNo,
          eventDate: tEvent.eventDate,
          timeZone: tEvent.timeZone,
          quantity: line.quantity,
          unitOfMeasure: line.unitOfMeasure,
        });
      }
      for (const line of t.snapshot.outputs)
        edges.push({
          id: `${t.id}:output:${line.lineNo}`,
          kind: "transformation_output",
          from: `transformation:${t.id}`,
          to: `lot:${line.lotId}`,
          eventId: t.id,
          eventNumber: tEvent.eventNumber,
          revision: tEvent.revision,
          lineNo: line.lineNo,
          eventDate: tEvent.eventDate,
          timeZone: tEvent.timeZone,
          quantity: line.quantity,
          unitOfMeasure: line.unitOfMeasure,
        });
      exact(
        shipments.map(({ finalized }) =>
          finalized.snapshot.items.map((line) => [line.quantity, line.unitOfMeasure]),
        ),
        shippingQuantities.map((quantity) => [[quantity, "case"]]),
      );
      for (const { finalized: s } of shipments) {
        const event = {
          id: s.id,
          rootId: s.lifecycle?.rootId ?? s.id,
          type: "shipping" as const,
          eventNumber: s.eventNumber,
          revision: s.revision,
          eventDate: s.snapshot.eventDate,
          timeZone: s.timeZone,
        };
        events.push(event);
        const recipient = s.snapshot.recipient;
        nodes.push({
          id: `location:${recipient.locationId}`,
          kind: "location",
          locationId: recipient.locationId,
          display: recipient.businessName,
          displayEdgeId: `${s.id}:shipping:1`,
        });
        for (const line of s.snapshot.items)
          edges.push({
            id: `${s.id}:shipping:${line.lineNo}`,
            kind: "shipping",
            from: `lot:${line.lotId}`,
            to: `location:${recipient.locationId}`,
            eventId: s.id,
            eventNumber: event.eventNumber,
            revision: event.revision,
            lineNo: line.lineNo,
            eventDate: event.eventDate,
            timeZone: event.timeZone,
            quantity: line.quantity,
            unitOfMeasure: line.unitOfMeasure,
            locationDisplay: recipient.businessName,
          });
      }
    }
    let historyItem: UsTraceHistoryPage["items"][number] | undefined;
    if (historical) {
      const actual = await h.f.pool.query<UsTraceHistoryPage["items"][number]>(
        `SELECT id AS "eventId",root_event_id AS "rootId",type,event_number AS "eventNumber",revision,status,CASE WHEN status='void' THEN void_reason ELSE amendment_reason END AS reason,previous_revision_id AS "previousRevisionId",superseded_by_event_id AS "nextRevisionId",event_date::text AS "eventDate",to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt" FROM traceability_events WHERE tenant_id=$1 AND id=$2`,
        [context.tenantId, historical.id],
      );
      historyItem = actual.rows[0];
      if (!historyItem || actual.rows.length !== 1)
        throw new Error("Missing independent historical row");
      const { createdAt, ...historicalFacts } = historyItem;
      expect(Number.isFinite(Date.parse(createdAt))).toBe(true);
      exact(historicalFacts, {
        eventId: historical.id,
        rootId: historical.lifecycle.rootId,
        type: "receiving",
        eventNumber: historical.eventNumber,
        revision: historical.revision,
        status: unit.kind === "orphan" ? "void" : "amended",
        reason:
          unit.kind === "orphan"
            ? historical.lifecycle.voidReason
            : historical.lifecycle.amendmentReason,
        previousRevisionId: null,
        nextRevisionId: receiving?.id ?? null,
        eventDate: unit.kind === "orphan" ? "2026-08-10" : "2026-06-10",
      });
      expect(events.some((event) => event.id === historical?.id)).toBe(false);
    }
    const evidence: NativeTraceOutput["trace"]["evidence"][number][] = [];
    const traceStore = new UsTraceStore(db);
    for (const [position, lot] of lots.entries()) {
      const orphan = unit.kind === "orphan",
        output = position === 2;
      const graph = await traceStore.read(context.tenantId, context.actorUserId, lot.id, {
        direction: "both",
      });
      const root = { id: `lot:${lot.id}`, kind: "lot" as const, lotId: lot.id, tlc: lot.tlc };
      const expectedNodes = orphan
        ? [root]
        : [
            root,
            ...nodes
              .filter((node) => node.id !== root.id)
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
          ];
      exact(graph, {
        rootLotId: lot.id,
        direction: "both",
        nodes: expectedNodes,
        edges,
        currentEvents: events,
        excludedSummary: { count: historical ? 1 : 0 },
        findings: orphan ? [{ code: "origin_gap", lotId: lot.id }] : [],
        completion: {
          state: "complete",
          returnedNodes: expectedNodes.length,
          returnedEdges: edges.length,
        },
      });
      const readiness = await traceStore.readiness(context.tenantId, context.actorUserId, {
        eventDateFrom: "2026-04-01",
        eventDateTo: "2026-09-30",
        lotId: lot.id,
      });
      const { assessedAt, ...semantic } = readiness;
      expect(Number.isFinite(Date.parse(assessedAt))).toBe(true);
      const findings: UsReadinessResult["findings"] = [];
      if (orphan) {
        if (!historyItem) throw new Error("Missing void history");
        findings.push({
          key: `origin_gap:::${lot.id}:currentOrigin`,
          ruleVersion: "us-readiness-v1",
          code: "origin_gap",
          severity: "error",
          cte: null,
          field: "currentOrigin",
          message: { key: "readiness.origin_gap", params: {} },
          lotId: lot.id,
          productId: lot.productId,
          eventId: null,
          rootId: null,
          eventNumber: null,
          revision: null,
          eventDate: null,
          lineSide: null,
          lineNo: null,
          relatedEventId: historyItem.eventId,
          relatedEvent: {
            type: "receiving",
            eventNumber: historyItem.eventNumber,
            revision: historyItem.revision,
          },
          links: {
            lotHref: `/traceability/lots/${lot.id}`,
            eventHref: null,
            relatedEventHref: `/traceability/events/${historyItem.eventId}`,
          },
        });
      }
      exact(semantic.scope, {
        lotId: lot.id,
        productId: null,
        profileCode: "US_FSMA204_PROCESSOR",
        eventDateFrom: "2026-04-01",
        eventDateTo: "2026-09-30",
        defaulted: false,
      });
      expect(semantic.state).toBe("assessed");
      expect(semantic.recordsChecked).toEqual({
        events: orphan ? 0 : output ? 1 + shipments.length : 2,
        lots: orphan ? 1 : 3,
      });
      expect(semantic.dependenciesChecked).toBe(orphan ? 0 : output ? 2 + shipments.length : 2);
      exact(semantic.findings, findings);
      expect(semantic.counts).toEqual({ error: orphan ? 1 : 0, warning: 0, info: 0 });
      exact(
        semantic.groups,
        orphan
          ? {
              byCte: [{ cte: null, count: 1 }],
              byProduct: [{ productId: lot.productId, count: 1 }],
              bySeverity: [{ severity: "error", count: 1 }],
            }
          : { byCte: [], byProduct: [], bySeverity: [] },
      );
      expect(semantic.draftWork).toEqual({
        total: 0,
        items: [],
        hasMore: false,
        eventsHref: "/traceability/events",
      });
      const history = await traceStore.history(context.tenantId, context.actorUserId, lot.id, {
        limit: "100",
      });
      exact(history, { items: historyItem && !output ? [historyItem] : [], nextCursor: null });
      evidence.push({
        lotId: lot.id,
        traceDigest: canonicalExportDigest(graph),
        readinessDigest: canonicalExportDigest(semantic),
        historyDigest: canonicalExportDigest(history),
        originGap: orphan,
      });
    }
    const trace = {
      datasetId: current.id,
      version: "us-processor-six-month-v1" as const,
      definitionDigest: current.definitionDigest,
      unitKey: key,
      state: "trace_readiness_verified" as const,
      datasetComplete: false as const,
      lotIds: lots.map((lot) => lot.id),
      currentEventIds: events.map((event) => event.id),
      evidence,
    };
    if (unit.kind === "regular" && "index" in native)
      return { output: { kind: "regular", native, trace }, regularFacts };
    if (unit.kind === "correction" && "transformationResultDigest" in native)
      return { output: { kind: "correction", native, trace }, regularFacts };
    if (
      unit.kind === "orphan" &&
      "lifecycleResultDigest" in native &&
      native.unitKey === "orphan_0001"
    )
      return { output: { kind: "orphan", native, trace }, regularFacts };
    throw new Error("Oracle discriminant mismatch");
  }

  function ownedOutput(actual: NativeTraceOutput, expected: NativeTraceOutput) {
    exact(actual, expected);
    const values = [
      actual,
      actual.native,
      actual.trace,
      actual.trace.lotIds,
      actual.trace.currentEventIds,
      actual.trace.evidence,
      ...actual.trace.evidence,
    ];
    const old = [
      expected,
      expected.native,
      expected.trace,
      expected.trace.lotIds,
      expected.trace.currentEventIds,
      expected.trace.evidence,
      ...expected.trace.evidence,
    ];
    for (const [index, value] of values.entries()) {
      expect(Object.isFrozen(value)).toBe(true);
      expect(value === old[index]).toBe(false);
    }
    expect(Buffer.byteLength(JSON.stringify(actual))).toBeLessThan(256 * 1024);
  }
  async function progressMatches(
    expected: NativeTraceOutput,
    unit: UsDatasetTraceReadinessUnit,
    prior?: UsDatasetStageRow | null,
  ) {
    const key = expected.trace.unitKey;
    const saved = await stage("trace_readiness", key);
    const predecessor = await stage(unit.kind === "orphan" ? "void_receiving" : "shipping", key);
    if (!saved || !predecessor?.receipt) throw new Error("Missing real progress or predecessor");
    expect(saved.revision).toBe(2);
    expect(predecessor.revision).toBe(2);
    const input = {
      codec: "us-dataset-trace-readiness-stage-v1",
      datasetId: expected.trace.datasetId,
      version: "us-processor-six-month-v1",
      definitionDigest: usSixMonthDefinition.digest,
      unit,
      predecessor: {
        unitKey: key,
        stage: unit.kind === "orphan" ? "void_receiving" : "shipping",
        operationKey: predecessor.intent.operationKey,
        inputDigest: predecessor.intent.inputDigest,
        resultDigest: predecessor.receipt.resultDigest,
        revision: 2,
      },
    };
    exact(saved.intent.input, input);
    expect(saved.intent.inputDigest).toBe(canonicalExportDigest(input));
    exact(saved.receipt, {
      result: expected.trace,
      resultDigest: canonicalExportDigest(expected.trace),
      recordIds: [...new Set([...expected.trace.lotIds, ...expected.trace.currentEventIds])],
    });
    if (prior) exact(saved.intent, prior.intent);
    return saved;
  }
  async function onlyProgressChanged(before: Awaited<ReturnType<typeof checkpoint>>) {
    const after = await checkpoint();
    const native = (snapshot: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(snapshot).filter(([table]) => table !== "traceability_demo_dataset_stages"),
      );
    expect(native(after.snapshot)).toEqual(native(before.snapshot));
    exact(
      after.journal.filter(({ row }) => row.stage !== "trace_readiness"),
      before.journal.filter(({ row }) => row.stage !== "trace_readiness"),
    );
    expect(after.journal.filter(({ row }) => row.stage === "trace_readiness")).toHaveLength(1);
  }
  async function pendingProgress(own: OwnCleanup, test: TestContext) {
    const remove = await receiptFault(own, test, "trace_readiness", false);
    const failed = await outcome(progress().initialize(h.context, regular));
    expect(failed.value).toBeUndefined();
    const error = failed.error;
    if (!(error instanceof Error)) throw new Error("Expected real journal receipt rejection");
    const driver = Object.getOwnPropertyDescriptor(error, "cause")?.value;
    if (!driver || typeof driver !== "object") throw new Error("Missing real receipt driver error");
    expect(Object.getOwnPropertyDescriptor(driver, "code")?.value).toBe("40001");
    expect(Object.getOwnPropertyDescriptor(driver, "message")?.value).toBe("special_sql_fault");
    await remove();
    const saved = await stage("trace_readiness");
    if (!saved) throw new Error("Missing real pending progress");
    expect(saved.revision).toBe(1);
    expect(saved.receipt).toBeNull();
    return saved;
  }
  const successCases = [
    ["C1-0-capture regular-0-capture", { kind: "regular", index: 0 }, "capture"],
    ["C1-0-verify regular-0-verify", { kind: "regular", index: 0 }, "verify"],
    ["C1-0-replay regular-0-replay", { kind: "regular", index: 0 }, "replay"],
    ["C1-1-capture regular-1-capture", { kind: "regular", index: 1 }, "capture"],
    ["C1-1-verify regular-1-verify", { kind: "regular", index: 1 }, "verify"],
    ["C1-1-replay regular-1-replay", { kind: "regular", index: 1 }, "replay"],
    ["C1-181-capture regular-181-capture", { kind: "regular", index: 181 }, "capture"],
    ["C1-181-verify regular-181-verify", { kind: "regular", index: 181 }, "verify"],
    ["C1-181-replay regular-181-replay", { kind: "regular", index: 181 }, "replay"],
    ["C1-259-capture regular-259-capture", { kind: "regular", index: 259 }, "capture"],
    ["C1-259-verify regular-259-verify", { kind: "regular", index: 259 }, "verify"],
    ["C1-259-replay regular-259-replay", { kind: "regular", index: 259 }, "replay"],
    ["C2-correction-capture correction-capture", { kind: "correction" }, "capture"],
    ["C2-correction-verify correction-verify", { kind: "correction" }, "verify"],
    ["C2-correction-replay correction-replay", { kind: "correction" }, "replay"],
    ["C2-orphan-capture orphan-capture", { kind: "orphan" }, "capture"],
    ["C2-orphan-verify orphan-verify", { kind: "orphan" }, "verify"],
    ["C2-orphan-replay orphan-replay", { kind: "orphan" }, "replay"],
    ["C4-1 progress-pending-resume-I", { kind: "regular", index: 0 }, "resume"],
  ] as const;
  for (const [name, unit, action] of successCases)
    describe(name, () => {
      let expected: NativeTraceOutput,
        before: Awaited<ReturnType<typeof checkpoint>>,
        prior: UsDatasetStageRow | null;
      beforeEach(
        h.phase(async (test: TestContext) => {
          await prepare(
            unit.kind === "regular" ? "N4" : unit.kind === "correction" ? "NC" : "NO",
            unit.kind === "regular" ? unit.index : 0,
          );
          expected = (await oracle(unit)).output;
          if (action === "verify" || action === "replay")
            await progress().initialize(h.context, unit);
          if (action === "resume") await withOwnedWork((own) => pendingProgress(own, test));
          prior = await stage("trace_readiness", expected.trace.unitKey);
          if (action === "capture") expect(prior).toBeNull();
          else if (action === "resume") {
            expect(prior?.revision).toBe(1);
            expect(prior?.receipt).toBeNull();
          } else await progressMatches(expected, unit);
          before = await checkpoint();
        }),
        60_000,
      );
      it(
        name,
        h.phase(async () => {
          const mode = action === "verify" ? "verify" : "initialize";
          const seen = observe(mode),
            specialCalls: string[] = [];
          const special = UsDatasetSpecialSeedStore.prototype[mode],
            t = UsDatasetCorrectedTransformationSeedStore.prototype[mode],
            c = UsDatasetCorrectedCasesSeedStore.prototype[mode],
            s = UsDatasetCorrectedShippingSeedStore.prototype[mode];
          let depth = 0;
          async function specialForward<T>(label: string, fn: () => Promise<T>): Promise<T> {
            if (depth === 0) specialCalls.push(label);
            depth++;
            try {
              return await fn();
            } finally {
              depth--;
            }
          }
          const spies = [
            vi.spyOn(UsDatasetSpecialSeedStore.prototype, mode).mockImplementation(function (
              this: UsDatasetSpecialSeedStore,
              ...args
            ) {
              return specialForward(`lifecycle:${args[1]}`, () => special.apply(this, args));
            }),
            vi
              .spyOn(UsDatasetCorrectedTransformationSeedStore.prototype, mode)
              .mockImplementation(function (
                this: UsDatasetCorrectedTransformationSeedStore,
                ...args
              ) {
                return specialForward("transformation", () => t.apply(this, args));
              }),
            vi.spyOn(UsDatasetCorrectedCasesSeedStore.prototype, mode).mockImplementation(function (
              this: UsDatasetCorrectedCasesSeedStore,
              ...args
            ) {
              return specialForward("cases", () => c.apply(this, args));
            }),
            vi
              .spyOn(UsDatasetCorrectedShippingSeedStore.prototype, mode)
              .mockImplementation(function (this: UsDatasetCorrectedShippingSeedStore, ...args) {
                return specialForward("shipping", () => s.apply(this, args));
              }),
            vi.spyOn(UsDatasetSpecialChainsSeedStore.prototype, "initialize"),
            vi.spyOn(UsDatasetSpecialChainsSeedStore.prototype, "verify"),
          ];
          const read = UsTraceStore.prototype.read;
          const traceSpy = vi.spyOn(UsTraceStore.prototype, "read").mockImplementation(function (
            this: UsTraceStore,
            ...args
          ) {
            if (unit.kind !== "regular")
              expect(specialCalls).toEqual(
                unit.kind === "correction"
                  ? ["lifecycle:correction", "transformation", "cases", "shipping"]
                  : ["lifecycle:orphan"],
              );
            return read.apply(this, args);
          });
          try {
            const actual = await owner()[mode](h.context, unit);
            ownedOutput(actual, expected);
            if (unit.kind === "regular") expect(seen.calls).toEqual(["references", "shipping"]);
            expect(spies[4]).not.toHaveBeenCalled();
            expect(spies[5]).not.toHaveBeenCalled();
            expect(traceSpy).toHaveBeenCalledTimes(expected.trace.lotIds.length);
            await progressMatches(expected, unit, prior);
            if (action === "verify" || action === "replay") await noWrites(before);
            else await onlyProgressChanged(before);
            const keys = [...new Set((await rawJournal()).map(({ row }) => row.unit_key))].sort();
            expect(keys).toEqual([expected.trace.unitKey, "references"].sort());
          } finally {
            traceSpy.mockRestore();
            spies.forEach((spy) => spy.mockRestore());
            seen.restore();
          }
        }),
      );
    });

  // Only these physical rows can be created by the four finite B4 continuations.
  // All other public tables remain byte-hash equal; old rows within these tables
  // remain exact too, except the explicitly enumerated lot epochs/pending receipt.
  const partialKeys = {
    reference_documents: ["id"],
    traceability_events: ["id"],
    traceability_lots: ["id"],
    transformation_event_roots: ["id"],
    transformation_event_details: ["event_id"],
    transformation_event_inputs: ["event_id", "line_no"],
    transformation_event_outputs: ["event_id", "line_no"],
    transformation_event_documents: ["event_id", "document_id"],
    lot_genealogy_edges: ["event_id", "input_lot_id", "output_lot_id"],
    transformation_counters: ["year"],
    transformation_operations: ["command", "operation_key"],
    shifts: ["id"],
    boxes: ["id"],
    traceability_synthetic_case_origins: ["box_id"],
    trace_lot_boxes: ["id"],
    trace_lot_box_operations: ["command", "operation_key"],
    shipping_event_roots: ["id"],
    shipping_event_details: ["event_id"],
    shipping_event_items: ["event_id", "line_no"],
    shipping_event_documents: ["event_id", "document_id"],
    shipping_counters: ["year"],
    shipping_operations: ["command", "operation_key"],
    tenant_audit_events: ["id"],
    traceability_demo_dataset_stages: ["unit_key", "stage"],
  } as const;
  type PartialTable = keyof typeof partialKeys;
  type PartialRow = Record<string, unknown>;
  const partialTables = Object.keys(partialKeys).filter(
    (table): table is PartialTable => table in partialKeys,
  );
  async function partialRows() {
    const rows = new Map<PartialTable, PartialRow[]>(partialTables.map((table) => [table, []]));
    const result = await h.f.pool.query<{ table: PartialTable; row: PartialRow }>(
      partialTables
        .map((table) => `SELECT '${table}' AS table,to_jsonb(t) AS row FROM "${table}" t`)
        .join(" UNION ALL "),
    );
    for (const entry of result.rows) {
      const bucket = rows.get(entry.table);
      if (!bucket) throw new Error("Unexpected partial census table");
      bucket.push(entry.row);
    }
    return rows;
  }
  function partialKey(table: PartialTable, row: PartialRow) {
    const values = partialKeys[table].map((field) => {
      if (!(field in row)) throw new Error("Missing partial census key");
      return row[field];
    });
    return canonicalExportDigest([row.tenant_id ?? row.organization_id, ...values]);
  }
  async function partialDelta(
    state: "N1" | "N2" | "N3" | "PShipping",
    before: Awaited<ReturnType<typeof checkpoint>>,
    beforeRows: Awaited<ReturnType<typeof partialRows>>,
    facts: RegularNativeFacts,
  ) {
    const { receiving: r, transformation: t, cases: c, shipping: s } = facts;
    const { tenantId, actorUserId } = h.context;
    const newTransformation = state === "N1",
      newCases = state === "N1" || state === "N2";
    const added = new Map<PartialTable, PartialRow[]>(partialTables.map((table) => [table, []]));
    const add = (table: PartialTable, rows: PartialRow[]) => {
      const target = added.get(table);
      if (!target) throw new Error("Missing finite table");
      target.push(...rows.map((row) => ({ tenant_id: tenantId, ...row })));
    };
    const tId = t.finalized.id,
      tKey = c.input.transformation.operationKey;
    const year = (eventNumber: string) => Number(`20${eventNumber.slice(4, 6)}`);
    if (newTransformation) {
      add(
        "reference_documents",
        t.documents.map(({ record }) => ({ id: record.id })),
      );
      add("traceability_events", [{ id: tId }]);
      add("traceability_lots", [{ id: t.outputLot.id }]);
      add("transformation_event_roots", [{ id: tId }]);
      add("transformation_event_details", [{ event_id: tId }]);
      add(
        "transformation_event_inputs",
        [1, 2].map((line_no) => ({ event_id: tId, line_no })),
      );
      add("transformation_event_outputs", [{ event_id: tId, line_no: 1 }]);
      add(
        "transformation_event_documents",
        t.documents.map(({ record }) => ({ event_id: tId, document_id: record.id })),
      );
      add(
        "lot_genealogy_edges",
        r.lots.map((lot) => ({
          event_id: tId,
          input_lot_id: lot.id,
          output_lot_id: t.outputLot.id,
        })),
      );
      add("transformation_counters", [{ year: year(t.finalized.eventNumber) }]);
      add(
        "transformation_operations",
        ["transformation.create", "transformation.finalize"].map((command) => ({
          command,
          operation_key: tKey,
        })),
      );
    }
    if (newCases) {
      add("shifts", [{ id: c.support.shift.id }]);
      add(
        "boxes",
        c.support.boxes.map(({ id }) => ({ id })),
      );
      add(
        "traceability_synthetic_case_origins",
        c.support.markers.map(({ boxId }) => ({ box_id: boxId })),
      );
      add(
        "trace_lot_boxes",
        c.linked.created.map(({ linkId }) => ({ id: linkId })),
      );
      add("trace_lot_box_operations", [{ command: "case.link", operation_key: c.operationKey }]);
    }
    for (const shipment of s.shipments) {
      const id = shipment.finalized.id;
      add(
        "reference_documents",
        shipment.documents.map(({ record }) => ({ id: record.id })),
      );
      add("traceability_events", [{ id }]);
      add("shipping_event_roots", [{ id }]);
      add("shipping_event_details", [{ event_id: id }]);
      add("shipping_event_items", [{ event_id: id, line_no: 1 }]);
      add(
        "shipping_event_documents",
        shipment.documents.map(({ record }) => ({ event_id: id, document_id: record.id })),
      );
      add(
        "shipping_operations",
        ["shipping.create", "shipping.finalize"].map((command) => ({
          command,
          operation_key: shipment.operationKey,
        })),
      );
    }
    const firstShipment = s.shipments[0];
    if (!firstShipment || s.shipments.length !== 2)
      throw new Error("Expected literal two-shipment chain zero");
    add("shipping_counters", [{ year: year(firstShipment.finalized.eventNumber) }]);
    add(
      "traceability_demo_dataset_stages",
      [
        ...(newTransformation ? ["transformation"] : []),
        ...(newCases ? ["cases"] : []),
        ...(state !== "PShipping" ? ["shipping"] : []),
        "trace_readiness",
      ].map((stage) => ({ unit_key: "chain_0000", stage })),
    );

    const afterRows = await partialRows();
    const afterSnapshot = await h.f.snapshot();
    const allowed = new Set<string>([
      "traceability_lots",
      "traceability_demo_dataset_stages",
      "tenant_audit_events",
    ]);
    for (const [table, rows] of added) if (rows.length) allowed.add(table);
    exact(Object.keys(afterSnapshot).sort(), Object.keys(before.snapshot).sort());
    for (const [table, hash] of Object.entries(before.snapshot))
      if (!allowed.has(table)) expect(afterSnapshot[table]).toBe(hash);

    const additions = new Map<PartialTable, PartialRow[]>();
    for (const table of partialTables) {
      const old = beforeRows.get(table),
        current = afterRows.get(table);
      if (!old || !current) throw new Error("Missing partial table census");
      const oldKeys = new Set(old.map((row) => partialKey(table, row)));
      const fresh = current.filter((row) => !oldKeys.has(partialKey(table, row)));
      additions.set(table, fresh);
      for (const row of old) {
        const saved = current.find(
          (candidate) => partialKey(table, candidate) === partialKey(table, row),
        );
        if (!saved) throw new Error("Partial owner removed an existing row");
        if (table === "traceability_lots") {
          const delta =
            row.id === t.outputLot.id
              ? newCases
                ? 3
                : 2
              : newTransformation && r.lots.some((lot) => lot.id === row.id)
                ? 1
                : 0;
          if (typeof row.current_dependency_version !== "number")
            throw new Error("Invalid original lot epoch");
          exact(saved, {
            ...row,
            current_dependency_version: row.current_dependency_version + delta,
          });
        } else if (
          table === "traceability_demo_dataset_stages" &&
          state === "PShipping" &&
          row.unit_key === "chain_0000" &&
          row.stage === "shipping"
        ) {
          // The independent full native Shipping verifier above checks this exact receipt.
          exact(saved, { ...row, receipt: saved.receipt, revision: 2 });
        } else exact(saved, row);
      }
      if (table !== "tenant_audit_events")
        exact(
          fresh.map((row) => partialKey(table, row)).sort(),
          (added.get(table) ?? []).map((row) => partialKey(table, row)).sort(),
        );
      for (const row of fresh)
        identical(table === "tenant_audit_events" ? row.organization_id : row.tenant_id, tenantId);
    }
    // These are the only changed existing columns. All checked native rows above
    // are constrained by exact row identities/counts and their full standalone proof.
    if (newTransformation) {
      const lot = additions.get("traceability_lots")?.[0];
      if (!lot) throw new Error("Missing new output lot");
      expect(lot.current_dependency_version).toBe(4);
      expect(lot.receiving_basis_version).toBe(1);
      expect(lot.last_status_reason).toBeNull();
      expect(lot.last_source_reason).toBeNull();
      exact(additions.get("transformation_counters"), [
        { tenant_id: tenantId, year: year(t.finalized.eventNumber), sequence: 1 },
      ]);
    }
    exact(additions.get("shipping_counters"), [
      { tenant_id: tenantId, year: year(firstShipment.finalized.eventNumber), sequence: 2 },
    ]);

    const clock = (
      table: "transformation_operations" | "trace_lot_box_operations" | "shipping_operations",
      command: string,
      key: string,
    ) => {
      const rows = afterRows
        .get(table)
        ?.filter(
          (row) =>
            row.command === command && row.operation_key === key && row.tenant_id === tenantId,
        );
      const value = rows?.[0]?.created_at;
      if (rows?.length !== 1 || typeof value !== "string" || !Number.isFinite(Date.parse(value)))
        throw new Error("Missing checked native transaction clock");
      return value;
    };
    // Public native DTO clocks are millisecond UTC strings. Normalize only raw
    // timestamp presentation for NEW-row DTO equality; existing rows were already
    // compared in full raw JSON, and audit/operation clocks below retain raw micros.
    const timestamps = (row: PartialRow) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          key.endsWith("_at") && typeof value === "string" ? new Date(value).toISOString() : value,
        ]),
      );
    const snake = (value: object) =>
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
          entry,
        ]),
      );
    const newRowsEqual = (table: PartialTable, expected: PartialRow[]) =>
      exact(
        (additions.get(table) ?? []).map((row) => canonicalExportDigest(timestamps(row))).sort(),
        expected.map((row) => canonicalExportDigest(timestamps(row))).sort(),
      );
    const parent = (event_id: string, event_type: "transformation" | "shipping") => ({
      tenant_id: tenantId,
      event_id,
      event_type,
    });
    const root = (
      record:
        | RegularNativeFacts["transformation"]["finalized"]
        | UsDatasetShippingShipmentResult["finalized"],
    ) => ({
      id: record.id,
      tenant_id: tenantId,
      event_number: record.eventNumber,
      lifecycle_version: 2,
      next_revision: 2,
      current_event_id: record.id,
      pending_draft_id: null,
    });
    const event = (
      record:
        | RegularNativeFacts["transformation"]["finalized"]
        | UsDatasetShippingShipmentResult["finalized"],
      type: "transformation" | "shipping",
      locationId: string | null,
      notes: string | null,
    ) => ({
      id: record.id,
      tenant_id: tenantId,
      root_event_id: record.id,
      receiving_root_key: null,
      transformation_root_key: type === "transformation" ? record.id : null,
      shipping_root_key: type === "shipping" ? record.id : null,
      previous_revision_id: null,
      superseded_by_event_id: null,
      amendment_reason: null,
      superseded_at: null,
      superseded_by: null,
      voided_at: null,
      voided_by: null,
      void_reason: null,
      event_number: record.eventNumber,
      type,
      status: "finalized",
      revision: 1,
      draft_version: 1,
      time_zone: record.timeZone,
      event_date: record.snapshot.eventDate,
      location_id: locationId,
      previous_source_location_id: null,
      received_at_note: null,
      notes,
      finalized_at: record.snapshot.finalizedAt,
      finalized_by: actorUserId,
      finalization_snapshot: record.snapshot,
      created_by: actorUserId,
      updated_by: actorUserId,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    });
    const nativeDigest = (command: string, input: unknown, eventId?: string) =>
      createHash("sha256")
        .update(
          JSON.stringify({
            commandVersion: 1,
            command,
            ...(eventId === undefined ? {} : { eventId }),
            input,
          }),
        )
        .digest("hex");
    const documents = [
      ...(newTransformation ? t.documents : []),
      ...s.shipments.flatMap((shipment) => shipment.documents),
    ];
    newRowsEqual(
      "reference_documents",
      documents.map(({ record }) => ({ tenant_id: tenantId, ...snake(record) })),
    );
    newRowsEqual("traceability_events", [
      ...(newTransformation
        ? [
            event(
              t.finalized,
              "transformation",
              t.createInput.draft.processorLocationId,
              t.createInput.draft.notes,
            ),
          ]
        : []),
      ...s.shipments.map((shipment) =>
        event(
          shipment.finalized,
          "shipping",
          shipment.createInput.draft.shipFromLocationId,
          shipment.createInput.draft.notes,
        ),
      ),
    ]);
    if (newTransformation) {
      const { source, ...lot } = t.outputLot;
      if (source?.kind !== "location") throw new Error("Expected actual output location source");
      newRowsEqual("traceability_lots", [
        {
          tenant_id: tenantId,
          ...snake(lot),
          source_location_id: source.locationId,
          source_reference_kind: null,
          source_reference_value: null,
          source_reference_location_id: null,
          receiving_basis_version: 1,
          current_dependency_version: 4,
          last_status_reason: null,
          last_source_reason: null,
        },
      ]);
      newRowsEqual("transformation_event_roots", [root(t.finalized)]);
      newRowsEqual("transformation_event_details", [
        {
          ...parent(tId, "transformation"),
          reason: t.createInput.draft.reason,
          reason_note: t.createInput.draft.reasonNote,
        },
      ]);
      newRowsEqual(
        "transformation_event_inputs",
        t.finalized.snapshot.inputs.map((line) => {
          if (line.kind !== "ftl_lot") throw new Error("Expected two literal FTL inputs");
          return {
            ...parent(tId, "transformation"),
            line_no: line.lineNo,
            kind: "ftl_lot",
            lot_id: line.lotId,
            product_id: null,
            source_location_id: null,
            reference: null,
            quantity: line.quantity,
            unit_of_measure: line.unitOfMeasure,
          };
        }),
      );
      newRowsEqual(
        "transformation_event_outputs",
        t.finalized.snapshot.outputs.map((line) => ({
          ...parent(tId, "transformation"),
          line_no: line.lineNo,
          lot_id: line.lotId,
          product_id: line.product.id,
          tlc: line.tlc,
          quantity: line.quantity,
          unit_of_measure: line.unitOfMeasure,
        })),
      );
      newRowsEqual(
        "transformation_event_documents",
        t.createInput.draft.documentIds.map((document_id, index) => ({
          ...parent(tId, "transformation"),
          document_id,
          position: index + 1,
        })),
      );
      newRowsEqual(
        "lot_genealogy_edges",
        r.lots.map((lot) => ({
          ...parent(tId, "transformation"),
          input_lot_id: lot.id,
          output_lot_id: t.outputLot.id,
        })),
      );
      newRowsEqual("transformation_operations", [
        {
          ...parent(tId, "transformation"),
          command: "transformation.create",
          operation_key: tKey,
          input_digest: nativeDigest(
            "transformation.create",
            createTransformationDraftSchema.parse(t.createInput),
          ),
          result: t.created,
          created_at: clock("transformation_operations", "transformation.create", tKey),
        },
        {
          ...parent(tId, "transformation"),
          command: "transformation.finalize",
          operation_key: tKey,
          input_digest: nativeDigest(
            "transformation.finalize",
            finalizeTransformationSchema.parse(t.finalizeInput),
            tId,
          ),
          result: t.finalized,
          created_at: clock("transformation_operations", "transformation.create", tKey),
        },
      ]);
    }
    const seedIdentity = {
      datasetId: c.input.references.datasetId,
      recipeVersion: "us-processor-six-month-v1",
      recipeDigest: usSixMonthDefinition.digest,
      unitKey: "chain_0000",
      intentDigest: canonicalExportDigest(c.input),
    };
    if (newCases) {
      newRowsEqual("shifts", [
        {
          tenant_id: tenantId,
          ...snake(c.support.shift),
          line_id: null,
          counterparty_id: null,
          label_template_id: null,
          sscc_issuer_counterparty_id: null,
          box_label_template_id: null,
          planned_qty: null,
          box_capacity: null,
          pallet_capacity: null,
          pallets_enabled: false,
          created_from: "admin",
          station_close_policy: "single_device",
          station_close_owner_device_id: null,
          planned_date: null,
          production_date: null,
          first_box_closure_at: null,
          opened_at: null,
          closed_at: null,
          close_reason: null,
          late_data_at: null,
        },
      ]);
      newRowsEqual(
        "boxes",
        c.support.boxes.map((box) => ({
          tenant_id: tenantId,
          ...snake(box),
          terminal_id: null,
          operator_id: null,
          closed_at: null,
          closure_received_at: null,
          print_verified_at: null,
          print_skipped_at: null,
          disassembled_at: null,
          registry_version: 0,
          updated_at: box.openedAt,
        })),
      );
      newRowsEqual(
        "traceability_synthetic_case_origins",
        c.support.markers.map((marker) => ({ tenant_id: tenantId, ...snake(marker) })),
      );
      newRowsEqual(
        "trace_lot_boxes",
        c.linked.created.map((link) => ({
          id: link.linkId,
          tenant_id: tenantId,
          box_id: link.boxId,
          lot_id: link.lotId,
          sscc_at_link: link.ssccAtLink,
          link_source: "demo_seed",
          linked_by: actorUserId,
          linked_at: link.linkedAt,
          unlinked_at: null,
          unlinked_by: null,
          unlink_reason: null,
        })),
      );
      newRowsEqual("trace_lot_box_operations", [
        {
          tenant_id: tenantId,
          command: "case.link",
          operation_key: c.operationKey,
          input_digest: canonicalExportDigest({
            commandVersion: 2,
            command: "case.link",
            source: "demo_seed",
            lotId: c.input.outputLotId,
            input: { ssccs: c.input.support.boxes.map((box) => box.sscc).sort() },
            seed: seedIdentity,
          }),
          target_id: c.input.outputLotId,
          result: c.linked,
          created_at: clock("trace_lot_box_operations", "case.link", c.operationKey),
        },
      ]);
    }
    newRowsEqual(
      "shipping_event_roots",
      s.shipments.map((shipment) => root(shipment.finalized)),
    );
    newRowsEqual(
      "shipping_event_details",
      s.shipments.map((shipment) => {
        const location = shipment.finalized.snapshot.recipient;
        const address =
          location.address.kind === "street"
            ? location.address.streetAddress
            : `${location.address.latitude}, ${location.address.longitude}`;
        return {
          ...parent(shipment.finalized.id, "shipping"),
          recipient_location_id: location.locationId,
          recipient_snapshot: {
            id: location.locationId,
            description: [
              location.businessName,
              address,
              location.city,
              location.stateOrRegion,
              location.zipOrPostalCode,
              location.countryDisplay,
              location.phoneNumber,
            ].join(", "),
            location,
          },
          carrier_reference: shipment.createInput.draft.carrierReference,
        };
      }),
    );
    newRowsEqual(
      "shipping_event_items",
      s.shipments.flatMap((shipment) =>
        shipment.finalized.snapshot.items.map((line) => ({
          ...parent(shipment.finalized.id, "shipping"),
          line_no: line.lineNo,
          lot_id: line.lotId,
          quantity: line.quantity,
          unit_of_measure: line.unitOfMeasure,
          tlc_snapshot: line.tlc,
          source_snapshot: line.source,
          product_snapshot: line.product,
        })),
      ),
    );
    newRowsEqual(
      "shipping_event_documents",
      s.shipments.flatMap((shipment) =>
        shipment.createInput.draft.documentIds.map((document_id, index) => ({
          ...parent(shipment.finalized.id, "shipping"),
          document_id,
          position: index + 1,
        })),
      ),
    );
    newRowsEqual(
      "shipping_operations",
      s.shipments.flatMap((shipment) => [
        {
          ...parent(shipment.finalized.id, "shipping"),
          command: "shipping.create",
          operation_key: shipment.operationKey,
          input_digest: nativeDigest(
            "shipping.create",
            createShippingDraftSchema.parse(shipment.createInput),
          ),
          result: shipment.created,
          created_at: clock("shipping_operations", "shipping.create", shipment.operationKey),
        },
        {
          ...parent(shipment.finalized.id, "shipping"),
          command: "shipping.finalize",
          operation_key: shipment.operationKey,
          input_digest: nativeDigest(
            "shipping.finalize",
            finalizeShippingSchema.parse(shipment.finalizeInput),
            shipment.finalized.id,
          ),
          result: shipment.finalized,
          created_at: clock("shipping_operations", "shipping.create", shipment.operationKey),
        },
      ]),
    );
    const expectedAudits: PartialRow[] = [];
    const audit = (requestId: string, createdAt: string, entries: PartialRow[]) =>
      expectedAudits.push(
        ...entries.map((entry) => ({
          organization_id: tenantId,
          actor_user_id: actorUserId,
          outcome: "success",
          request_id: requestId,
          created_at: createdAt,
          ...entry,
        })),
      );
    const documentAudits = (documents: RegularNativeFacts["transformation"]["documents"]) =>
      documents.map(({ record }) => ({
        action: "traceability.reference_document.created",
        target_type: "traceability_reference_document",
        target_id: record.id,
        before: null,
        after: record,
      }));
    if (newTransformation)
      audit(tKey, clock("transformation_operations", "transformation.create", tKey), [
        ...documentAudits(t.documents),
        {
          action: "traceability.transformation.draft_created",
          target_type: "traceability_event",
          target_id: tId,
          before: null,
          after: t.created,
        },
        {
          action: "traceability.lot.created",
          target_type: "traceability_lot",
          target_id: t.outputLot.id,
          before: null,
          after: { ...t.outputLot, eventId: tId },
        },
        {
          action: "traceability.transformation.finalized",
          target_type: "traceability_event",
          target_id: tId,
          before: t.created,
          after: t.finalized,
        },
      ]);
    if (newCases)
      audit(c.requestId, clock("trace_lot_box_operations", "case.link", c.operationKey), [
        {
          action: "case.link",
          target_type: "traceability_lot",
          target_id: c.input.outputLotId,
          before: { links: [] },
          after: {
            tenantId,
            operationKey: c.operationKey,
            lotId: c.input.outputLotId,
            source: "demo_seed",
            result: c.linked,
            seed: seedIdentity,
          },
        },
      ]);
    for (const shipment of s.shipments)
      audit(
        shipment.requestId,
        clock("shipping_operations", "shipping.create", shipment.operationKey),
        [
          ...documentAudits(shipment.documents),
          {
            action: "traceability.shipping.draft_created",
            target_type: "traceability_event",
            target_id: shipment.created.id,
            before: null,
            after: shipment.created,
          },
          {
            action: "traceability.shipping.finalized",
            target_type: "traceability_event",
            target_id: shipment.created.id,
            before: shipment.created,
            after: { ...shipment.finalized, lotIds: [t.outputLot.id], statusEffects: [] },
          },
        ],
      );
    const actualAudits = additions.get("tenant_audit_events");
    if (!actualAudits) throw new Error("Missing global audit additions");
    const values = actualAudits.map(({ id, ...row }) => {
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))
        throw new Error("Invalid generated audit identity");
      return canonicalExportDigest(row);
    });
    exact(values.sort(), expectedAudits.map(canonicalExportDigest).sort());
  }

  for (const [name, state] of [
    ["B4-1 partial-receiving-I", "N1"],
    ["B4-2 partial-transformation-I", "N2"],
    ["B4-3 partial-cases-I", "N3"],
    ["B4-4 partial-pending-shipping-I", "PShipping"],
  ] as const)
    describe(name, () => {
      let before: Awaited<ReturnType<typeof checkpoint>>;
      let beforeRows: Awaited<ReturnType<typeof partialRows>>;
      beforeEach(
        h.phase(async () => {
          await prepare(state);
          before = await checkpoint();
          beforeRows = await partialRows();
        }),
        60_000,
      );
      it(
        name,
        h.phase(async () => {
          const actual = await owner().initialize(h.context, regular);
          // All newly created facts are checked AFTER the owner, within this original 5000-ms body.
          const checked = await oracle(regular);
          const expected = checked.output;
          if (!checked.regularFacts) throw new Error("Missing independent regular facts");
          ownedOutput(actual, expected);
          await progressMatches(expected, regular);
          await partialDelta(state, before, beforeRows, checked.regularFacts);
          // A global owned-child census also excludes disconnected suffix/special native work.
          const nativeRows = await h.f.pool.query<{ kind: "event" | "lot"; id: string }>(
            "SELECT 'event' AS kind,id FROM traceability_events UNION ALL SELECT 'lot' AS kind,id FROM traceability_lots ORDER BY kind,id",
          );
          exact(
            nativeRows.rows,
            [
              ...expected.trace.currentEventIds.map((id) => ({ kind: "event", id })),
              ...expected.trace.lotIds.map((id) => ({ kind: "lot", id })),
            ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
          );
          const after = await rawJournal();
          expect(after.map(({ row }) => `${row.unit_key}:${row.stage}`).sort()).toEqual(
            [
              "references:references",
              "chain_0000:receiving",
              "chain_0000:transformation",
              "chain_0000:cases",
              "chain_0000:shipping",
              "chain_0000:trace_readiness",
            ].sort(),
          );
          expect(after.every(({ row }) => row.revision === 2 && row.receipt !== null)).toBe(true);
          for (const old of before.journal) {
            const now = after.find(
              ({ row }) => row.unit_key === old.row.unit_key && row.stage === old.row.stage,
            );
            if (!now) throw new Error("Owner lost an existing stage");
            if (old.row.revision === 2) exact(now, old);
            else
              exact(
                [now.row.operation_key, now.row.input, now.row.input_digest],
                [old.row.operation_key, old.row.input, old.row.input_digest],
              );
          }
        }),
      );
    });

  for (const [name, pending] of [
    ["C3-1 progress-missing-V", false],
    ["C3-2 progress-pending-V", true],
  ] as const)
    describe(name, () => {
      let before: Awaited<ReturnType<typeof checkpoint>>;
      beforeEach(
        h.phase(async (test: TestContext) => {
          await prepare("N4");
          if (pending) await withOwnedWork((own) => pendingProgress(own, test));
          before = await checkpoint();
        }),
        60_000,
      );
      it(
        name,
        h.phase(async () => {
          const read = vi.spyOn(UsTraceStore.prototype, "read");
          try {
            const result = await outcome(owner().verify(h.context, regular));
            expect(result.value).toBeUndefined();
            const error = errorValue(result.error, "us_dataset_trace_readiness_stage_incomplete");
            annotations(error, "chain_0000", "trace_readiness");
            absent(error, "cause");
            expect(read).toHaveBeenCalledTimes(3);
            await noWrites(before);
          } finally {
            read.mockRestore();
          }
        }),
      );
    });

  const conflicts = [
    ["C5-1I progress-input-selector-consistent-I", "selector", true, "initialize"],
    ["C5-1V progress-input-selector-consistent-V", "selector", true, "verify"],
    ["C5-2I progress-input-predecessor-consistent-I", "predecessor", true, "initialize"],
    ["C5-2V progress-input-predecessor-consistent-V", "predecessor", true, "verify"],
    ["C5-3I progress-receipt-result-consistent-I", "result", true, "initialize"],
    ["C5-3V progress-receipt-result-consistent-V", "result", true, "verify"],
    ["C5-4I progress-receipt-ids-consistent-I", "ids", true, "initialize"],
    ["C5-4V progress-receipt-ids-consistent-V", "ids", true, "verify"],
    ["C5-5I progress-input-selector-stale-digest-I", "selector", false, "initialize"],
    ["C5-5V progress-input-selector-stale-digest-V", "selector", false, "verify"],
    ["C5-6I progress-receipt-result-stale-digest-I", "result", false, "initialize"],
    ["C5-6V progress-receipt-result-stale-digest-V", "result", false, "verify"],
  ] as const;
  for (const [name, mutation, consistent, mode] of conflicts)
    describe(name, () => {
      let before: Awaited<ReturnType<typeof checkpoint>>;
      beforeEach(
        h.phase(async () => {
          await prepare("N4");
          await progress().initialize(h.context, regular);
          const saved = await stage("trace_readiness");
          if (!saved?.receipt) throw new Error("Missing actual saved progress");
          const input = structuredClone(saved.intent.input);
          const receipt = {
            ...structuredClone(saved.receipt),
            recordIds: [...saved.receipt.recordIds],
            result: { ...saved.receipt.result },
          };
          // These intentional JSON mutations preserve legal persisted revision2/receipt constraints.
          if (mutation === "selector") {
            if (
              !input ||
              typeof input !== "object" ||
              !("unit" in input) ||
              !input.unit ||
              typeof input.unit !== "object" ||
              !("index" in input.unit)
            )
              throw new Error("Missing actual progress selector");
            input.unit.index = 1;
          } else if (mutation === "predecessor") {
            if (
              !input ||
              typeof input !== "object" ||
              !("predecessor" in input) ||
              !input.predecessor ||
              typeof input.predecessor !== "object" ||
              !("operationKey" in input.predecessor)
            )
              throw new Error("Missing actual predecessor");
            input.predecessor.operationKey = randomUUID();
          } else if (mutation === "result") {
            if (
              !receipt.result ||
              typeof receipt.result !== "object" ||
              !("datasetComplete" in receipt.result)
            )
              throw new Error("Missing actual progress result");
            receipt.result.datasetComplete = true;
            if (consistent) receipt.resultDigest = canonicalExportDigest(receipt.result);
          } else receipt.recordIds.push(randomUUID());
          const inputDigest = consistent ? canonicalExportDigest(input) : saved.intent.inputDigest;
          expect(
            (
              await h.f.pool.query(
                "UPDATE traceability_demo_dataset_stages SET input=$1::jsonb,input_digest=$2,receipt=$3::jsonb WHERE tenant_id=$4 AND dataset_id=$5 AND unit_key='chain_0000' AND stage='trace_readiness' AND revision=2 AND receipt IS NOT NULL",
                [
                  JSON.stringify(input),
                  inputDigest,
                  JSON.stringify(receipt),
                  h.context.tenantId,
                  (await header()).id,
                ],
              )
            ).rowCount,
          ).toBe(1);
          before = await checkpoint();
        }),
        60_000,
      );
      it(
        name,
        h.phase(async () => {
          let rejection: unknown;
          const original = UsDatasetJournalStore.prototype.readStage;
          const spy = vi
            .spyOn(UsDatasetJournalStore.prototype, "readStage")
            .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
              try {
                return await original.apply(this, args);
              } catch (error) {
                if (args[3] === "trace_readiness") rejection = error;
                throw error;
              }
            });
          try {
            const result = await outcome(owner()[mode](h.context, regular));
            expect(result.value).toBeUndefined();
            const error = errorValue(
              result.error,
              consistent
                ? "us_dataset_trace_readiness_stage_conflict"
                : "us_dataset_journal_invalid",
            );
            if (consistent) annotations(error, "chain_0000", "trace_readiness");
            else {
              identical(error, rejection);
              absent(error, "unitKey", "stage");
            }
            absent(error, "cause");
            await noWrites(before);
          } finally {
            spy.mockRestore();
          }
        }),
      );
    });
  const injectionCases = [
    ["E01 map-reference", "R", "references", "regular", "us_dataset_reference_mismatch", true],
    ["E02 map-receiving", "R", "receiving", "regular", "us_dataset_receiving_mismatch", true],
    [
      "E03 map-transformation",
      "N1",
      "transformation",
      "regular",
      "us_dataset_transformation_mismatch",
      true,
    ],
    ["E04 map-cases", "N2", "cases", "regular", "us_dataset_cases_mismatch", true],
    ["E05 map-shipping", "N4", "shipping", "regular", "us_dataset_shipping_mismatch", true],
    [
      "E06 map-special-preserve-data",
      "R",
      "special",
      "correction",
      "us_dataset_special_mismatch",
      true,
    ],
    [
      "E07 map-corrected-transformation",
      "CP",
      "corrected-transformation",
      "correction",
      "us_dataset_corrected_transformation_mismatch",
      true,
    ],
    [
      "E08 exclude-corrected-cases",
      "CT",
      "corrected-cases",
      "correction",
      "us_dataset_corrected_cases_mismatch",
      false,
    ],
    [
      "E09 exclude-corrected-shipping",
      "CC",
      "corrected-shipping",
      "correction",
      "us_dataset_corrected_shipping_mismatch",
      false,
    ],
    [
      "E10 regular-overwrite-own-accessors",
      "R",
      "receiving",
      "regular",
      "us_dataset_receiving_mismatch",
      true,
    ],
    [
      "E11 regular-shadow-inherited-accessors",
      "R",
      "receiving",
      "regular",
      "us_dataset_receiving_mismatch",
      true,
    ],
    [
      "E12 regular-nonconfigurable-accessor",
      "R",
      "receiving",
      "regular",
      "us_dataset_receiving_mismatch",
      false,
    ],
    [
      "E13 special-preserve-own-accessor",
      "R",
      "special",
      "correction",
      "us_dataset_special_mismatch",
      false,
    ],
    [
      "E14 special-preserve-inherited-accessor",
      "R",
      "special",
      "correction",
      "us_dataset_special_mismatch",
      false,
    ],
    ["E15 special-annotates-nonerror", "R", "special", "correction", "", false],
    [
      "E16 frozen-error-identity",
      "R",
      "receiving",
      "regular",
      "us_dataset_receiving_mismatch",
      false,
    ],
    [
      "E17 cause-code-accessor-identity",
      "R",
      "receiving",
      "regular",
      "us_dataset_receiving_mismatch",
      false,
    ],
    [
      "E18 own-cause-accessor-identity",
      "R",
      "receiving",
      "regular",
      "us_dataset_receiving_mismatch",
      false,
    ],
    [
      "E19 inherited-cause-accessor-identity",
      "R",
      "receiving",
      "regular",
      "us_dataset_receiving_mismatch",
      false,
    ],
    [
      "E20 primitive-cause-identity",
      "R",
      "receiving",
      "regular",
      "us_dataset_receiving_mismatch",
      false,
    ],
    [
      "E21 cyclic-cause-identity",
      "R",
      "receiving",
      "regular",
      "us_dataset_receiving_mismatch",
      false,
    ],
    [
      "E22 depth32-cause-identity",
      "R",
      "receiving",
      "regular",
      "us_dataset_receiving_mismatch",
      false,
    ],
    [
      "E23 postnative-trace-bypasses-mapper",
      "N4",
      "trace",
      "regular",
      "us_dataset_shipping_mismatch",
      false,
    ],
    ["E24 primitive-thrown-identity", "R", "receiving", "regular", "", false],
  ] as const;
  for (const [name, state, boundary, kind, message, translated] of injectionCases)
    describe(name, () => {
      let before: Awaited<ReturnType<typeof checkpoint>>;
      beforeEach(
        h.phase(async () => {
          await prepare(state);
          before = await checkpoint();
        }),
        60_000,
      );
      it(
        name,
        h.phase(async () => {
          const id = name.slice(0, 3);
          let getterCount = 0;
          const getter = () => {
            getterCount++;
            return "kept_unit";
          };
          const stageGetter = () => {
            getterCount++;
            return "kept_stage";
          };
          const sentinel = { marker: "cause-sentinel" };
          const e: object | number =
            id === "E24" ? 17 : id === "E15" ? { marker: "sentinel" } : new Error(message);
          const causes: object[] = [];
          if (typeof e === "object") {
            if (id === "E06" || id === "E23")
              Object.defineProperties(e, {
                unitKey: data("kept_unit", false, false),
                stage: data("kept_stage", false, false),
              });
            if (id === "E10")
              Object.defineProperties(e, {
                unitKey: { get: getter, enumerable: true, configurable: true },
                stage: { get: stageGetter, enumerable: true, configurable: true },
              });
            if (id === "E11" || id === "E14" || id === "E19") {
              const proto: object = Object.create(Error.prototype);
              if (id === "E19")
                Object.defineProperty(proto, "cause", {
                  get: () => {
                    getterCount++;
                    return sentinel;
                  },
                  enumerable: false,
                  configurable: true,
                });
              else
                Object.defineProperty(proto, "unitKey", {
                  get: getter,
                  enumerable: true,
                  configurable: true,
                });
              if (id === "E11")
                Object.defineProperty(proto, "stage", {
                  get: stageGetter,
                  enumerable: true,
                  configurable: true,
                });
              Object.setPrototypeOf(e, proto);
            }
            if (id === "E12" || id === "E13")
              Object.defineProperty(e, "unitKey", {
                get: getter,
                enumerable: true,
                configurable: id === "E13",
              });
            if (id === "E16") Object.freeze(e);
            if (id === "E17") {
              const c = {};
              Object.defineProperty(c, "code", {
                get: () => {
                  getterCount++;
                  return "40001";
                },
                enumerable: true,
                configurable: true,
              });
              Object.defineProperty(e, "cause", data(c, false));
              causes.push(c);
            }
            if (id === "E18")
              Object.defineProperty(e, "cause", {
                get: () => {
                  getterCount++;
                  return sentinel;
                },
                enumerable: false,
                configurable: true,
              });
            if (id === "E20") Object.defineProperty(e, "cause", data(17, false));
            if (id === "E21") Object.defineProperty(e, "cause", data(e, false));
            if (id === "E22") {
              for (let i = 0; i < 32; i++) causes.push({});
              for (let i = 0; i < 31; i++) {
                const item = causes[i],
                  next = causes[i + 1];
                if (!item || !next) throw new Error("Missing fixed cause link");
                Object.defineProperty(item, "cause", data(next));
              }
              Object.defineProperty(e, "cause", data(causes[0], false));
            }
            if (id === "E23") Object.defineProperty(e, "cause", data(sentinel, false));
          }
          const initial = typeof e === "object" ? Object.getOwnPropertyDescriptors(e) : {};
          const prototype: object | undefined =
            typeof e === "object" ? Object.getPrototypeOf(e) : undefined;
          const inherited = prototype ? Object.getOwnPropertyDescriptors(prototype) : {};
          const causeDescriptors = causes.map((cause) => Object.getOwnPropertyDescriptors(cause));
          const throwValue = async (): Promise<never> => {
            throw e;
          };
          const seen = observe("verify");
          const spy =
            boundary === "references"
              ? vi
                  .spyOn(UsDatasetReferenceSeedStore.prototype, "verify")
                  .mockImplementationOnce(throwValue)
              : boundary === "receiving"
                ? vi
                    .spyOn(UsDatasetReceivingSeedStore.prototype, "verify")
                    .mockImplementationOnce(throwValue)
                : boundary === "transformation"
                  ? vi
                      .spyOn(UsDatasetTransformationSeedStore.prototype, "verify")
                      .mockImplementationOnce(throwValue)
                  : boundary === "cases"
                    ? vi
                        .spyOn(UsDatasetCasesSeedStore.prototype, "verify")
                        .mockImplementationOnce(throwValue)
                    : boundary === "shipping"
                      ? vi
                          .spyOn(UsDatasetShippingSeedStore.prototype, "verifyTerminalProjection")
                          .mockImplementationOnce(throwValue)
                      : boundary === "special"
                        ? vi
                            .spyOn(UsDatasetSpecialSeedStore.prototype, "verify")
                            .mockImplementationOnce(throwValue)
                        : boundary === "corrected-transformation"
                          ? vi
                              .spyOn(UsDatasetCorrectedTransformationSeedStore.prototype, "verify")
                              .mockImplementationOnce(throwValue)
                          : boundary === "corrected-cases"
                            ? vi
                                .spyOn(UsDatasetCorrectedCasesSeedStore.prototype, "verify")
                                .mockImplementationOnce(throwValue)
                            : boundary === "corrected-shipping"
                              ? vi
                                  .spyOn(UsDatasetCorrectedShippingSeedStore.prototype, "verify")
                                  .mockImplementationOnce(throwValue)
                              : vi
                                  .spyOn(UsTraceStore.prototype, "read")
                                  .mockImplementationOnce(throwValue);
          try {
            const unit = kind === "regular" ? regular : { kind: "correction" as const };
            const result = await outcome(owner().verify(h.context, unit));
            expect(result.value).toBeUndefined();
            expect(spy).toHaveBeenCalledTimes(1);
            if (translated) {
              const error = errorValue(result.error, "us_dataset_native_drift");
              expect(error === e).toBe(false);
              causeValue(error, e);
              expect(Object.getOwnPropertyDescriptor(error, "message")).toEqual(
                data("us_dataset_native_drift", false),
              );
              for (const key of ["unitKey", "stage"])
                expect(Object.getOwnPropertyDescriptor(error, key)).toEqual(
                  Object.getOwnPropertyDescriptor(e, key),
                );
            } else identical(result.error, e);
            if (typeof e === "object") {
              identical(Object.getPrototypeOf(e), prototype);
              if (prototype) expect(Object.getOwnPropertyDescriptors(prototype)).toEqual(inherited);
              expect(Object.getOwnPropertyDescriptor(e, "message")).toEqual(initial.message);
              expect(Object.getOwnPropertyDescriptor(e, "cause")).toEqual(initial.cause);
              const savedCause = initial.cause;
              if (savedCause && "value" in savedCause)
                identical(Object.getOwnPropertyDescriptor(e, "cause")?.value, savedCause.value);
              if (id === "E17")
                identical(Object.getOwnPropertyDescriptor(e, "cause")?.value, causes[0]);
              if (id === "E21") identical(Object.getOwnPropertyDescriptor(e, "cause")?.value, e);
              if (id === "E22") {
                identical(Object.getOwnPropertyDescriptor(e, "cause")?.value, causes[0]);
                for (let link = 0; link < 31; link++) {
                  const current = causes[link];
                  if (!current) throw new Error("Missing original cause-chain link");
                  identical(
                    Object.getOwnPropertyDescriptor(current, "cause")?.value,
                    causes[link + 1],
                  );
                }
              }
              if (id === "E23")
                identical(Object.getOwnPropertyDescriptor(e, "cause")?.value, sentinel);
              for (const [i, cause] of causes.entries())
                expect(Object.getOwnPropertyDescriptors(cause)).toEqual(causeDescriptors[i]);
              if (id === "E06" || id === "E23") {
                expect(Object.getOwnPropertyDescriptor(e, "unitKey")).toEqual(
                  data("kept_unit", false, false),
                );
                expect(Object.getOwnPropertyDescriptor(e, "stage")).toEqual(
                  data("kept_stage", false, false),
                );
              } else if (id === "E12") {
                expect(Object.getOwnPropertyDescriptor(e, "unitKey")).toEqual(initial.unitKey);
                absent(e, "stage", "cause");
              } else if (id === "E13" || id === "E14") {
                expect(Object.getOwnPropertyDescriptor(e, "unitKey")).toEqual(initial.unitKey);
                expect(Object.getOwnPropertyDescriptor(e, "stage")).toEqual(
                  data("amend_receiving"),
                );
                absent(e, "cause");
              } else if (id === "E16") {
                expect(Object.isFrozen(e)).toBe(true);
                absent(e, "unitKey", "stage", "cause");
              } else {
                const unitKey =
                  boundary === "references"
                    ? "references"
                    : kind === "correction"
                      ? "correction_0001"
                      : "chain_0000";
                const stageName =
                  boundary === "special" ? "amend_receiving" : boundary.replace("corrected-", "");
                annotations(e, unitKey, stageName);
              }
              if (id === "E15") {
                expect(Object.getOwnPropertyDescriptor(e, "marker")).toEqual(data("sentinel"));
                absent(e, "message", "cause");
              }
              if (id === "E22") {
                expect(causes.length).toBe(32);
                const last = causes[31];
                if (!last) throw new Error("Missing depth32 tail");
                absent(last, "cause");
              }
            }
            if (id === "E23") expect(seen.calls).toEqual(["references", "shipping"]);
            expect(getterCount).toBe(0);
            await noWrites(before);
          } finally {
            spy.mockRestore();
            seen.restore();
          }
        }),
      );
    });
  function observeDriverFailure(
    own: OwnCleanup,
    missingColumn: boolean,
    inShipping: () => boolean,
  ) {
    let driver: unknown,
      injected = 0;
    const terminalClients = new Set<OwnedClient>(),
      restores = new Map<OwnedClient, () => void>();
    const acquire = (client: OwnedClient) => {
      if (restores.has(client)) return;
      const original = client.query;
      client.query = new Proxy(original, {
        apply(target, receiver, args: unknown[]) {
          const first = args[0];
          const text =
            typeof first === "string"
              ? first
              : first &&
                  typeof first === "object" &&
                  "text" in first &&
                  typeof first.text === "string"
                ? first.text
                : "";
          if (
            inShipping() &&
            /traceability_demo_dataset_stages/i.test(text) &&
            /for update/i.test(text)
          )
            terminalClients.add(client);
          if (
            missingColumn &&
            inShipping() &&
            terminalClients.has(client) &&
            injected === 0 &&
            /from "receiving_operations"/i.test(text)
          ) {
            injected++;
            return client
              .query("SELECT owned_projection_missing_column FROM receiving_operations")
              .catch((error: unknown) => {
                driver = error;
                throw error;
              });
          }
          const returned: unknown = Reflect.apply(target, receiver, args);
          if (returned instanceof Promise)
            return returned.catch((error: unknown) => {
              driver = error;
              throw error;
            });
          return returned;
        },
      });
      restores.set(client, () => {
        client.query = original;
      });
    };
    own("restore driver failure observation", async () => {
      h.f.pool.off("acquire", acquire);
      for (const restore of restores.values()) restore();
    });
    h.f.pool.on("acquire", acquire);
    return {
      get driver() {
        return driver;
      },
      get injected() {
        return injected;
      },
    };
  }
  async function receiptFault(
    own: OwnCleanup,
    test: TestContext,
    target: "shipping" | "trace_readiness",
    deferred: boolean,
  ) {
    const current = await header();
    // Both UUIDs come from the already guarded owned fixture, never external input.
    for (const id of [h.context.tenantId, current.id])
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const condition = `NEW.tenant_id='${h.context.tenantId}' AND NEW.dataset_id='${current.id}' AND NEW.unit_key='chain_0000' AND NEW.stage='${target}' AND OLD.receipt IS NULL AND NEW.receipt IS NOT NULL AND NEW.revision=2`;
    const name = "owner_receipt_" + randomUUID().replaceAll("-", "");
    let functionCreated = false,
      triggerCreated = false;
    const removeFunction = async () => {
      if (functionCreated) {
        await h.f.pool.query(`DROP FUNCTION ${name}()`);
        functionCreated = false;
      }
    };
    const removeTrigger = async () => {
      if (triggerCreated) {
        await h.f.pool.query(`DROP TRIGGER ${name} ON traceability_demo_dataset_stages`);
        triggerCreated = false;
      }
    };
    // Ownership exists before either CREATE. An install failure propagates unchanged;
    // withOwnedWork records each cleanup failure separately and retains these retry flags.
    own("remove owned receipt function", removeFunction);
    own("remove owned receipt trigger", removeTrigger);
    const remove = () =>
      withOwnedWork(async (retry) => {
        retry("retry owned receipt function", removeFunction);
        retry("retry owned receipt trigger", removeTrigger);
      });
    test.onTestFinished(remove);
    const message = deferred ? "closed_terminal_commit_failure" : "special_sql_fault";
    const code = deferred ? "P0001" : "40001";
    await h.f.pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION '${message}' USING ERRCODE='${code}'; END IF; RETURN NEW; END $$`,
    );
    functionCreated = true;
    await h.f.pool.query(
      deferred
        ? `CREATE CONSTRAINT TRIGGER ${name} AFTER UPDATE ON traceability_demo_dataset_stages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`
        : `CREATE TRIGGER ${name} BEFORE UPDATE ON traceability_demo_dataset_stages FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    triggerCreated = true;
    return remove;
  }
  const failureCases = [
    ["D1-1 shipping-real-driver-query-failure-V", "N4", "query", "verify"],
    ["D2-1 shipping-real-receipt-failure-I", "PShipping", "native-receipt", "initialize"],
    ["D2-2 shipping-real-deferred-commit-failure-I", "PShipping", "commit", "initialize"],
    ["D3-1 progress-real-receipt-failure-I", "N4", "progress", "initialize"],
  ] as const;
  for (const [name, state, fault, mode] of failureCases)
    describe(name, () => {
      let before: Awaited<ReturnType<typeof checkpoint>>;
      beforeEach(
        h.phase(async () => {
          await prepare(state);
          before = await checkpoint();
        }),
        60_000,
      );
      it(
        name,
        h.phase(async (test: TestContext) => {
          await withOwnedWork(async (own) => {
            let inShipping = false,
              nativeError: unknown,
              journalError: unknown,
              pending: UsDatasetStageRow | undefined;
            if (fault !== "query")
              await receiptFault(
                own,
                test,
                fault === "progress" ? "trace_readiness" : "shipping",
                fault === "commit",
              );
            const shippingMethod =
              mode === "verify" ? "verifyTerminalProjection" : "initializeTerminalProjection";
            const nativeOriginal = UsDatasetShippingSeedStore.prototype[shippingMethod];
            const nativeSpy = vi
              .spyOn(UsDatasetShippingSeedStore.prototype, shippingMethod)
              .mockImplementation(async function (this: UsDatasetShippingSeedStore, ...args) {
                inShipping = true;
                try {
                  return await nativeOriginal.apply(this, args);
                } catch (error) {
                  nativeError = error;
                  throw error;
                } finally {
                  inShipping = false;
                }
              });
            own("restore native boundary", async () => {
              nativeSpy.mockRestore();
            });
            const atomicOriginal = UsDatasetJournalStore.prototype.runAtomicStage;
            const atomic = vi
              .spyOn(UsDatasetJournalStore.prototype, "runAtomicStage")
              .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
                try {
                  return await atomicOriginal.apply(this, args);
                } catch (error) {
                  if (args[3].stage === "shipping") journalError = error;
                  throw error;
                }
              });
            own("restore atomic boundary", async () => {
              atomic.mockRestore();
            });
            const receiptOriginal = UsDatasetJournalStore.prototype.recordReceipt;
            const receipt = vi
              .spyOn(UsDatasetJournalStore.prototype, "recordReceipt")
              .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
                try {
                  return await receiptOriginal.apply(this, args);
                } catch (error) {
                  if (args[4] === "trace_readiness") journalError = error;
                  throw error;
                }
              });
            own("restore receipt boundary", async () => {
              receipt.mockRestore();
            });
            const captureOriginal = UsDatasetJournalStore.prototype.captureIntent;
            const captured = vi
              .spyOn(UsDatasetJournalStore.prototype, "captureIntent")
              .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
                const value = await captureOriginal.apply(this, args);
                if (args[2].stage === "trace_readiness") pending = value;
                return value;
              });
            own("restore capture boundary", async () => {
              captured.mockRestore();
            });
            const trace = vi.spyOn(UsTraceStore.prototype, "read");
            own("restore Trace observation", async () => {
              trace.mockRestore();
            });
            const driver = observeDriverFailure(own, fault === "query", () => inShipping);
            const work: { pending?: ReturnType<typeof outcome<NativeTraceOutput>> } = {};
            const drain = async () => {
              await work.pending;
            };
            test.onTestFinished(drain);
            own("drain owner failure", drain);
            work.pending = outcome(owner()[mode](h.context, regular));
            const result = await work.pending;
            expect(result.value).toBeUndefined();
            identical(result.error, journalError);
            if (
              !(journalError instanceof Error) ||
              !driver.driver ||
              typeof driver.driver !== "object"
            )
              throw new Error("Expected actual journal and driver failures");
            causeValue(journalError, driver.driver, true);
            expect(Object.getOwnPropertyDescriptor(driver.driver, "code")?.value).toBe(
              fault === "query" ? "42703" : fault === "commit" ? "P0001" : "40001",
            );
            if (fault !== "query")
              expect(Object.getOwnPropertyDescriptor(driver.driver, "message")?.value).toBe(
                fault === "commit" ? "closed_terminal_commit_failure" : "special_sql_fault",
              );
            expect(journalError.message).not.toBe("us_dataset_native_drift");
            if (fault === "query") expect(driver.injected).toBe(1);
            if (fault === "progress") {
              absent(journalError, "unitKey", "stage");
              expect(nativeError).toBeUndefined();
              expect(trace).toHaveBeenCalledTimes(3);
              if (!pending) throw new Error("Missing observed real progress capture");
              expect(pending.revision).toBe(1);
              expect(pending.receipt).toBeNull();
              exact(await stage("trace_readiness"), pending);
              await onlyProgressChanged(before);
            } else {
              identical(journalError, nativeError);
              annotations(journalError, "chain_0000", "shipping");
              expect(trace).not.toHaveBeenCalled();
              expect(await stage("trace_readiness")).toBeNull();
              await noWrites(before);
            }
          });
        }),
      );
    });

  for (const [name, mutation] of [
    ["D4-1 postcommit-shipping-writer-I", "shipping"],
    ["D5-1 postcommit-membership-revocation-I", "membership"],
    ["D5-2 postcommit-required-profile-removal-I", "profile"],
  ] as const)
    describe(name, () => {
      let shipmentId: string;
      beforeEach(
        h.phase(async () => {
          await prepare("N4");
          const shipping = await new UsDatasetShippingSeedStore(h.f.db).verify(h.context, 0);
          const first = shipping.shipments[0];
          if (!first) throw new Error("Missing actual shipment");
          shipmentId = first.finalized.id;
        }),
        60_000,
      );
      it(
        name,
        h.phase(async (test: TestContext) => {
          await withOwnedWork(async (own) => {
            if (!base) throw new Error("Missing isolated fixture URL");
            const url = new URL(base);
            url.pathname = "/" + h.f.databaseName;
            const writer = createDb(url.toString(), { max: 1 });
            own("close owned postcommit writer", () => writer.pool.end());
            const committed = barrier(),
              allowTrace = barrier();
            let returned = false,
              traceError: unknown,
              traceCalls = 0;
            const original = UsDatasetShippingSeedStore.prototype.verifyTerminalProjection;
            const terminal = vi
              .spyOn(UsDatasetShippingSeedStore.prototype, "verifyTerminalProjection")
              .mockImplementation(async function (this: UsDatasetShippingSeedStore, ...args) {
                const projection = await original.apply(this, args);
                // Public return is after its awaited transaction COMMIT, not its verify callback.
                returned = true;
                committed.release();
                await allowTrace.promise;
                return projection;
              });
            own("restore postcommit boundary", async () => {
              terminal.mockRestore();
            });
            const realTrace = UsTraceStore.prototype.read;
            const trace = vi
              .spyOn(UsTraceStore.prototype, "read")
              .mockImplementation(async function (this: UsTraceStore, ...args) {
                expect(returned).toBe(true);
                traceCalls++;
                try {
                  return await realTrace.apply(this, args);
                } catch (error) {
                  traceError = error;
                  throw error;
                }
              });
            own("restore real Trace boundary", async () => {
              trace.mockRestore();
            });
            const work: { pending?: ReturnType<typeof outcome<NativeTraceOutput>> } = {};
            const drain = async () => {
              allowTrace.release();
              await work.pending;
            };
            test.onTestFinished(drain);
            own("release postcommit gate and drain", drain);
            work.pending = outcome(owner().initialize(h.context, regular));
            await abortable(
              Promise.race([
                committed.promise,
                work.pending.then(({ error }) => {
                  throw error ?? new Error("Owner ended before committed barrier");
                }),
              ]),
              test.signal,
            );
            expect(returned).toBe(true);
            expect(traceCalls).toBe(0);
            if (mutation === "shipping")
              await new UsShippingStore(writer.db).void(
                h.context.tenantId,
                h.context.actorUserId,
                shipmentId,
                {
                  operationKey: randomUUID(),
                  expectedLifecycleVersion: 2,
                  reason: "Synthetic postcommit owner writer",
                },
                "synthetic-owner-postcommit",
              );
            else if (mutation === "membership")
              expect(
                (
                  await writer.pool.query(
                    "UPDATE member SET role='viewer' WHERE organization_id=$1 AND user_id=$2",
                    [h.context.tenantId, h.context.actorUserId],
                  )
                ).rowCount,
              ).toBe(1);
            else
              expect(
                (
                  await writer.pool.query("DELETE FROM traceability_profiles WHERE tenant_id=$1", [
                    h.context.tenantId,
                  ])
                ).rowCount,
              ).toBe(1);
            const before = await checkpoint();
            allowTrace.release();
            const result = await work.pending;
            expect(result.value).toBeUndefined();
            expect(traceCalls).toBeGreaterThan(0);
            if (mutation === "shipping") {
              const error = errorValue(result.error, "us_dataset_trace_readiness_mismatch");
              annotations(error, "chain_0000", "trace");
              // Round3 source ruling: fail('trace') explicitly constructs Error({ cause: undefined }).
              causeValue(error, undefined);
            } else {
              identical(result.error, traceError);
              if (
                !(traceError instanceof Error) ||
                !("getResponse" in traceError) ||
                typeof traceError.getResponse !== "function"
              )
                throw new Error("Expected real Trace ForbiddenException");
              const response: unknown = traceError.getResponse();
              expect(response).toEqual({
                code:
                  mutation === "membership"
                    ? "insufficient_permission"
                    : "traceability_profile_required",
              });
              absent(traceError, "unitKey", "stage", "cause");
            }
            await noWrites(before);
            expect(
              (await rawJournal()).filter(({ row }) => row.stage === "trace_readiness"),
            ).toEqual([]);
          });
        }),
      );
    });
  describe("C6 real capture schedule", () => {
    let expected: NativeTraceOutput, before: Awaited<ReturnType<typeof checkpoint>>;
    beforeEach(
      h.phase(async () => {
        await prepare("N4");
        expected = (await oracle(regular)).output;
        before = await checkpoint();
      }),
      60_000,
    );
    it(
      "C6-1 concurrent-real-progress-capture-I",
      h.phase(async (test: TestContext) => {
        await withOwnedWork(async (own) => {
          if (!base) throw new Error("Missing isolated fixture URL");
          const url = new URL(base);
          url.pathname = "/" + h.f.databaseName;
          const other = createDb(url.toString(), { max: 1 });
          own("close second owner pool", () => other.pool.end());
          const candidates: {
            journal: UsDatasetJournalStore;
            key: string;
            captured?: UsDatasetStageRow;
            conflict?: unknown;
            winnerRead?: UsDatasetStageRow;
            receiptKey?: string;
            completed?: UsDatasetStageRow;
          }[] = [];
          const both = barrier(),
            firstGo = barrier(),
            secondGo = barrier(),
            firstSaved = barrier(),
            secondRead = barrier(),
            receiptsGo = barrier();
          const capture = UsDatasetJournalStore.prototype.captureIntent;
          const captureSpy = vi
            .spyOn(UsDatasetJournalStore.prototype, "captureIntent")
            .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
              if (args[2].stage !== "trace_readiness") return capture.apply(this, args);
              const participant: (typeof candidates)[number] = {
                journal: this,
                key: args[2].operationKey,
              };
              candidates.push(participant);
              const ordinal = candidates.length;
              if (ordinal > 2) throw new Error("Unexpected third capture candidate");
              if (ordinal === 2) both.release();
              await (ordinal === 1 ? firstGo.promise : secondGo.promise);
              try {
                const saved = await capture.apply(this, args);
                participant.captured = saved;
                if (ordinal === 1) firstSaved.release();
                return saved;
              } catch (error) {
                participant.conflict = error;
                throw error;
              }
            });
          own("restore concurrent capture", async () => {
            captureSpy.mockRestore();
          });
          const read = UsDatasetJournalStore.prototype.readStage;
          const readSpy = vi
            .spyOn(UsDatasetJournalStore.prototype, "readStage")
            .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
              const value = await read.apply(this, args);
              const participant = candidates.find((candidate) => candidate.journal === this);
              if (args[3] === "trace_readiness" && participant?.conflict && value) {
                participant.winnerRead = value;
                secondRead.release();
              }
              return value;
            });
          own("restore concurrent read", async () => {
            readSpy.mockRestore();
          });
          const receipt = UsDatasetJournalStore.prototype.recordReceipt;
          const receiptSpy = vi
            .spyOn(UsDatasetJournalStore.prototype, "recordReceipt")
            .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
              if (args[4] !== "trace_readiness") return receipt.apply(this, args);
              const participant = candidates.find((candidate) => candidate.journal === this);
              if (!participant) throw new Error("Receipt without real capture participant");
              participant.receiptKey = args[5];
              await secondRead.promise;
              await receiptsGo.promise;
              const completed = await receipt.apply(this, args);
              participant.completed = completed;
              return completed;
            });
          own("restore concurrent receipts", async () => {
            receiptSpy.mockRestore();
          });
          const work: ReturnType<typeof outcome<NativeTraceOutput>>[] = [];
          const release = () => {
            both.release();
            firstGo.release();
            secondGo.release();
            firstSaved.release();
            secondRead.release();
            receiptsGo.release();
          };
          const cleanup = async () => {
            release();
            await Promise.all(work);
          };
          test.onTestFinished(cleanup);
          own("release all candidate gates and drain both owners", cleanup);
          const left = outcome(owner().initialize(h.context, regular));
          work.push(left);
          const right = outcome(owner(other.db).initialize(h.context, regular));
          work.push(right);
          const failed = Promise.race(
            work.map((pending) =>
              pending.then(({ error }) => {
                release();
                throw error ?? new Error("Participant finished before capture schedule");
              }),
            ),
          );
          // Observed failures immediately release every gate; no participant can strand fixture drain.
          void failed.catch(() => undefined);
          const wait = (gate: Promise<void>) =>
            abortable(Promise.race([gate, failed]), test.signal);
          await wait(both.promise);
          expect(candidates.length).toBe(2);
          const first = candidates[0],
            second = candidates[1];
          if (!first || !second) throw new Error("Missing both real candidates");
          expect(first.key === second.key).toBe(false);
          firstGo.release();
          await wait(firstSaved.promise);
          if (!first.captured) throw new Error("Missing real winning capture");
          expect(first.captured.revision).toBe(1);
          expect(first.captured.receipt).toBeNull();
          secondGo.release();
          await wait(secondRead.promise);
          errorValue(second.conflict, "us_dataset_intent_conflict");
          exact(second.winnerRead, first.captured);
          receiptsGo.release();
          const results = await Promise.all(work);
          for (const result of results) {
            if (result.error !== undefined) throw result.error;
            if (!result.value) throw new Error("Missing concurrent owner result");
            ownedOutput(result.value, expected);
          }
          const a = results[0]?.value,
            b = results[1]?.value;
          if (!a || !b) throw new Error("Missing paired results");
          ownedOutput(a, b);
          const saved = await progressMatches(expected, regular, first.captured);
          for (const participant of candidates) {
            exact(participant.receiptKey, first.key);
            exact(participant.completed, saved);
          }
          exact(saved.intent.operationKey, first.key);
          await onlyProgressChanged(before);
        });
      }),
    );
  });
});
