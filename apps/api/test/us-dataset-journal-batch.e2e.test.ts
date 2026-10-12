import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { UsDevelopmentOwnerStore } from "../src/deployment/us-development-owner";
import { assertUsDemoTarget } from "../src/modules/traceability/demo/us-demo-target";
import type { UsDatasetStage } from "../src/modules/traceability/demo/us-dataset-contract";
import { specialFixture, specialStores } from "./support/us-dataset-special-fixture";
import { countActualQueries } from "./support/us-dataset-query-counter";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("native locked owner and journal batches", () => {
  const harness = specialFixture(base);
  const denied = () => {
    throw new Error("us_dataset_target_invalid");
  };
  async function installed() {
    const { f, context } = harness;
    const { journal } = specialStores(f.db);
    const header = await journal.initialize(context);
    const input = { synthetic: true };
    const intent = {
      unitKey: "chain_0000",
      stage: "receiving" as const,
      operationKey: randomUUID(),
      input,
      inputDigest: canonicalExportDigest(input),
    };
    const captured = await journal.captureIntent(context, header.id, intent);
    return { f, context, journal, header, captured };
  }
  it(
    "bounds actual owner target proof including BEGIN and COMMIT",
    harness.phase(async () => {
      const { f, context } = harness;
      const before = await f.snapshot();
      const measured = await countActualQueries(f.pool, () =>
        f.db.transaction((tx) => assertUsDemoTarget(tx, f.db, context, denied)),
      );
      console.info(
        `Owner query budget: count=${measured.count} durationMs=${measured.durationMs.toFixed(3)}`,
      );
      expect(await f.snapshot()).toEqual(before);
      expect(measured.count).toBeLessThanOrEqual(11);
    }),
  );
  it(
    "measures three ordinary dependency reads at identical boundaries",
    harness.phase(async () => {
      const { f, context, journal, header } = await installed();
      const before = await f.snapshot();
      const measured = await countActualQueries(f.pool, () =>
        f.db.transaction(async (tx) => [
          await journal.readStageInTransaction(tx, context, header.id, "references", "references"),
          await journal.readStageInTransaction(tx, context, header.id, "chain_0000", "receiving"),
          await journal.readStageInTransaction(
            tx,
            context,
            header.id,
            "chain_0000",
            "transformation",
          ),
        ]),
      );
      console.info(
        `Ordinary dependency queries: count=${measured.count} durationMs=${measured.durationMs.toFixed(3)}`,
      );
      expect(measured.value.map((row) => row?.revision ?? null)).toEqual([null, 1, null]);
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  it.each([
    ["organization name", "UPDATE organization SET name='Changed'"],
    ["organization slug", "UPDATE organization SET slug='changed'"],
    ["metadata", "UPDATE organization SET metadata='{}'"],
    ["owner name", "UPDATE \"user\" SET name='Changed'"],
    ["owner email", "UPDATE \"user\" SET email='changed@example.test'"],
    ["membership role", "UPDATE member SET role='member'"],
    ["missing membership", "DELETE FROM member"],
    ["missing credential", "DELETE FROM account"],
    ["credential account", "UPDATE account SET account_id='changed'"],
    ["credential password", "UPDATE account SET password=NULL"],
    [
      "duplicate credential",
      "INSERT INTO account SELECT gen_random_uuid(), account_id, provider_id, user_id, access_token, refresh_token, id_token, access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at FROM account",
    ],
    [
      "audit actor",
      "UPDATE tenant_audit_events SET actor_user_id=NULL WHERE action='us.development.owner.provisioned'",
    ],
    [
      "audit outcome",
      "UPDATE tenant_audit_events SET outcome='failure' WHERE action='us.development.owner.provisioned'",
    ],
    [
      "audit target type",
      "UPDATE tenant_audit_events SET target_type='other' WHERE action='us.development.owner.provisioned'",
    ],
    [
      "audit target id",
      "UPDATE tenant_audit_events SET target_id='other' WHERE action='us.development.owner.provisioned'",
    ],
    [
      "audit before",
      "UPDATE tenant_audit_events SET before='{}' WHERE action='us.development.owner.provisioned'",
    ],
    [
      "audit after",
      "UPDATE tenant_audit_events SET after='{}' WHERE action='us.development.owner.provisioned'",
    ],
    [
      "missing audit",
      "DELETE FROM tenant_audit_events WHERE action='us.development.owner.provisioned'",
    ],
    ["profile", "DELETE FROM traceability_profiles"],
    ["timezone", "UPDATE org_profiles SET time_zone='America/Chicago'"],
  ])(
    "rejects changed native %s without repair",
    harness.phase(async (_kind, query) => {
      const { f, context } = harness;
      await f.pool.query(query);
      const before = await f.snapshot();
      await expect(
        f.db.transaction((tx) => assertUsDemoTarget(tx, f.db, context, denied)),
      ).rejects.toThrow("us_dataset_target_invalid");
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  it(
    "rejects a different actor and preserves unlocked verification shape",
    harness.phase(async () => {
      const { f, context } = harness;
      const owner = new UsDevelopmentOwnerStore(f.db);
      const date = new Date("2026-10-12T00:00:00.000Z");
      const before = await f.snapshot();
      expect(await owner.verifyTrustedSeed(context.tenantId, date)).toEqual({
        seedId: context.tenantId,
        verifiedBy: "us-development-owner-v1",
        verifiedAt: date.toISOString(),
      });
      await expect(
        f.db.transaction((tx) =>
          assertUsDemoTarget(tx, f.db, { ...context, actorUserId: randomUUID() }, denied),
        ),
      ).rejects.toThrow("us_dataset_target_invalid");
      expect(await owner.verifyTrustedSeed(context.tenantId, new Date(NaN))).toBeNull();
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  it(
    "holds real identity and provenance share locks until transaction exit",
    harness.phase(async () => {
      const { f, context } = harness;
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
          await assertUsDemoTarget(tx, f.db, context, denied);
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
            throw error ?? new Error("Lock ended early");
          }),
        ]);
        for (const table of [
          "organization",
          '"user"',
          "member",
          "account",
          "tenant_audit_events",
        ]) {
          const client = await f.pool.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL lock_timeout='100ms'");
            await expect(client.query(`SELECT * FROM ${table} FOR UPDATE`)).rejects.toMatchObject({
              code: "55P03",
            });
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
  );
  it(
    "bounds three live dependencies and preserves ordinary parity, order, duplicates and missing rows",
    harness.phase(async () => {
      const { f, context, journal, header, captured } = await installed();
      const requests = [
        { unitKey: "references", stage: "references" },
        { unitKey: "chain_0000", stage: "receiving" },
        { unitKey: "chain_0000", stage: "transformation" },
      ] as const;
      const before = await f.snapshot();
      const measured = await countActualQueries(f.pool, () =>
        f.db.transaction((tx) => journal.readStagesInTransaction(tx, context, header.id, requests)),
      );
      console.info(
        `Batch dependency queries: count=${measured.count} durationMs=${measured.durationMs.toFixed(3)}`,
      );
      expect(measured.value).toEqual([null, captured, null]);
      expect(measured.count).toBeLessThanOrEqual(16);
      await f.db.transaction(async (tx) => {
        const reordered = [requests[1], requests[2], requests[0], requests[1]];
        const expected = [];
        for (const request of reordered)
          expected.push(
            await journal.readStageInTransaction(
              tx,
              context,
              header.id,
              request.unitKey,
              request.stage,
            ),
          );
        expect(await journal.readStagesInTransaction(tx, context, header.id, reordered)).toEqual(
          expected,
        );
        expect(await journal.readStagesInTransaction(tx, context, header.id, [])).toEqual([]);
        expect(
          await journal.readStagesInTransaction(
            tx,
            context,
            header.id,
            Array.from({ length: 256 }, () => requests[1]),
          ),
        ).toEqual(Array.from({ length: 256 }, () => captured));
        expect(reordered).toEqual([requests[1], requests[2], requests[0], requests[1]]);
      });
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  it(
    "rejects invalid pairs, oversize, foreign headers and target even for empty input",
    harness.phase(async () => {
      const { f, context, journal, header } = await installed();
      const before = await f.snapshot();
      for (const requests of [
        [{ unitKey: "unknown", stage: "receiving" }],
        [{ unitKey: "references", stage: "receiving" }],
        Array.from({ length: 257 }, () => ({ unitKey: "references", stage: "references" })),
      ]) {
        await expect(
          f.db.transaction((tx) =>
            journal.readStagesInTransaction(
              tx,
              context,
              header.id,
              requests as { unitKey: string; stage: UsDatasetStage }[],
            ),
          ),
        ).rejects.toThrow("us_dataset_unit_invalid");
      }
      await expect(
        f.db.transaction((tx) => journal.readStagesInTransaction(tx, context, randomUUID(), [])),
      ).rejects.toThrow("us_dataset_conflict");
      await expect(
        f.db.transaction((tx) =>
          journal.readStagesInTransaction(
            tx,
            { ...context, actorUserId: randomUUID() },
            header.id,
            [],
          ),
        ),
      ).rejects.toThrow("us_dataset_target_invalid");
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  it.each(["role", "provenance", "header"])(
    "reloads %s after own write on every empty invocation",
    harness.phase(async (kind) => {
      const { f, context, journal, header } = await installed();
      const before = await f.snapshot();
      await expect(
        f.db.transaction(async (tx) => {
          expect(await journal.readStagesInTransaction(tx, context, header.id, [])).toEqual([]);
          if (kind === "role") await tx.update(schema.member).set({ role: "member" });
          else if (kind === "provenance")
            await tx.update(schema.organization).set({ metadata: "{}" });
          else
            await tx
              .update(schema.traceabilityDemoDatasets)
              .set({ definitionDigest: "0".repeat(64) });
          await journal.readStagesInTransaction(tx, context, header.id, []);
        }),
      ).rejects.toThrow(
        kind === "header" ? "us_dataset_journal_invalid" : "us_dataset_target_invalid",
      );
      expect(await f.snapshot()).toEqual(before);
    }),
  );
  it(
    "observes own receipt writes and rejects corrupt rows without repair",
    harness.phase(async () => {
      const { f, context, journal, header, captured } = await installed();
      const requests = [{ unitKey: "chain_0000", stage: "receiving" }] as const;
      const before = await f.snapshot();
      const result = { synthetic: true };
      const receipt = {
        recordIds: [randomUUID()],
        result,
        resultDigest: canonicalExportDigest(result),
      };
      await expect(
        f.db.transaction(async (tx) => {
          expect(await journal.readStagesInTransaction(tx, context, header.id, requests)).toEqual([
            captured,
          ]);
          await tx
            .update(schema.traceabilityDemoDatasetStages)
            .set({ revision: 2, receipt })
            .where(
              eq(schema.traceabilityDemoDatasetStages.operationKey, captured.intent.operationKey),
            );
          expect(await journal.readStagesInTransaction(tx, context, header.id, requests)).toEqual([
            { ...captured, revision: 2, receipt },
          ]);
          await tx
            .update(schema.traceabilityDemoDatasetStages)
            .set({ inputDigest: "0".repeat(64) });
          await journal.readStagesInTransaction(tx, context, header.id, requests);
        }),
      ).rejects.toThrow("us_dataset_journal_invalid");
      expect(await f.snapshot()).toEqual(before);
    }),
  );
});
