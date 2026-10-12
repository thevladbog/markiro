import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UsDemoTransaction } from "../src/modules/traceability/demo/us-demo-atomic-stage-contract";
import {
  parseUsDatasetIntent,
  type UsDatasetContext,
  type UsDatasetStage,
} from "../src/modules/traceability/demo/us-dataset-contract";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("native dataset stage reads on owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let context: UsDatasetContext;
  let journal: UsDatasetJournalStore;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    f = await createUsDatasetJournalFixture(base);
    console.info(`Owned stage-read database: ${f.databaseName}`);
  }, 60_000);
  beforeEach(async () => {
    context = await f.provision();
    journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  async function read(
    datasetId: string,
    target = context,
    unitKey = "references",
    stage: UsDatasetStage = "references",
  ) {
    return f.db.transaction((tx) =>
      journal.readStageInTransaction(tx, target, datasetId, unitKey, stage),
    );
  }
  async function denied(action: () => Promise<unknown>, code: string) {
    const before = await f.snapshot();
    await expect(action()).rejects.toThrow(code);
    expect(await f.snapshot()).toEqual(before);
  }
  it("reads the complete real reference stage in the supplied transaction without writes", async () => {
    const references = await new UsDatasetReferenceSeedStore(f.db).initialize(context);
    const header = await journal.read(context);
    if (!header) throw new Error("Missing dataset header");
    const before = await f.snapshot();
    const value = await read(header.id);
    expect(value).toEqual(await journal.readStage(context, header.id, "references", "references"));
    expect(value?.revision).toBe(2);
    expect(value?.receipt?.result).toEqual(references);
    expect(await f.snapshot()).toEqual(before);
  });
  it("returns null only for an absent declared stage without writes", async () => {
    const header = await journal.initialize(context);
    const before = await f.snapshot();
    expect(await read(header.id)).toBeNull();
    expect(await f.snapshot()).toEqual(before);
  });
  it.each(["missing", "wrong", "malformed"])("rejects %s headers without writes", async (kind) => {
    const header = kind === "missing" ? null : await journal.initialize(context);
    const id = kind === "malformed" ? "not-a-uuid" : randomUUID();
    if (header) expect(id).not.toBe(header.id);
    await denied(() => read(id), "us_dataset_conflict");
  });
  it.each([
    ["unknown", "references"],
    ["references", "receiving"],
    ["chain_0000", "unknown"],
  ])("rejects undeclared %s/%s without writes", async (unitKey, stage) => {
    const header = await journal.initialize(context);
    await denied(
      () => read(header.id, context, unitKey, stage as UsDatasetStage),
      "us_dataset_unit_invalid",
    );
  });
  it.each([
    "database",
    "actor",
    "tenant",
    "user",
    "extra",
    "accessor",
    "symbol",
    "prototype",
    "malformed actor",
    "malformed tenant",
    "revoked",
    "replacement owner",
    "profile",
    "timezone",
  ])("rejects invalid target %s without writes", async (kind) => {
    const header = await journal.initialize(context);
    let target = context;
    if (kind === "database") target = { ...context, expectedDatabaseName: "markiro_us_dev" };
    if (kind === "actor") target = { ...context, actorUserId: randomUUID() };
    if (kind === "tenant") target = { ...context, tenantId: randomUUID() };
    if (kind === "user")
      target = { ...context, expectedDatabaseUser: "postgres" } as unknown as UsDatasetContext;
    if (kind === "extra") target = { ...context, extra: true } as UsDatasetContext;
    if (kind === "accessor") {
      target = { ...context };
      Object.defineProperty(target, "tenantId", {
        get() {
          throw new Error("getter must not run");
        },
      });
    }
    if (kind === "symbol") {
      target = { ...context };
      Object.defineProperty(target, Symbol("hidden"), { value: true });
    }
    if (kind === "prototype") {
      target = { ...context };
      Object.setPrototypeOf(target, null);
    }
    if (kind === "malformed actor") target = { ...context, actorUserId: "not-a-uuid" };
    if (kind === "malformed tenant") target = { ...context, tenantId: "not-a-uuid" };
    if (kind === "revoked")
      await f.db.delete(schema.member).where(eq(schema.member.userId, context.actorUserId));
    if (kind === "replacement owner") {
      const id = randomUUID();
      await f.db
        .update(schema.user)
        .set({ email: "original@synthetic.example.test" })
        .where(eq(schema.user.id, context.actorUserId));
      await f.db.insert(schema.user).values({
        id,
        name: "US Development Owner",
        email: "owner@us-development.example.test",
        emailVerified: true,
      });
      await f.db.insert(schema.member).values({
        id: randomUUID(),
        organizationId: context.tenantId,
        userId: id,
        role: "owner",
        createdAt: new Date(),
      });
      target = { ...context, actorUserId: id };
    }
    if (kind === "profile") await f.db.delete(schema.traceabilityProfiles);
    if (kind === "timezone")
      await f.db.update(schema.orgProfiles).set({ timeZone: "America/Chicago" });
    await denied(() => read(header.id, target), "us_dataset_target_invalid");
    if (kind === "replacement owner")
      await denied(() => read(header.id), "us_dataset_target_invalid");
  });
  it("checks current_user of the supplied transaction even when the journal owns another connection", async () => {
    const header = await journal.initialize(context);
    const alternate = await f.alternateRole();
    await denied(
      () =>
        alternate.transaction((tx) =>
          journal.readStageInTransaction(tx, context, header.id, "references", "references"),
        ),
      "us_dataset_target_invalid",
    );
  });
  it("checks current_database of the supplied transaction without reading the journal pool", async () => {
    if (!base) throw new Error("Missing isolated US database");
    const other = await createUsDatasetJournalFixture(base);
    try {
      const header = await journal.initialize(context);
      const before = await other.snapshot();
      await denied(
        () =>
          other.db.transaction((tx) =>
            journal.readStageInTransaction(tx, context, header.id, "references", "references"),
          ),
        "us_dataset_target_invalid",
      );
      expect(await other.snapshot()).toEqual(before);
    } finally {
      await other.close();
    }
  }, 60_000);
  it("sees its own uncommitted stage change in a journal callback and preserves outer abort", async () => {
    const header = await journal.initialize(context);
    const input = { synthetic: true };
    const intent = parseUsDatasetIntent({
      unitKey: "chain_0000",
      stage: "receiving",
      operationKey: randomUUID(),
      input,
      inputDigest: canonicalExportDigest(input),
    });
    const captured = await journal.captureIntent(context, header.id, intent);
    const result = { synthetic: true };
    const receipt = {
      recordIds: [randomUUID()],
      result,
      resultDigest: canonicalExportDigest(result),
    };
    const inspect = async (tx: UsDemoTransaction, checked: UsDatasetContext) => {
      await tx
        .update(schema.traceabilityDemoDatasetStages)
        .set({ revision: 2, receipt })
        .where(eq(schema.traceabilityDemoDatasetStages.operationKey, intent.operationKey));
      expect(
        await journal.readStageInTransaction(tx, checked, header.id, "chain_0000", "receiving"),
      ).toEqual({ ...captured, revision: 2, receipt });
      expect(await journal.readStage(context, header.id, "chain_0000", "receiving")).toEqual(
        captured,
      );
      throw new Error("synthetic_outer_abort");
    };
    await denied(
      () =>
        journal.runAtomicStage(context, header.id, 1, intent, {
          apply: inspect,
          verify: async () => {
            throw new Error("must not verify after abort");
          },
        }),
      "synthetic_outer_abort",
    );
    expect(await journal.readStage(context, header.id, "chain_0000", "receiving")).toEqual(
      captured,
    );
  });
});
