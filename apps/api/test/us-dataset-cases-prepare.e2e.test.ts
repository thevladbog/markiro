import { runDatasetCasesFixtureBody } from "./support/us-dataset-cases-fixture";
import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareUsDatasetCases } from "../src/modules/traceability/demo/us-dataset-cases-prepare";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  datasetCasesFixtureReceipt,
  insertDatasetCasesFixtureSupport,
  prepareDatasetCasesFixture,
} from "./support/us-dataset-cases-fixture";
import { datasetTransformationStores } from "./support/us-dataset-transformation-fixture";
import {
  outcome,
  startObservation,
  waitBlocked,
  withOwnedWork,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Dataset Cases operation-first preparation", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing US fixture");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  it.each(["database", "user", "owner", "provenance", "role", "profile", "timezone"])(
    "denies current %s before malformed unit input with zero writes",
    async (kind) => {
      return runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          p = await prepareDatasetCasesFixture(f, context, 0);
        const malformed = { index: "malformed", support: null };
        await f.pool.query(
          "UPDATE traceability_demo_dataset_stages SET input=$1,input_digest=$2 WHERE dataset_id=$3 AND stage='cases'",
          [malformed, canonicalExportDigest(malformed), p.datasetId],
        );
        if (kind === "owner")
          await f.pool.query('UPDATE "user" SET name=$1 WHERE id=$2', [
            "Changed owner",
            context.actorUserId,
          ]);
        if (kind === "provenance")
          await f.pool.query("UPDATE organization SET metadata='{}' WHERE id=$1", [
            context.tenantId,
          ]);
        if (kind === "role")
          await f.pool.query("UPDATE member SET role='viewer' WHERE user_id=$1", [
            context.actorUserId,
          ]);
        if (kind === "profile")
          await f.db
            .update(schema.traceabilityProfiles)
            .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
            .where(eq(schema.traceabilityProfiles.tenantId, context.tenantId));
        if (kind === "timezone")
          await f.pool.query("UPDATE org_profiles SET time_zone='UTC' WHERE tenant_id=$1", [
            context.tenantId,
          ]);
        const db = kind === "user" ? await f.alternateRole() : f.db;
        const checked =
          kind === "database"
            ? { ...context, expectedDatabaseName: "wrong_owned_database" }
            : context;
        const before = await f.snapshot();
        await expect(
          db.transaction((tx) =>
            prepareUsDatasetCases(
              tx,
              checked,
              p.datasetId,
              "malformed/unit",
              { mode: "application" },
              datasetTransformationStores(db),
            ),
          ),
        ).rejects.toThrow("us_dataset_target_invalid");
        expect(await f.snapshot()).toEqual(before);
      });
    },
  );
  it.each(["dataset", "unit", "lot", "duplicate", "malformed", "101"])(
    "rejects foreign or invalid %s without writes",
    async (kind) => {
      return runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          p = await prepareDatasetCasesFixture(f, context, 0);
        if (!["dataset", "unit"].includes(kind)) {
          const boxes = p.input.support.boxes;
          const input =
            kind === "lot"
              ? { ...p.input, outputLotId: randomUUID() }
              : {
                  ...p.input,
                  support: {
                    ...p.input.support,
                    boxes:
                      kind === "duplicate"
                        ? [...boxes.slice(0, -1), boxes[0]]
                        : kind === "101"
                          ? Array.from({ length: 101 }, () => boxes[0])
                          : boxes.map((box, i) => (i ? box : { ...box, sscc: "bad" })),
                  },
                };
          await f.pool.query(
            "UPDATE traceability_demo_dataset_stages SET input=$1, input_digest=$2 WHERE dataset_id=$3 AND stage='cases'",
            [input, canonicalExportDigest(input), p.datasetId],
          );
        }
        const before = await f.snapshot();
        await expect(
          f.db.transaction((tx) =>
            prepareUsDatasetCases(
              tx,
              context,
              kind === "dataset" ? randomUUID() : p.datasetId,
              kind === "unit" ? "chain_0259" : p.intent.unitKey,
              { mode: "application" },
              datasetTransformationStores(f.db),
            ),
          ),
        ).rejects.toBeDefined();
        expect(await f.snapshot()).toEqual(before);
      });
    },
  );
  it("only fresh verification can bind a pending actual operation and exact supplied receipt", async () => {
    return runDatasetCasesFixtureBody(async () => {
      const context = await f.provision(),
        p = await prepareDatasetCasesFixture(f, context, 0),
        stores = datasetTransformationStores(f.db);
      const before = await f.snapshot(),
        abort = new Error("end private verification");
      await expect(
        f.db.transaction(async (tx) => {
          await prepareUsDatasetCases(
            tx,
            context,
            p.datasetId,
            p.intent.unitKey,
            { mode: "application" },
            stores,
          );
          await insertDatasetCasesFixtureSupport(tx, context, p.input);
          const linked = await new UsCaseStore(f.db).linkDemoInTransaction(
            tx,
            context,
            p.datasetId,
            p.intent.unitKey,
            "fresh-evidence",
          );
          const receipt = await datasetCasesFixtureReceipt(
            tx,
            context,
            p.input,
            p.intent,
            linked,
            "fresh-evidence",
          );
          await prepareUsDatasetCases(
            tx,
            context,
            p.datasetId,
            p.intent.unitKey,
            { mode: "fresh_verification", receipt },
            stores,
          );
          await expect(
            prepareUsDatasetCases(
              tx,
              context,
              p.datasetId,
              p.intent.unitKey,
              { mode: "application" },
              stores,
            ),
          ).rejects.toThrow("us_dataset_cases_conflict");
          await expect(
            prepareUsDatasetCases(
              tx,
              context,
              p.datasetId,
              p.intent.unitKey,
              { mode: "replay", receipt },
              stores,
            ),
          ).rejects.toThrow("us_dataset_cases_conflict");
          const altered = { ...receipt.result, operationKey: randomUUID() };
          await expect(
            prepareUsDatasetCases(
              tx,
              context,
              p.datasetId,
              p.intent.unitKey,
              {
                mode: "fresh_verification",
                receipt: {
                  ...receipt,
                  result: altered,
                  resultDigest: canonicalExportDigest(altered),
                },
              },
              stores,
            ),
          ).rejects.toThrow("us_dataset_cases_conflict");
          throw abort;
        }),
      ).rejects.toBe(abort);
      expect(await f.snapshot()).toEqual(before);
    });
  });
  it.each(["pending", "void", "archive", "reference"])(
    "rechecks current upstream %s before support",
    async (kind) => {
      return runDatasetCasesFixtureBody(async () => {
        const context = await f.provision(),
          p = await prepareDatasetCasesFixture(f, context, 0),
          stores = datasetTransformationStores(f.db);
        const stage = await stores.journal.readStage(
          context,
          p.datasetId,
          p.intent.unitKey,
          "transformation",
        );
        if (!stage?.receipt) throw new Error("Missing transformation");
        const { parseUsDatasetTransformationResult } =
          await import("../src/modules/traceability/demo/us-dataset-transformation-contract");
        const root = parseUsDatasetTransformationResult(stage.receipt.result).created.id;
        if (kind === "pending")
          await stores.transformation.amend(
            context.tenantId,
            context.actorUserId,
            root,
            { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "owned drift" },
            "amend",
          );
        if (kind === "void")
          await stores.transformation.void(
            context.tenantId,
            context.actorUserId,
            root,
            { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "owned drift" },
            "void",
          );
        if (kind === "archive")
          await stores.lots.changeStatus(
            context.tenantId,
            context.actorUserId,
            p.input.outputLotId,
            { status: "archived", expectedRevision: 1, reason: "owned drift" },
            "archive",
          );
        if (kind === "reference")
          await f.db
            .update(schema.products)
            .set({ name: "changed owned product" })
            .where(eq(schema.products.id, p.input.outputProductId));
        const before = await f.snapshot();
        await expect(
          f.db.transaction((tx) =>
            prepareUsDatasetCases(
              tx,
              context,
              p.datasetId,
              p.intent.unitKey,
              { mode: "application" },
              stores,
            ),
          ),
        ).rejects.toBeDefined();
        expect(await f.snapshot()).toEqual(before);
      });
    },
  );
  it("waits on the public operation before acquiring roots/lots in the inversion schedule", async (test) => {
    return runDatasetCasesFixtureBody(async () => {
      const observation = startObservation(test, (signal) =>
        withOwnedWork(async (own) => {
          const context = await f.provision(),
            p = await prepareDatasetCasesFixture(f, context, 0);
          await f.db.transaction((tx) => insertDatasetCasesFixtureSupport(tx, context, p.input));
          if (!base) throw new Error("Missing fixture");
          const url = new URL(base);
          url.pathname = "/" + f.databaseName;
          const publicConnection = createDb(url.toString(), { max: 1, statement_timeout: 5000 }),
            seedConnection = createDb(url.toString(), { max: 1, statement_timeout: 5000 });
          own("public-pool", () => publicConnection.pool.end());
          own("seed-pool", () => seedConnection.pool.end());
          const lot = await f.pool.connect();
          own("lot-client", async () => {
            await lot.query("ROLLBACK");
            lot.release();
          });
          await lot.query("BEGIN");
          await lot.query("SELECT id FROM traceability_lots WHERE id=$1 FOR UPDATE", [
            p.input.outputLotId,
          ]);
          const lotPid = (await lot.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
            .rows[0]?.pid;
          const publicPid = (
            await publicConnection.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]?.pid;
          const seedPid = (
            await seedConnection.pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
          ).rows[0]?.pid;
          if (!lotPid || !publicPid || !seedPid) throw new Error("Missing owned PID");
          const manual = outcome(
            new UsCaseStore(publicConnection.db).link(
              context.tenantId,
              context.actorUserId,
              p.input.outputLotId,
              {
                operationKey: p.intent.operationKey,
                ssccs: p.input.support.boxes.map((box) => box.sscc),
              },
              "public-inversion",
            ),
          );
          own("drain-public", async () => {
            await lot.query("ROLLBACK");
            await manual;
          });
          await waitBlocked(f, lotPid, publicPid, signal);
          const seed = outcome(
            seedConnection.db.transaction((tx) =>
              prepareUsDatasetCases(
                tx,
                context,
                p.datasetId,
                p.intent.unitKey,
                { mode: "application" },
                datasetTransformationStores(seedConnection.db),
              ),
            ),
          );
          own("drain-seed", async () => {
            await lot.query("ROLLBACK");
            await Promise.all([manual, seed]);
          });
          await waitBlocked(f, publicPid, seedPid, signal);
          const locks = await f.pool.query(
            "SELECT c.relname FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE l.pid=$1 AND c.relname IN ('receiving_event_roots','transformation_event_roots','traceability_events','traceability_lots')",
            [seedPid],
          );
          expect(locks.rows).toEqual([]);
          await lot.query("ROLLBACK");
          const winner = await manual;
          expect(winner.error).toBeUndefined();
          expect(winner.value?.created).toHaveLength(55);
          expect((await seed).error).toMatchObject({ message: "us_dataset_cases_conflict" });
          const before = await f.snapshot();
          await expect(
            seedConnection.db.transaction((tx) =>
              prepareUsDatasetCases(
                tx,
                context,
                p.datasetId,
                p.intent.unitKey,
                { mode: "application" },
                datasetTransformationStores(seedConnection.db),
              ),
            ),
          ).rejects.toThrow("us_dataset_cases_conflict");
          expect(await f.snapshot()).toEqual(before);
        }),
      );
      const readiness = outcome(observation.ready);
      try {
        expect((await observation.running).error).toBeUndefined();
      } finally {
        await observation.cleanup();
        await readiness;
      }
    });
  });
});
