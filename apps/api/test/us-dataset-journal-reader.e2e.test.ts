import { randomUUID } from "node:crypto";
import { schema, type createDb } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type {
  UsDatasetContext,
  UsDatasetStage,
} from "../src/modules/traceability/demo/us-dataset-contract";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { specialFixture, specialStores } from "./support/us-dataset-special-fixture";
import { countActualQueries } from "./support/us-dataset-query-counter";
import { datasetDefinition } from "./support/us-dataset-journal-fixture";
import { barrier, outcome } from "./support/us-transformation-lock-fixture";

type DriverPool = ReturnType<typeof createDb>["pool"];
type DriverClient = NonNullable<Parameters<Parameters<DriverPool["connect"]>[0]>[1]>;
async function forwardQueries<T>(
  pool: DriverPool,
  intercept: (client: DriverClient, statement: string, forward: () => unknown) => unknown,
  run: () => Promise<T>,
): Promise<T> {
  const restores = new Map<DriverClient, () => void>();
  function acquire(client: DriverClient) {
    if (restores.has(client)) return;
    const original = client.query;
    client.query = new Proxy(original, {
      apply(target, receiver, args: unknown[]) {
        const raw = args[0];
        const statement =
          typeof raw === "string"
            ? raw
            : raw && typeof raw === "object" && "text" in raw && typeof raw.text === "string"
              ? raw.text
              : "";
        return intercept(client, statement, () => Reflect.apply(target, receiver, args));
      },
    });
    restores.set(client, () => {
      client.query = original;
    });
  }
  pool.on("acquire", acquire);
  try {
    return await run();
  } finally {
    pool.off("acquire", acquire);
    for (const restore of restores.values()) restore();
  }
}

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("standalone dataset journal reader", () => {
  const harness = specialFixture(base);
  async function installed() {
    const { f, context } = harness;
    const { journal } = specialStores(f.db);
    const header = await journal.initialize(context);
    const input = { synthetic: true };
    const captured = await journal.captureIntent(context, header.id, {
      unitKey: "chain_0000",
      stage: "receiving",
      operationKey: randomUUID(),
      input,
      inputDigest: canonicalExportDigest(input),
    });
    return { f, context, journal, header, captured };
  }
  async function denied(action: () => Promise<unknown>, code: string) {
    const before = await harness.f.snapshot();
    await expect(action()).rejects.toThrow(code);
    expect(await harness.f.snapshot()).toEqual(before);
  }

  it(
    "reads an actual pending row in requested order without writing",
    harness.phase(async () => {
      const { f, context, journal, header, captured } = await installed();
      const requests = [
        { unitKey: "chain_0000", stage: "transformation" as const },
        { unitKey: "chain_0000", stage: "receiving" as const },
        { unitKey: "chain_0000", stage: "receiving" as const },
      ];
      const before = await f.snapshot();
      expect(await journal.readStages(context, header.id, requests)).toEqual([
        null,
        captured,
        captured,
      ]);
      expect(requests).toEqual([
        { unitKey: "chain_0000", stage: "transformation" },
        { unitKey: "chain_0000", stage: "receiving" },
        { unitKey: "chain_0000", stage: "receiving" },
      ]);
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it(
    "matches independent scalar reads for pending, completed, absent and duplicate addresses",
    harness.phase(async () => {
      const { f, context, journal, header, captured } = await installed();
      const result = { synthetic: "completed" };
      const receipt = {
        recordIds: [randomUUID()],
        result,
        resultDigest: canonicalExportDigest(result),
      };
      const completed = await journal.recordReceipt(
        context,
        header.id,
        1,
        "chain_0000",
        "receiving",
        captured.intent.operationKey,
        receipt,
      );
      const requests = [
        { unitKey: "chain_0000", stage: "transformation" as const },
        { unitKey: "chain_0000", stage: "receiving" as const },
        { unitKey: "references", stage: "references" as const },
        { unitKey: "chain_0000", stage: "receiving" as const },
      ];
      const original = structuredClone(requests);
      const before = await f.snapshot();
      const scalar = [];
      for (const address of requests)
        scalar.push(await journal.readStage(context, header.id, address.unitKey, address.stage));
      expect(await journal.readStages(context, header.id, requests)).toEqual(scalar);
      expect(scalar).toEqual([null, completed, null, completed]);
      expect(requests).toEqual(original);
      expect(await journal.readStages(context, header.id, [])).toEqual([]);
      expect(
        await journal.readStages(
          context,
          header.id,
          Array.from({ length: 256 }, () => requests[1]!),
        ),
      ).toEqual(Array.from({ length: 256 }, () => completed));
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it(
    "validates target and header before addresses, including empty and oversized input",
    harness.phase(async () => {
      const { context, journal, header } = await installed();
      const hostile = Object.defineProperty({}, "unitKey", {
        enumerable: true,
        get() {
          throw new Error("hostile_address_inspected");
        },
      }) as { unitKey: string; stage: UsDatasetStage };
      const invalidTarget = { ...context, actorUserId: randomUUID() };
      for (const addresses of [[], [hostile], Array.from({ length: 257 }, () => hostile)])
        await denied(
          () => journal.readStages(invalidTarget, header.id, addresses),
          "us_dataset_target_invalid",
        );
      for (const addresses of [[], [hostile], Array.from({ length: 257 }, () => hostile)])
        await denied(
          () => journal.readStages(context, randomUUID(), addresses),
          "us_dataset_conflict",
        );
      await denied(
        () => journal.readStages(context, header.id, [hostile]),
        "hostile_address_inspected",
      );
    }),
  );

  it(
    "rejects invalid addresses after proof without changing public rows",
    harness.phase(async () => {
      const { context, journal, header } = await installed();
      const bad = [
        [{ unitKey: "unknown", stage: "receiving" }],
        [{ unitKey: "references", stage: "receiving" }],
        [{ unitKey: "chain_0000", stage: "unknown" }],
        [{ unitKey: "chain_0000", stage: "receiving", extra: true }],
        [{ unitKey: 4, stage: "receiving" }],
        Array.from({ length: 257 }, () => ({ unitKey: "references", stage: "references" })),
      ];
      for (const requests of bad)
        await denied(
          () =>
            journal.readStages(
              context,
              header.id,
              requests as { unitKey: string; stage: UsDatasetStage }[],
            ),
          "us_dataset_unit_invalid",
        );
    }),
  );

  it.each([
    "database",
    "actor",
    "tenant",
    "expected user",
    "actual user",
    "membership",
    "capability",
    "owner",
    "provenance",
    "profile",
    "timezone",
  ] as const)(
    "reloads native target proof for %s before hostile addresses",
    harness.phase(async (kind) => {
      const { f, context, journal, header } = await installed();
      let target: UsDatasetContext = context;
      let reader = journal;
      if (kind === "database") target = { ...context, expectedDatabaseName: "markiro_us_dev" };
      if (kind === "actor") target = { ...context, actorUserId: randomUUID() };
      if (kind === "tenant") target = { ...context, tenantId: randomUUID() };
      if (kind === "expected user")
        target = { ...context, expectedDatabaseUser: "postgres" } as unknown as UsDatasetContext;
      if (kind === "actual user")
        reader = new UsDatasetJournalStore(await f.alternateRole(), usSixMonthDefinition);
      if (kind === "membership")
        await f.db.delete(schema.member).where(eq(schema.member.userId, context.actorUserId));
      if (kind === "capability")
        await f.db
          .update(schema.member)
          .set({ role: "member" })
          .where(eq(schema.member.userId, context.actorUserId));
      if (kind === "owner")
        await f.db
          .update(schema.user)
          .set({ name: "Changed synthetic owner" })
          .where(eq(schema.user.id, context.actorUserId));
      if (kind === "provenance") await f.db.update(schema.organization).set({ metadata: "{}" });
      if (kind === "profile") await f.db.delete(schema.traceabilityProfiles);
      if (kind === "timezone")
        await f.db.update(schema.orgProfiles).set({ timeZone: "America/Chicago" });
      const hostile = Object.defineProperty({}, "unitKey", {
        enumerable: true,
        get() {
          throw new Error("hostile_address_inspected");
        },
      }) as { unitKey: string; stage: UsDatasetStage };
      for (const requests of [[], [hostile], Array.from({ length: 257 }, () => hostile)])
        await denied(
          () => reader.readStages(target, header.id, requests),
          "us_dataset_target_invalid",
        );
    }),
  );

  it.each(["digest", "owner", "manifest", "definition"] as const)(
    "rejects corrupt %s header before address parsing",
    harness.phase(async (kind) => {
      const { f, context, journal, header } = await installed();
      let reader = journal;
      if (kind === "digest")
        await f.db
          .update(schema.traceabilityDemoDatasets)
          .set({ definitionDigest: "0".repeat(64) });
      if (kind === "owner")
        await f.db.update(schema.traceabilityDemoDatasets).set({ createdBy: randomUUID() });
      if (kind === "manifest")
        await f.db.update(schema.traceabilityDemoDatasets).set({ manifest: { changed: true } });
      if (kind === "definition") {
        reader = new UsDatasetJournalStore(f.db, datasetDefinition());
      }
      await denied(() => reader.readStages(context, header.id, []), "us_dataset_journal_invalid");
    }),
  );

  it.each(["intent", "receipt", "revision", "unselected"] as const)(
    "checks selected %s corruption only",
    harness.phase(async (kind) => {
      const { f, context, journal, header, captured } = await installed();
      const result = { synthetic: "completed" };
      const receipt = {
        recordIds: [randomUUID()],
        result,
        resultDigest: canonicalExportDigest(result),
      };
      await journal.recordReceipt(
        context,
        header.id,
        1,
        "chain_0000",
        "receiving",
        captured.intent.operationKey,
        receipt,
      );
      if (kind === "unselected") {
        await f.db
          .update(schema.traceabilityDemoDatasetStages)
          .set({ inputDigest: "0".repeat(64) });
        const before = await f.snapshot();
        expect(
          await journal.readStages(context, header.id, [
            { unitKey: "references", stage: "references" },
          ]),
        ).toEqual([null]);
        expect(await f.snapshot()).toEqual(before);
        return;
      }
      if (kind === "intent")
        await f.db
          .update(schema.traceabilityDemoDatasetStages)
          .set({ inputDigest: "0".repeat(64) });
      if (kind === "receipt")
        await f.db
          .update(schema.traceabilityDemoDatasetStages)
          .set({ receipt: { ...receipt, resultDigest: "0".repeat(64) } });
      if (kind === "revision") {
        await f.pool.query(
          "ALTER TABLE traceability_demo_dataset_stages DROP CONSTRAINT traceability_demo_dataset_stages_completion_valid",
        );
        await f.pool.query("UPDATE traceability_demo_dataset_stages SET receipt=NULL");
      }
      try {
        await denied(
          () =>
            journal.readStages(context, header.id, [{ unitKey: "chain_0000", stage: "receiving" }]),
          "us_dataset_journal_invalid",
        );
      } finally {
        if (kind === "revision") {
          await f.pool.query("UPDATE traceability_demo_dataset_stages SET revision=1");
          await f.pool.query(
            "ALTER TABLE traceability_demo_dataset_stages ADD CONSTRAINT traceability_demo_dataset_stages_completion_valid CHECK ((revision = 1 AND receipt IS NULL) OR (revision = 2 AND receipt IS NOT NULL))",
          );
        }
      }
    }),
  );

  it(
    "uses one full transaction and rechecks committed changes on the next call",
    harness.phase(async () => {
      const { f, context, journal, header, captured } = await installed();
      const requests = [{ unitKey: "chain_0000", stage: "receiving" }] as const;
      const before = await f.snapshot();
      const measured = await countActualQueries(f.pool, () =>
        journal.readStages(context, header.id, requests),
      );
      expect(measured.value).toEqual([captured]);
      expect(measured.count).toBe(12);
      console.info("Standalone reader actual forwarding", {
        count: measured.count,
        durationMs: measured.durationMs,
      });
      expect(await f.snapshot()).toEqual(before);
      await f.db
        .update(schema.member)
        .set({ role: "member" })
        .where(eq(schema.member.userId, context.actorUserId));
      await denied(
        () => journal.readStages(context, header.id, requests),
        "us_dataset_target_invalid",
      );
    }),
  );

  it(
    "forwards exactly one BEGIN, COMMIT, actual target and header proof",
    harness.phase(async () => {
      const { f, context, journal, header, captured } = await installed();
      const statements: string[] = [];
      const before = await f.snapshot();
      expect(
        await forwardQueries(
          f.pool,
          (_client, statement, forward) => {
            statements.push(statement);
            return forward();
          },
          () =>
            journal.readStages(context, header.id, [{ unitKey: "chain_0000", stage: "receiving" }]),
        ),
      ).toEqual([captured]);
      expect(statements.filter((statement) => /^begin\b/i.test(statement.trim()))).toHaveLength(1);
      expect(statements.filter((statement) => /^commit\b/i.test(statement.trim()))).toHaveLength(1);
      expect(
        statements.filter((statement) => /current_database\(\)/i.test(statement)),
      ).toHaveLength(1);
      expect(
        statements.filter((statement) => /from\s+"traceability_demo_datasets"/i.test(statement)),
      ).toHaveLength(1);
      expect(statements).toHaveLength(12);
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it.each(["query", "commit"] as const)(
    "retains the genuine %s driver error and no result or partial write",
    harness.phase(async (kind) => {
      const { f, context, journal, header } = await installed();
      if (kind === "commit") {
        await f.pool.query("CREATE TABLE reader_commit_probe (id integer PRIMARY KEY)");
        await f.pool.query(
          "CREATE FUNCTION reader_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned_reader_commit_failure' USING ERRCODE='40001'; END $$",
        );
        await f.pool.query(
          "CREATE CONSTRAINT TRIGGER reader_deferred_failure AFTER INSERT ON reader_commit_probe DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reader_commit_failure()",
        );
      }
      const before = await f.snapshot();
      let injected = false;
      let driverError: unknown;
      const observed = await forwardQueries(
        f.pool,
        (client, statement, forward) => {
          if (
            !injected &&
            kind === "query" &&
            /from\s+"traceability_demo_dataset_stages"/i.test(statement)
          ) {
            injected = true;
            return client
              .query("SELECT reader_missing_column FROM traceability_demo_dataset_stages")
              .catch((error: unknown) => {
                driverError = error;
                throw error;
              });
          }
          if (!injected && kind === "commit" && /^commit\b/i.test(statement.trim())) {
            injected = true;
            return client.query("INSERT INTO reader_commit_probe VALUES (1)").then(async () => {
              try {
                return await forward();
              } catch (error) {
                driverError = error;
                throw error;
              }
            });
          }
          return forward();
        },
        () =>
          outcome(
            journal.readStages(context, header.id, [{ unitKey: "chain_0000", stage: "receiving" }]),
          ),
      );
      expect(injected).toBe(true);
      expect(driverError).toBeDefined();
      expect(observed.value).toBeUndefined();
      expect(
        observed.error === driverError ||
          (observed.error instanceof Error && observed.error.cause === driverError),
      ).toBe(true);
      expect(await f.snapshot()).toEqual(before);
    }),
  );

  it(
    "retains native guard shares until COMMIT completes and releases them afterward",
    harness.phase(async () => {
      const { f, context, journal, header, captured } = await installed();
      const enteredCommit = barrier();
      const releaseCommit = barrier();
      const running = forwardQueries(
        f.pool,
        (_client, statement, forward) => {
          if (/^commit\b/i.test(statement.trim())) {
            enteredCommit.release();
            return releaseCommit.promise.then(forward);
          }
          return forward();
        },
        () =>
          outcome(
            journal.readStages(context, header.id, [{ unitKey: "chain_0000", stage: "receiving" }]),
          ),
      );
      const writer = await f.pool.connect();
      try {
        await Promise.race([
          enteredCommit.promise,
          running.then(() => {
            throw new Error("reader_finished_before_commit_gate");
          }),
        ]);
        await writer.query("BEGIN");
        await writer.query("SET LOCAL lock_timeout='100ms'");
        await expect(
          writer.query("UPDATE member SET role='member' WHERE user_id=$1", [context.actorUserId]),
        ).rejects.toMatchObject({ code: "55P03" });
        await writer.query("ROLLBACK");
      } finally {
        releaseCommit.release();
        await running;
        writer.release();
      }
      const finished = await running;
      expect(finished.error).toBeUndefined();
      expect(finished.value).toEqual([captured]);
      await f.pool.query("UPDATE member SET role='member' WHERE user_id=$1", [context.actorUserId]);
      await denied(() => journal.readStages(context, header.id, []), "us_dataset_target_invalid");
    }),
  );

  it(
    "keeps the established repeatable-read snapshot through a separate committed writer",
    harness.phase(async () => {
      const { f, context, journal, header, captured } = await installed();
      let changed = false;
      const selected = await forwardQueries(
        f.pool,
        (_client, statement, forward) => {
          if (!changed && /from\s+"traceability_demo_dataset_stages"/i.test(statement)) {
            changed = true;
            return f.pool
              .query(
                "UPDATE traceability_demo_dataset_stages SET input_digest=repeat('0',64) WHERE unit_key='chain_0000' AND stage='receiving'",
              )
              .then(forward);
          }
          return forward();
        },
        () =>
          journal.readStages(context, header.id, [{ unitKey: "chain_0000", stage: "receiving" }]),
      );
      expect(changed).toBe(true);
      expect(selected).toEqual([captured]);
      await denied(
        () =>
          journal.readStages(context, header.id, [{ unitKey: "chain_0000", stage: "receiving" }]),
        "us_dataset_journal_invalid",
      );
    }),
  );
});
