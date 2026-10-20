import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@markiro/db";
import { unzipSync } from "fflate";
import {
  UsDatasetArtifactSeedStore,
  type UsDatasetArtifactResult,
} from "../src/modules/traceability/demo/us-dataset-artifact-seed";
import { UsDatasetRegularSeedStore } from "../src/modules/traceability/demo/us-dataset-regular-seed";
import { createUsDatasetRequestFixture } from "./support/us-dataset-request-fixture";
import { createUsWorkerDatabaseTransport } from "./support/us-request-worker-fixture";
import { readUsRequestPublishedState } from "../src/modules/traceability/requests/us-request-publication-read";
import { requireUsRequestPackageEvidence } from "../src/modules/traceability/requests/us-request-run-evidence";
import { parseUsPlanPublishedRow } from "../src/modules/traceability/plans/us-plan-published";

const base = process.env.US_TEST_DATABASE_URL;
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
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!base)("owned dataset Plan and three native packages", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetRequestFixture>>;
  const work = new Set<Promise<unknown>>();
  function track<T>(promise: Promise<T>): Promise<T> {
    work.add(promise);
    void promise.then(
      () => work.delete(promise),
      () => work.delete(promise),
    );
    return promise;
  }
  function phase(label: string, action: () => Promise<unknown>) {
    beforeAll(async () => {
      const started = performance.now();
      await track(action());
      process.stdout.write(
        `Native artifact phase ${label}: ${Math.round(performance.now() - started)}ms\n`,
      );
    }, 60_000);
  }
  const store = () => new UsDatasetArtifactSeedStore(f.db, f.services);
  beforeAll(async () => {
    if (!base) throw new Error("Missing synthetic database");
    f = await track(createUsDatasetRequestFixture(base));
    process.stdout.write(`Owned artifact dataset database: ${f.databaseName}\n`);
  }, 60_000);
  afterAll(async () => {
    while (work.size) await Promise.allSettled([...work]);
    if (f) {
      const name = f.databaseName;
      await f.close();
      process.stdout.write(`Disposed artifact dataset database verified absent: ${name}\n`);
    }
  }, 60_000);

  describe("missing middle prerequisite", () => {
    phase("missing April", async () => {
      await expect(store().initialize(f.context)).rejects.toThrow();
    });
    it("stops after Scenario A without inventing April, September or chains", () =>
      track(
        (async () => {
          expect(
            (await f.db.select().from(schema.traceRequests)).map((row) => row.requestNumber),
          ).toEqual(["REQ-2026-APPLE-001"]);
          const runs = await f.db.select().from(schema.traceExportRuns);
          expect(runs).toHaveLength(1);
          expect(runs[0]?.status).toBe("ready");
          expect(
            (
              await f.pool.query(
                "SELECT DISTINCT unit_key FROM traceability_demo_dataset_stages WHERE unit_key LIKE 'chain_%'",
              )
            ).rows,
          ).toEqual([{ unit_key: "chain_0259" }]);
          const before = await f.snapshot(),
            writes = f.writes();
          await expect(store().verify(f.context)).rejects.toThrow();
          expect(await f.snapshot()).toEqual(before);
          expect(f.writes()).toEqual(writes);
        })(),
      ));
  });

  describe("complete native prerequisites and a lost middle receipt", () => {
    for (const startIndex of [0, 6, 208, 214]) {
      phase(`six chains ${startIndex}`, () =>
        new UsDatasetRegularSeedStore(f.db).initialize(f.context, { startIndex, count: 6 }),
      );
    }
    let pending: {
      id: string;
      input: unknown;
      request_id: string;
      received_at: Date;
      due_at: Date;
    };
    let pendingPackage: { id: string; input: unknown };
    phase("April receipt interruption", async () => {
      await f.pool.query(
        "CREATE FUNCTION reject_middle_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_middle_receipt_failure' USING ERRCODE='XX000'; END $$",
      );
      await f.pool.query(
        "CREATE TRIGGER reject_middle_receipt BEFORE UPDATE OF receipt ON traceability_demo_dataset_stages FOR EACH ROW WHEN (NEW.unit_key='request_april' AND NEW.stage='package') EXECUTE FUNCTION reject_middle_receipt()",
      );
      try {
        await expect(store().initialize(f.context)).rejects.toMatchObject({
          cause: { code: "XX000" },
        });
      } finally {
        await f.pool.query(
          "DROP TRIGGER reject_middle_receipt ON traceability_demo_dataset_stages",
        );
        await f.pool.query("DROP FUNCTION reject_middle_receipt()");
      }
      const row = (
        await f.pool.query<typeof pending>(
          "SELECT s.id,s.input,r.id AS request_id,r.received_at,r.due_at FROM traceability_demo_dataset_stages s JOIN trace_requests r ON r.id=(s.input->'request'->>'id')::uuid WHERE s.unit_key='request_april' AND s.stage='request'",
        )
      ).rows[0];
      const pkg = (
        await f.pool.query<typeof pendingPackage>(
          "SELECT id,input FROM traceability_demo_dataset_stages WHERE unit_key='request_april' AND stage='package'",
        )
      ).rows[0];
      if (!row || !pkg) throw new Error("Missing owned pending middle identity");
      pending = row;
      pendingPackage = pkg;
    });
    let partialBefore: Awaited<ReturnType<typeof f.snapshot>>;
    let partialWrites: ReturnType<typeof f.writes>;
    phase("pending April verify with all-row baseline", async () => {
      partialBefore = await f.snapshot();
      partialWrites = f.writes();
      await expect(store().verify(f.context)).rejects.toThrow("us_dataset_request_incomplete");
    });
    it("keeps only two native Ready runs and the April package receipt pending", () =>
      track(
        (async () => {
          expect(
            (await f.db.select().from(schema.traceRequests)).map((row) => row.requestNumber).sort(),
          ).toEqual(["MUS-REQ-APRIL-001", "REQ-2026-APPLE-001"]);
          const runs = await f.db.select().from(schema.traceExportRuns);
          expect(runs).toHaveLength(2);
          expect(runs.every((run) => run.status === "ready")).toBe(true);
          expect(
            (
              await f.pool.query(
                "SELECT receipt FROM traceability_demo_dataset_stages WHERE unit_key='request_april' AND stage='package'",
              )
            ).rows,
          ).toEqual([{ receipt: null }]);
          expect(await f.snapshot()).toEqual(partialBefore);
          expect(f.writes()).toEqual(partialWrites);
        })(),
      ));

    describe("resume and completed verification", () => {
      let result: UsDatasetArtifactResult;
      phase("resume same April and create September", async () => {
        result = await store().initialize(f.context);
      });
      it("creates all three native export_ready packages for the literal recipe references", () =>
        track(
          (async () => {
            expect(result.state).toBe("plan_request_artifacts_verified");
            expect(result.datasetComplete).toBe(false);
            expect(result.plan).toEqual(f.ownedPlan);
            expect(result.requests.map((request) => request.unitKey)).toEqual([
              "request_scenario_a",
              "request_april",
              "request_september",
            ]);
            expect(Object.isFrozen(result)).toBe(true);
            expect(Object.isFrozen(result.requests)).toBe(true);
            const rows = await f.db.select().from(schema.traceRequests);
            expect(rows.map((row) => row.requestNumber).sort()).toEqual([
              "MUS-REQ-APRIL-001",
              "MUS-REQ-SEPTEMBER-001",
              "REQ-2026-APPLE-001",
            ]);
            const middle = rows.find((row) => row.requestNumber === "MUS-REQ-APRIL-001");
            expect(middle?.id).toBe(pending.request_id);
            expect(middle?.receivedAt).toEqual(pending.received_at);
            expect(middle?.dueAt).toEqual(pending.due_at);
            expect(
              (
                await f.pool.query(
                  "SELECT id,input FROM traceability_demo_dataset_stages WHERE id=$1",
                  [pending.id],
                )
              ).rows,
            ).toEqual([{ id: pending.id, input: pending.input }]);
            expect(
              (
                await f.pool.query(
                  "SELECT id,input FROM traceability_demo_dataset_stages WHERE id=$1",
                  [pendingPackage.id],
                )
              ).rows,
            ).toEqual([pendingPackage]);
            const plans = await f.db.select().from(schema.traceabilityPlanVersions);
            expect(plans).toHaveLength(1);
            expect(plans[0]).toMatchObject({ id: f.ownedPlan.plan.id, status: "effective" });
            const runs = await f.db.select().from(schema.traceExportRuns);
            expect(runs).toHaveLength(3);
            expect(
              runs.every(
                (run) =>
                  run.status === "ready" &&
                  run.mode === "export_ready" &&
                  run.planVersionId === f.ownedPlan.plan.id,
              ),
            ).toBe(true);
            expect(
              (
                await f.pool.query(
                  "SELECT count(DISTINCT unit_key)::int AS count FROM traceability_demo_dataset_stages WHERE unit_key LIKE 'chain_%'",
                )
              ).rows,
            ).toEqual([{ count: 25 }]);
          })(),
        ));
      for (const selection of selections) {
        it(`selects the exact native ${selection.chains.length}-chain closure for ${selection.reference} and reads every private artifact`, () =>
          track(
            (async () => {
              const request = result.requests.find((value) => value.unitKey === selection.key);
              if (!request) throw new Error("Missing result request");
              const published = await f.db.transaction((tx) =>
                readUsRequestPublishedState(tx, f.context.tenantId, request.run.id),
              );
              const snapshot = requireUsRequestPackageEvidence(
                published.run,
                f.context.tenantId,
              ).validationSnapshot;
              // Literal fixture keys and native rows form the oracle; no production selection helper participates.
              const expectedEvents = await f.pool.query<{
                eventId: string;
                revision: number;
                rootEventId: string;
                reason: string;
              }>(
                `SELECT DISTINCT e.id AS "eventId", e.revision, e.root_event_id AS "rootEventId", 'match' AS reason FROM traceability_demo_dataset_stages s CROSS JOIN LATERAL jsonb_array_elements_text(s.receipt->'recordIds') ids(id) JOIN traceability_events e ON e.id=ids.id::uuid AND e.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.unit_key=ANY($2) AND s.stage IN ('receiving','transformation','shipping') ORDER BY e.id`,
                [f.context.tenantId, selection.chains],
              );
              expect(
                [...snapshot.selection.records].sort((a, b) => a.eventId.localeCompare(b.eventId)),
              ).toEqual(expectedEvents.rows);
              const expectedLots = await f.pool.query<{ id: string }>(
                `SELECT DISTINCT l.id FROM traceability_demo_dataset_stages s CROSS JOIN LATERAL jsonb_array_elements_text(s.receipt->'recordIds') ids(id) JOIN traceability_lots l ON l.id=ids.id::uuid AND l.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.unit_key=ANY($2) AND s.stage IN ('receiving','transformation') ORDER BY l.id`,
                [f.context.tenantId, selection.chains],
              );
              expect(snapshot.selection.lotIds).toEqual(expectedLots.rows.map((row) => row.id));
              expect(snapshot.selection.records.length).toBeGreaterThanOrEqual(
                selection.chains.length * 3,
              );
              expect(snapshot.selection.records.length).toBeLessThan(500);
              const frozenBytes = Buffer.byteLength(JSON.stringify(published.run.inputSnapshot));
              expect(frozenBytes).toBeLessThan(16 * 1024 * 1024);
              const objects = new Map<string, Buffer>();
              for (const artifact of published.artifacts) {
                const bytes = await f.packages.store.readVerified(
                  { tenantId: f.context.tenantId, runId: request.run.id },
                  artifact,
                );
                expect(bytes.length).toBe(artifact.byteSize);
                expect(hash(bytes)).toBe(artifact.sha256);
                objects.set(artifact.name, bytes);
              }
              const zip = objects.get("package.zip");
              if (!zip) throw new Error("Missing package ZIP");
              const entries = unzipSync(zip);
              expect(Object.keys(entries).sort()).toEqual(
                published.expectation.entries.map((entry) => entry.name).sort(),
              );
              for (const entry of published.expectation.entries) {
                const bytes = entries[entry.name];
                if (!bytes) throw new Error("Missing private ZIP member");
                expect(bytes.length).toBe(entry.byteSize);
                expect(hash(bytes)).toBe(entry.sha256);
              }
              const [planRow] = await f.db.select().from(schema.traceabilityPlanVersions);
              if (!planRow) throw new Error("Missing owned Plan");
              const plan = parseUsPlanPublishedRow(planRow);
              const pdf = await f.plan.artifacts.readVerified(
                { tenantId: f.context.tenantId, versionId: planRow.id },
                plan.artifact,
              );
              expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
              expect(hash(pdf)).toBe(result.plan.artifact.sha256);
              process.stdout.write(
                `Native package evidence ${selection.key}: ${JSON.stringify({ chains: selection.chains.length, records: snapshot.selection.records.length, lots: snapshot.selection.lotIds.length, frozenBytes, artifacts: published.artifacts.map(({ name, byteSize, sha256 }) => ({ name, byteSize, sha256 })), planPdfBytes: pdf.length })}\n`,
              );
            })(),
          ));
      }
      describe("completed replay", () => {
        let before: Awaited<ReturnType<typeof f.snapshot>>;
        let writes: ReturnType<typeof f.writes>;
        let initialized: UsDatasetArtifactResult;
        let verified: UsDatasetArtifactResult;
        const sqlWrites: string[] = [];
        function mutations(transport: ReturnType<typeof createUsWorkerDatabaseTransport>) {
          return transport.statements
            .filter(({ raw }) => /\b(insert into|update "|delete from)\b/i.test(raw))
            .map(({ raw }) => raw);
        }
        phase("completed initialize with all-row baseline", async () => {
          before = await f.snapshot();
          writes = f.writes();
          const transport = createUsWorkerDatabaseTransport(f.db);
          initialized = await new UsDatasetArtifactSeedStore(transport.db, f.services).initialize(
            f.context,
          );
          sqlWrites.push(...mutations(transport));
        });
        phase("completed verify", async () => {
          const transport = createUsWorkerDatabaseTransport(f.db);
          verified = await new UsDatasetArtifactSeedStore(transport.db, f.services).verify(
            f.context,
          );
          sqlWrites.push(...mutations(transport));
        });
        it("returns identical immutable results with no database or provider writes", () =>
          track(
            (async () => {
              expect(initialized).toEqual(result);
              expect(verified).toEqual(result);
              expect(sqlWrites).toEqual([]);
              expect(await f.snapshot()).toEqual(before);
              expect(f.writes()).toEqual(writes);
            })(),
          ));
      });
    });
  });
});
