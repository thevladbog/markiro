import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  UsDatasetCompleteSeedStore,
  type UsDatasetCompleteSeedResult,
} from "../src/modules/traceability/demo/us-dataset-complete-seed";
import { UsDatasetArtifactSeedStore } from "../src/modules/traceability/demo/us-dataset-artifact-seed";
import { UsDatasetTraceReadinessSeedStore } from "../src/modules/traceability/demo/us-dataset-trace-readiness-seed";
import { canonicalExportDigest } from "../src/modules/traceability/demo/us-demo-canonical";
import { readUsRequestPublishedState } from "../src/modules/traceability/requests/us-request-publication-read";
import { requireUsRequestPackageEvidence } from "../src/modules/traceability/requests/us-request-run-evidence";
import { parseUsPlanPublishedRow } from "../src/modules/traceability/plans/us-plan-published";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import { UsRequestPrepareStore } from "../src/modules/traceability/requests/us-request-prepare";
import { createUsDatasetCompleteFixture } from "./support/us-dataset-complete-fixture";
import { createUsWorkerDatabaseTransport } from "./support/us-request-worker-fixture";
import { specialFault } from "./support/us-dataset-special-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function evidence(label: string, value: unknown) {
  process.stdout.write(`${label}: ${JSON.stringify(value)}\n`);
}
const selections = [
  { key: "request_scenario_a", reference: "REQ-2026-APPLE-001", chains: ["chain_0259"] },
  {
    key: "request_april",
    reference: "MUS-REQ-APRIL-001",
    chains: [
      "chain_0000",
      "chain_0001",
      "chain_0002",
      "chain_0003",
      "chain_0004",
      "chain_0005",
      "chain_0006",
      "chain_0007",
      "chain_0008",
      "chain_0009",
      "chain_0010",
      "chain_0011",
    ],
  },
  {
    key: "request_september",
    reference: "MUS-REQ-SEPTEMBER-001",
    chains: [
      "chain_0208",
      "chain_0209",
      "chain_0210",
      "chain_0211",
      "chain_0212",
      "chain_0213",
      "chain_0214",
      "chain_0215",
      "chain_0216",
      "chain_0217",
      "chain_0218",
      "chain_0219",
    ],
  },
] as const;
type Group = "generation" | "recovery" | "replay" | "private_integrity";
type Pending = { id: string; operation_key: string; input_digest: string; input: unknown };
describe.skipIf(!base)("actual complete six-month seed owner", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetCompleteFixture>>;
  let acquisition: Promise<void> | undefined;
  const work = new Set<Promise<unknown>>();
  const elapsed: Record<Group, number> = {
    generation: 0,
    recovery: 0,
    replay: 0,
    private_integrity: 0,
  };
  const started = performance.now();
  function track<T>(promise: Promise<T>): Promise<T> {
    work.add(promise);
    void promise.then(
      () => work.delete(promise),
      () => work.delete(promise),
    );
    return promise;
  }
  async function measure<T>(group: Group, label: string, action: () => Promise<T>): Promise<T> {
    if (work.size) throw new Error("us_dataset_complete_prior_work_live");
    const start = performance.now();
    let result: T;
    try {
      result = await track(Promise.resolve().then(action));
    } finally {
      const ms = performance.now() - start;
      elapsed[group] += ms;
      evidence("Complete seed phase", {
        group,
        label,
        elapsedMs: ms,
        groupElapsedMs: elapsed[group],
        processPeakRssKiB: process.resourceUsage().maxRSS,
      });
    }
    if (elapsed[group] > 900_000) throw new Error(`complete_seed_${group}_budget_exceeded`);
    return result;
  }
  function phase(group: Group, label: string, action: () => Promise<unknown>) {
    beforeAll(() => measure(group, label, action), 900_000);
  }
  const store = () => new UsDatasetCompleteSeedStore(f.db, f.services);
  async function snapshot(label: string) {
    const value = await f.snapshot();
    evidence("Complete seed full DB snapshot", {
      label,
      tables: value,
      digest: canonicalExportDigest(value),
    });
    return value;
  }
  async function refuseBoth(context = f.context) {
    const before = await snapshot("refusal-before"),
      writes = f.writes();
    const observed = createUsWorkerDatabaseTransport(f.db);
    const owner = new UsDatasetCompleteSeedStore(observed.db, f.services);
    await expect(owner.initialize(context)).rejects.toThrow();
    await expect(owner.verify(context)).rejects.toThrow();
    expect(observed.mutationStatements).toEqual([]);
    expect(await snapshot("refusal-after")).toEqual(before);
    expect(f.writes()).toEqual(writes);
  }
  beforeAll(async () => {
    if (!base) throw new Error("Missing synthetic database");
    acquisition = createUsDatasetCompleteFixture(base).then((value) => {
      f = value;
    });
    await track(acquisition);
    evidence("Owned complete dataset database", { databaseName: f.databaseName });
  }, 60_000);
  afterAll(async () => {
    await acquisition?.catch(() => undefined);
    while (work.size) await Promise.allSettled([...work]);
    if (!f) return;
    try {
      const active = await f.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND state<>'idle'",
      );
      expect(active.rows).toEqual([{ n: 0 }]);
      const db = await f.pool.query<{ bytes: string }>(
        "SELECT pg_database_size(current_database())::text AS bytes",
      );
      evidence("Complete seed final measurements", {
        groupsMs: elapsed,
        totalMs: performance.now() - started,
        processPeakRssKiB: process.resourceUsage().maxRSS,
        databaseBytes: db.rows[0]?.bytes,
        privatePlanBytes: [...f.plan.objects.values()].reduce((n, bytes) => n + bytes.length, 0),
        privatePackageBytes: [...f.packages.objects.values()].reduce(
          (n, object) => n + object.bytes.length,
          0,
        ),
        providerWrites: f.writes(),
      });
    } finally {
      const name = f.databaseName;
      await f.close();
      evidence("Disposed complete dataset database verified absent", { databaseName: name });
    }
  }, 60_000);
  it("fresh verify refuses without installing prerequisites", () =>
    measure("recovery", "fresh verify", async () => {
      const before = await snapshot("fresh-before"),
        writes = f.writes();
      const observed = createUsWorkerDatabaseTransport(f.db);
      await expect(
        new UsDatasetCompleteSeedStore(observed.db, f.services).verify(f.context),
      ).rejects.toThrow(/incomplete/);
      expect(observed.mutationStatements).toEqual([]);
      expect(await snapshot("fresh-after")).toEqual(before);
      expect(f.writes()).toEqual(writes);
    }));
  it("nonperformance probe preserves original errors and refuses overlapping tracked work", async () => {
    const saved = elapsed.recovery;
    const original = new Error("synthetic_original_phase_failure");
    elapsed.recovery = 900_001;
    try {
      await expect(
        measure("recovery", "nonperformance artificial budget/error probe", () =>
          Promise.reject(original),
        ),
      ).rejects.toBe(original);
    } finally {
      elapsed.recovery = saved;
    }
    let release = () => {};
    const live = new Promise<void>((resolve) => {
      release = resolve;
    });
    work.add(live);
    let called = false;
    try {
      await expect(
        measure("recovery", "nonperformance overlapping-work probe", async () => {
          called = true;
        }),
      ).rejects.toThrow("us_dataset_complete_prior_work_live");
      expect(called).toBe(false);
    } finally {
      release();
      await live;
      work.delete(live);
    }
  });
  describe("interrupted actual generation", () => {
    let pending: Pending[];
    let clocks: unknown;
    let originalFailure: unknown;
    phase("generation", "all 262 native units then April receipt interruption", async () => {
      const remove = await specialFault(
        f,
        "traceability_demo_dataset_stages",
        "UPDATE",
        "NEW.unit_key='request_april' AND NEW.stage='package' AND NEW.receipt IS NOT NULL",
        "XX000",
      );
      const actual = UsDatasetArtifactSeedStore.prototype.initialize;
      let forwarded: unknown;
      let descriptors: PropertyDescriptorMap | undefined;
      const observer = vi
        .spyOn(UsDatasetArtifactSeedStore.prototype, "initialize")
        .mockImplementation(async function (this: UsDatasetArtifactSeedStore, ...args) {
          try {
            return await actual.apply(this, args);
          } catch (error) {
            forwarded = error;
            if (error instanceof Error) descriptors = Object.getOwnPropertyDescriptors(error);
            throw error;
          }
        });
      try {
        originalFailure = await store()
          .initialize(f.context)
          .then(
            () => {
              throw new Error("Expected interrupted generation");
            },
            (error: unknown) => error,
          );
        expect(originalFailure).toBe(forwarded);
        expect(originalFailure).toMatchObject({
          cause: { code: "XX000", message: "special_sql_fault" },
        });
        expect(Object.getOwnPropertyDescriptors(originalFailure)).toEqual(descriptors);
      } finally {
        observer.mockRestore();
        await remove();
      }
      pending = (
        await f.pool.query<Pending>(
          "SELECT id,operation_key,input_digest,input FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key='request_april' ORDER BY stage",
          [f.context.tenantId],
        )
      ).rows;
      clocks = (
        await f.pool.query(
          "SELECT r.id,r.received_at,r.due_at FROM trace_requests r WHERE r.tenant_id=$1 AND r.request_number='MUS-REQ-APRIL-001'",
          [f.context.tenantId],
        )
      ).rows;
      evidence("Complete seed interrupted identities", { pending, clocks });
    });
    it("preserves the first actual failure and stops before September", () =>
      measure("recovery", "interrupted assertions", async () => {
        expect(originalFailure).toBeInstanceOf(Error);
        expect(pending).toHaveLength(2);
        expect(
          (
            await f.pool.query(
              "SELECT request_number FROM trace_requests WHERE tenant_id=$1 ORDER BY request_number",
              [f.context.tenantId],
            )
          ).rows,
        ).toEqual([
          { request_number: "MUS-REQ-APRIL-001" },
          { request_number: "REQ-2026-APPLE-001" },
        ]);
        expect(
          (
            await f.pool.query(
              "SELECT status FROM trace_export_runs WHERE tenant_id=$1 ORDER BY id",
              [f.context.tenantId],
            )
          ).rows,
        ).toEqual([{ status: "ready" }, { status: "ready" }]);
        expect(
          (
            await f.pool.query(
              "SELECT unit_key,stage,receipt FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND receipt IS NULL",
              [f.context.tenantId],
            )
          ).rows,
        ).toEqual([{ unit_key: "request_april", stage: "package", receipt: null }]);
      }));
    describe("middle pending read-only verification", () => {
      let before: Awaited<ReturnType<typeof f.snapshot>>;
      phase("recovery", "pending verify and full before/after", async () => {
        before = await snapshot("pending-before");
        const writes = f.writes(),
          observed = createUsWorkerDatabaseTransport(f.db);
        await expect(
          new UsDatasetCompleteSeedStore(observed.db, f.services).verify(f.context),
        ).rejects.toThrow("us_dataset_request_incomplete");
        expect(observed.mutationStatements).toEqual([]);
        expect(await snapshot("pending-after")).toEqual(before);
        expect(f.writes()).toEqual(writes);
      });
      it("leaves every public table and private publication unchanged", () => {
        expect(Object.keys(before).length).toBeGreaterThan(190);
      });
      describe("resume full installation", () => {
        let result: UsDatasetCompleteSeedResult;
        phase("recovery", "resume same April run and create September", async () => {
          result = await store().initialize(f.context);
        });
        it("returns all 262 units and exact shared identities with original middle clocks", () =>
          measure("recovery", "completed identity assertions", async () => {
            expect(result).toMatchObject({
              state: "six_month_seed_stages_verified",
              datasetComplete: false,
              trace: { state: "native_chains_trace_readiness_verified" },
              artifacts: { state: "plan_request_artifacts_verified" },
            });
            expect(result.trace.units.map(({ unitKey }) => unitKey)).toEqual([
              ...Array.from({ length: 260 }, (_, i) => `chain_${String(i).padStart(4, "0")}`),
              "correction_0001",
              "orphan_0001",
            ]);
            expect(result.artifacts.requests.map(({ unitKey }) => unitKey)).toEqual([
              "request_scenario_a",
              "request_april",
              "request_september",
            ]);
            for (const value of [
              result.trace,
              result.trace.native,
              result.trace.native.regular,
              result.trace.native.special,
              result.artifacts,
              result.artifacts.plan,
              ...result.artifacts.requests,
            ])
              expect([value.datasetId, value.version, value.definitionDigest]).toEqual([
                result.datasetId,
                "us-processor-six-month-v1",
                result.definitionDigest,
              ]);
            const frozen = (value: unknown): void => {
              if (value !== null && typeof value === "object") {
                expect(Object.isFrozen(value)).toBe(true);
                for (const child of Object.values(value)) frozen(child);
              }
            };
            frozen(result);
            expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024);
            expect(
              (
                await f.pool.query<Pending>(
                  "SELECT id,operation_key,input_digest,input FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND unit_key='request_april' ORDER BY stage",
                  [f.context.tenantId],
                )
              ).rows,
            ).toEqual(pending);
            expect(
              (
                await f.pool.query(
                  "SELECT r.id,r.received_at,r.due_at FROM trace_requests r WHERE r.tenant_id=$1 AND r.request_number='MUS-REQ-APRIL-001'",
                  [f.context.tenantId],
                )
              ).rows,
            ).toEqual(clocks);
            expect(
              (
                await f.pool.query(
                  "WITH roots AS (SELECT tenant_id,current_event_id FROM receiving_event_roots UNION ALL SELECT tenant_id,current_event_id FROM transformation_event_roots UNION ALL SELECT tenant_id,current_event_id FROM shipping_event_roots) SELECT (SELECT count(*)::int FROM roots WHERE tenant_id=$1) roots,(SELECT count(*)::int FROM roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.current_event_id WHERE r.tenant_id=$1 AND e.status='finalized') finalized,(SELECT count(*)::int FROM traceability_lots WHERE tenant_id=$1) lots,(SELECT count(DISTINCT b.id)::int FROM boxes b JOIN traceability_synthetic_case_origins o ON o.tenant_id=b.tenant_id AND o.box_id=b.id WHERE b.tenant_id=$1) boxes",
                  [f.context.tenantId],
                )
              ).rows,
            ).toEqual([{ roots: 964, finalized: 963, lots: 785, boxes: 15700 }]);
            expect(
              (
                await f.pool.query(
                  "SELECT count(*)::int AS n FROM traceability_demo_dataset_stages WHERE tenant_id=$1 AND stage='trace_readiness' AND revision=2 AND receipt IS NOT NULL",
                  [f.context.tenantId],
                )
              ).rows,
            ).toEqual([{ n: 262 }]);
            evidence("Complete seed stable result", result);
          }));
        for (const selection of selections)
          it(`verifies actual ${selection.chains.length}-chain closure and every private byte for ${selection.reference}`, () =>
            measure("private_integrity", `closure ${selection.key}`, async () => {
              const request = result.artifacts.requests.find(
                (row) => row.unitKey === selection.key,
              );
              if (!request) throw new Error("Missing prescribed Request");
              const published = await f.db.transaction((tx) =>
                readUsRequestPublishedState(tx, f.context.tenantId, request.run.id),
              );
              expect(published.run.status).toBe("ready");
              expect(published.run.mode).toBe("export_ready");
              expect(published.run.planVersionId).toBe(result.artifacts.plan.plan.id);
              const capture = requireUsRequestPackageEvidence(
                published.run,
                f.context.tenantId,
              ).validationSnapshot;
              const events = await f.pool.query(
                "SELECT DISTINCT e.id AS \"eventId\",e.revision,e.root_event_id AS \"rootEventId\",'match' AS reason FROM traceability_demo_dataset_stages s CROSS JOIN LATERAL jsonb_array_elements_text(s.receipt->'recordIds') ids(id) JOIN traceability_events e ON e.id=ids.id::uuid AND e.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.unit_key=ANY($2) AND s.stage IN ('receiving','transformation','shipping') ORDER BY e.id",
                [f.context.tenantId, selection.chains],
              );
              expect(
                [...capture.selection.records].sort((a, b) => a.eventId.localeCompare(b.eventId)),
              ).toEqual(events.rows);
              const lots = await f.pool.query<{ id: string }>(
                "SELECT DISTINCT l.id FROM traceability_demo_dataset_stages s CROSS JOIN LATERAL jsonb_array_elements_text(s.receipt->'recordIds') ids(id) JOIN traceability_lots l ON l.id=ids.id::uuid AND l.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.unit_key=ANY($2) AND s.stage IN ('receiving','transformation') ORDER BY l.id",
                [f.context.tenantId, selection.chains],
              );
              expect(capture.selection.lotIds).toEqual(lots.rows.map(({ id }) => id));
              expect(capture.selection.records.length).toBeGreaterThanOrEqual(
                selection.chains.length * 3,
              );
              expect(capture.selection.records.length).toBeLessThan(500);
              expect(Buffer.byteLength(JSON.stringify(published.run.inputSnapshot))).toBeLessThan(
                16 * 1024 * 1024,
              );
              const objects = new Map<string, Buffer>();
              for (const artifact of published.artifacts) {
                const bytes = await f.packages.store.readVerified(
                  { tenantId: f.context.tenantId, runId: request.run.id },
                  artifact,
                );
                expect([bytes.length, hash(bytes)]).toEqual([artifact.byteSize, artifact.sha256]);
                objects.set(artifact.name, bytes);
              }
              const zip = objects.get("package.zip");
              if (!zip) throw new Error("Missing package ZIP");
              const entries = unzipSync(zip);
              expect(Object.keys(entries).sort()).toEqual(
                published.expectation.entries.map(({ name }) => name).sort(),
              );
              for (const entry of published.expectation.entries) {
                const bytes = entries[entry.name];
                if (!bytes) throw new Error("Missing private ZIP entry");
                expect([bytes.length, hash(bytes)]).toEqual([entry.byteSize, entry.sha256]);
              }
              const [planRow] = await f.db.select().from(schema.traceabilityPlanVersions);
              if (!planRow) throw new Error("Missing owned Plan");
              const plan = parseUsPlanPublishedRow(planRow);
              const pdf = await f.plan.artifacts.readVerified(
                { tenantId: f.context.tenantId, versionId: planRow.id },
                plan.artifact,
              );
              expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
              expect([pdf.length, hash(pdf)]).toEqual([
                result.artifacts.plan.artifact.byteSize,
                result.artifacts.plan.artifact.sha256,
              ]);
              evidence("Complete seed native package bytes", {
                unitKey: selection.key,
                records: capture.selection.records.length,
                lots: capture.selection.lotIds.length,
                artifacts: request.artifacts,
              });
            }));
        describe("completed replay with an unrelated queued run", () => {
          let before: Awaited<ReturnType<typeof f.snapshot>>;
          let writes: ReturnType<typeof f.writes>;
          let queued: Awaited<ReturnType<UsRequestPrepareStore["prepare"]>>;
          let initialized: UsDatasetCompleteSeedResult;
          let verified: UsDatasetCompleteSeedResult;
          phase("replay", "unrelated queued run baseline", async () => {
            const [lot] = await f.db.select().from(schema.traceabilityLots).limit(1);
            if (!lot) throw new Error("Missing native lot");
            const other = await new UsRequestStore(f.db).create(
              f.context.tenantId,
              f.context.actorUserId,
              {
                requestNumber: "UNRELATED-COMPLETE-001",
                requesterName: "Synthetic unrelated",
                requesterOrganization: null,
                requesterContact: null,
                receivedAt: new Date().toISOString(),
                scope: { tlc: lot.tlc },
              },
            );
            await new UsRequestValidationStore(f.db).validate(
              f.context.tenantId,
              f.context.actorUserId,
              other.id,
              f.services.execution.build,
            );
            queued = await new UsRequestPrepareStore(f.db).prepare(
              f.context.tenantId,
              f.context.actorUserId,
              other.id,
              { mode: "export_ready", idempotencyKey: randomUUID() },
              f.services.execution.build,
            );
            expect(queued.status).toBe("queued");
            before = await snapshot("completed-before");
            writes = f.writes();
          });
          phase("replay", "completed initialize", async () => {
            const observed = createUsWorkerDatabaseTransport(f.db);
            initialized = await new UsDatasetCompleteSeedStore(observed.db, f.services).initialize(
              f.context,
            );
            expect(observed.mutationStatements).toEqual([]);
            expect(await snapshot("completed-initialize-after")).toEqual(before);
            expect(f.writes()).toEqual(writes);
          });
          phase("replay", "completed verify", async () => {
            const observed = createUsWorkerDatabaseTransport(f.db);
            verified = await new UsDatasetCompleteSeedStore(observed.db, f.services).verify(
              f.context,
            );
            expect(observed.mutationStatements).toEqual([]);
            expect(await snapshot("completed-verify-after")).toEqual(before);
            expect(f.writes()).toEqual(writes);
          });
          it("replays equal results without any DB or provider writes or unrelated worker effects", () =>
            measure("replay", "replay assertions", async () => {
              expect(initialized).toEqual(result);
              expect(verified).toEqual(result);
              expect(initialized).not.toBe(result);
              expect(verified.trace).not.toBe(result.trace);
              expect(
                await f.db
                  .select()
                  .from(schema.traceExportRuns)
                  .where(eq(schema.traceExportRuns.id, queued.id)),
              ).toEqual([queued]);
              for (const table of [
                schema.traceExportAttempts,
                schema.traceExportObjectIntents,
                schema.traceExportArtifacts,
              ])
                expect(await f.db.select().from(table).where(eq(table.runId, queued.id))).toEqual(
                  [],
                );
              evidence("Complete seed replay equality", {
                resultDigest: canonicalExportDigest(result),
                initializedDigest: canonicalExportDigest(initialized),
                verifiedDigest: canonicalExportDigest(verified),
                unrelatedRunId: queued.id,
                writes,
              });
            }));
          describe("current authority and native drift", () => {
            describe("wrong tenant proof", () => {
              let checked = false;
              phase("recovery", "wrong tenant", async () => {
                await refuseBoth({ ...f.context, tenantId: randomUUID() });
                checked = true;
              });
              it("refuses a wrong tenant in both modes without writes", () => {
                expect(checked).toBe(true);
              });
            });
            describe("current original owner proof", () => {
              let checked = false;
              phase("recovery", "current owner", async () => {
                await f.pool.query(
                  "UPDATE member SET role='viewer' WHERE organization_id=$1 AND user_id=$2",
                  [f.context.tenantId, f.context.actorUserId],
                );
                try {
                  await refuseBoth();
                } finally {
                  await f.pool.query(
                    "UPDATE member SET role='owner' WHERE organization_id=$1 AND user_id=$2",
                    [f.context.tenantId, f.context.actorUserId],
                  );
                }
                checked = true;
              });
              it("refuses the revoked current original owner in both modes without writes", () => {
                expect(checked).toBe(true);
              });
            });
            describe("current processor profile proof", () => {
              let checked = false;
              phase("recovery", "current profile", async () => {
                await f.db
                  .update(schema.orgProfiles)
                  .set({ timeZone: "America/Chicago" })
                  .where(eq(schema.orgProfiles.tenantId, f.context.tenantId));
                try {
                  await refuseBoth();
                } finally {
                  await f.db
                    .update(schema.orgProfiles)
                    .set({ timeZone: "America/Los_Angeles" })
                    .where(eq(schema.orgProfiles.tenantId, f.context.tenantId));
                }
                checked = true;
              });
              it("refuses a changed current processor profile in both modes without writes", () => {
                expect(checked).toBe(true);
              });
            });
            describe("native drift proof", () => {
              let checked = false;
              phase("recovery", "native drift", async () => {
                const notes = (
                  await f.pool.query<{ id: string; notes: string | null }>(
                    "SELECT id,notes FROM reference_documents WHERE tenant_id=$1",
                    [f.context.tenantId],
                  )
                ).rows;
                await f.pool.query(
                  "UPDATE reference_documents SET notes='Owned complete native drift' WHERE tenant_id=$1",
                  [f.context.tenantId],
                );
                const actual = UsDatasetTraceReadinessSeedStore.prototype.verify;
                let forwarded: unknown;
                const observer = vi
                  .spyOn(UsDatasetTraceReadinessSeedStore.prototype, "verify")
                  .mockImplementation(async function (
                    this: UsDatasetTraceReadinessSeedStore,
                    ...args
                  ) {
                    try {
                      return await actual.apply(this, args);
                    } catch (error) {
                      forwarded = error;
                      throw error;
                    }
                  });
                try {
                  const beforeDrift = await snapshot("drift-before"),
                    provider = f.writes(),
                    observed = createUsWorkerDatabaseTransport(f.db);
                  const failed = await new UsDatasetCompleteSeedStore(observed.db, f.services)
                    .verify(f.context)
                    .then(
                      () => {
                        throw new Error("Expected native drift");
                      },
                      (error: unknown) => error,
                    );
                  expect(failed).toBe(forwarded);
                  expect(failed).toMatchObject({ unitKey: "chain_0000", stage: "shipping" });
                  expect(observed.mutationStatements).toEqual([]);
                  expect(await snapshot("drift-after")).toEqual(beforeDrift);
                  expect(f.writes()).toEqual(provider);
                } finally {
                  observer.mockRestore();
                  await f.pool.query(
                    "UPDATE reference_documents d SET notes=s.notes FROM jsonb_to_recordset($1::jsonb) AS s(id uuid,notes text) WHERE d.id=s.id AND d.tenant_id=$2",
                    [JSON.stringify(notes), f.context.tenantId],
                  );
                }
                checked = true;
              });
              it("retains the actual native drift error, cause and unit/stage without writes", () => {
                expect(checked).toBe(true);
              });
            });
          });
          for (const fault of ["missing", "corrupt"] as const)
            describe(`${fault} final published private byte`, () => {
              let rejected = false;
              phase("private_integrity", `${fault} final September package`, async () => {
                const request = result.artifacts.requests.find(
                  ({ unitKey }) => unitKey === "request_september",
                );
                if (!request) throw new Error("Missing final Request");
                const published = await f.db.transaction((tx) =>
                  readUsRequestPublishedState(tx, f.context.tenantId, request.run.id),
                );
                const artifact = published.artifacts.find(({ name }) => name === "package.zip");
                if (!artifact) throw new Error("Missing final private ZIP descriptor");
                const saved = f.packages.objects.get(artifact.objectKey);
                if (!saved) throw new Error("Missing final private ZIP bytes");
                if (fault === "missing") f.packages.objects.delete(artifact.objectKey);
                else
                  f.packages.objects.set(artifact.objectKey, {
                    ...saved,
                    bytes: Buffer.alloc(saved.bytes.length),
                  });
                try {
                  const beforeFault = await snapshot(`${fault}-before`),
                    provider = f.writes(),
                    observed = createUsWorkerDatabaseTransport(f.db);
                  const callsBefore = f.packages.calls.length;
                  const code =
                    fault === "missing"
                      ? "us_request_package_storage_read_failed"
                      : "us_request_package_storage_checksum_mismatch";
                  await expect(
                    new UsDatasetCompleteSeedStore(observed.db, f.services).verify(f.context),
                  ).rejects.toMatchObject({ code, message: code });
                  expect(
                    f.packages.calls
                      .slice(callsBefore)
                      .some(
                        ({ command }) =>
                          command instanceof GetObjectCommand &&
                          command.input.Key === artifact.objectKey,
                      ),
                  ).toBe(true);
                  expect(observed.mutationStatements).toEqual([]);
                  expect(await snapshot(`${fault}-after`)).toEqual(beforeFault);
                  expect(f.writes()).toEqual(provider);
                  evidence("Complete seed final private refusal", {
                    fault,
                    code,
                    unitKey: request.unitKey,
                    runId: request.run.id,
                    artifactId: artifact.id,
                    sha256: artifact.sha256,
                    finalZipGetObserved: true,
                  });
                  rejected = true;
                } finally {
                  f.packages.objects.set(artifact.objectKey, saved);
                }
              });
              it(`refuses ${fault} final bytes without repair or replacement`, () => {
                expect(rejected).toBe(true);
              });
            });
        });
      });
    });
  });
});
