import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingCsvStore } from "../src/modules/traceability/receiving/us-receiving-csv-store";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { csvHeader, csvRequest, csvRow } from "./support/us-receiving-csv-fixture";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("atomic receiving CSV apply", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  let store: UsReceivingCsvStore;
  let receiving: UsReceivingStore;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    f = await createUsProfileTestDatabase(url);
    store = new UsReceivingCsvStore(f.db);
    receiving = new UsReceivingStore(f.db);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    c = await seedCompleteReceiving(f.db);
  });
  const input = () =>
    csvRequest(
      [
        csvRow(c.product, { source_kind: "location", source_location_id: c.location }),
        csvRow(c.product, {
          lot_link_mode: "link_existing",
          lot_id: c.lot,
          tlc: "00001",
          source_kind: "reference",
          source_reference_url: "https://supplier.example.test/TLC",
          source_resolved_location_id: c.location,
          quantity: "0.250",
          unit_of_measure: "kg",
        }),
      ],
      {
        ...csvHeader,
        dateReceived: "2026-09-07",
        locationId: c.location,
        previousSourceLocationId: c.location,
        documentIds: [c.document],
        notes: "  imported  ",
      },
    );
  const preview = (value: unknown = input()) =>
    store.createPreview(c.tenant, c.actor, value, "preview");
  type Preview = Awaited<ReturnType<typeof preview>>;
  const apply = (p: Preview, key: string = randomUUID(), requestId = "csv-apply") =>
    store.applyPreview(
      c.tenant,
      c.actor,
      p.id,
      { operationKey: key, expectedPreviewDigest: p.previewDigest },
      requestId,
    );
  const state = async () =>
    Promise.all(
      [
        "traceability_events",
        "receiving_event_roots",
        "receiving_event_items",
        "receiving_event_documents",
        "receiving_counters",
        "receiving_operations",
        "receiving_csv_applications",
        "receiving_csv_previews",
        "traceability_lots",
      ]
        .map(
          async (table) =>
            (
              await f.pool.query(
                `SELECT to_jsonb(t)::text AS exact FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`,
                [c.tenant],
              )
            ).rows,
        )
        .concat([
          f.pool
            .query(
              "SELECT to_jsonb(t)::text AS exact FROM tenant_audit_events t WHERE organization_id=$1 ORDER BY to_jsonb(t)::text",
              [c.tenant],
            )
            .then((result) => result.rows),
        ]),
    );
  async function rejectWithoutWrites(
    pending: () => Promise<unknown>,
    status: number,
    code?: string,
  ) {
    const before = await state();
    await expect(pending()).rejects.toMatchObject({
      status,
      ...(code ? { response: { code } } : {}),
    });
    expect(await state()).toEqual(before);
  }
  const expire = (id: string) =>
    f.pool.query(
      "UPDATE receiving_csv_previews SET created_at='2020-01-01Z',expires_at='2020-01-02Z' WHERE id=$1",
      [id],
    );

  it("creates one original draft with exact children, canonical receipt, binding and two audits", async () => {
    const p = await preview(),
      key = randomUUID();
    const lotsBefore = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(eq(schema.traceabilityLots.tenantId, c.tenant));
    const result = await apply(p, key);
    expect(result).toMatchObject({
      receiptVersion: 1,
      command: "receiving.csv.apply",
      operationKey: key,
      inputDigest: p.previewDigest,
      importId: p.id,
      eventId: result.record.id,
    });
    expect(result.record).toMatchObject({
      status: "draft",
      revision: 1,
      draftVersion: 1,
      createdBy: c.actor,
      updatedBy: c.actor,
      timeZone: "America/Chicago",
      lifecycle: {
        rootId: result.eventId,
        lifecycleVersion: 1,
        currentEventId: null,
        pendingDraftId: result.eventId,
      },
    });
    expect(result.record.content).toEqual({ kind: "draft", draft: p.proposedDraft });
    expect(await receiving.getLiveRecord(c.tenant, c.actor, result.eventId)).toEqual(result.record);
    expect(
      await f.db
        .select()
        .from(schema.receivingOperations)
        .where(eq(schema.receivingOperations.tenantId, c.tenant)),
    ).toEqual([
      {
        tenantId: c.tenant,
        command: "receiving.csv.apply",
        operationKey: key,
        inputDigest: p.previewDigest,
        eventId: result.eventId,
        result,
        createdAt: expect.any(Date),
      },
    ]);
    expect(
      await f.db
        .select()
        .from(schema.receivingCsvApplications)
        .where(eq(schema.receivingCsvApplications.tenantId, c.tenant)),
    ).toEqual([
      {
        tenantId: c.tenant,
        previewId: p.id,
        command: "receiving.csv.apply",
        operationKey: key,
        inputDigest: p.previewDigest,
      },
    ]);
    const audit = (
      await f.pool.query(
        "SELECT organization_id,actor_user_id,action,outcome,target_type,target_id,before,after,request_id FROM tenant_audit_events WHERE organization_id=$1 AND request_id='csv-apply' ORDER BY action",
        [c.tenant],
      )
    ).rows;
    expect(audit).toEqual([
      {
        organization_id: c.tenant,
        actor_user_id: c.actor,
        action: "traceability.receiving.csv_applied",
        outcome: "success",
        target_type: "receiving_csv_preview",
        target_id: p.id,
        before: null,
        after: {
          importId: p.id,
          eventId: result.eventId,
          fileSha256: p.fileSha256,
          templateVersion: "markiro-receiving-v1",
          rowCount: 2,
          inputDigest: p.previewDigest,
        },
        request_id: "csv-apply",
      },
      {
        organization_id: c.tenant,
        actor_user_id: c.actor,
        action: "traceability.receiving.draft_created",
        outcome: "success",
        target_type: "traceability_event",
        target_id: result.eventId,
        before: null,
        after: result.record,
        request_id: "csv-apply",
      },
    ]);
    expect(
      await f.db
        .select()
        .from(schema.traceabilityLots)
        .where(eq(schema.traceabilityLots.tenantId, c.tenant)),
    ).toEqual(lotsBefore);
  });
  it("preserves draft-only missing fields without inventing readiness", async () => {
    const p = await preview(
      csvRequest([csvRow(c.product, { quantity: "", unit_of_measure: "", tlc: "" })]),
    );
    expect((await apply(p)).record.content).toEqual({ kind: "draft", draft: p.proposedDraft });
  });
  it.each(["admin", "manager", "traceability_receiving", "traceability_qa"])(
    "permits current %s capability without requiring QA finalization",
    async (role) => {
      const p = await preview();
      await f.db.update(schema.member).set({ role }).where(eq(schema.member.id, c.member));
      expect((await apply(p)).record.status).toBe("draft");
    },
  );
  it("records the applying actor, not the preview creator", async () => {
    const p = await preview(),
      actor = randomUUID();
    await f.db
      .insert(schema.user)
      .values({ id: actor, name: "Synthetic second writer", email: `${actor}@example.test` });
    await f.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: c.tenant,
      userId: actor,
      role: "traceability_receiving",
      createdAt: new Date(),
    });
    const result = await store.applyPreview(
      c.tenant,
      actor,
      p.id,
      { operationKey: randomUUID(), expectedPreviewDigest: p.previewDigest },
      "second-writer",
    );
    expect(result.record).toMatchObject({ createdBy: actor, updatedBy: actor });
    expect(
      (
        await f.pool.query(
          "SELECT actor_user_id FROM tenant_audit_events WHERE organization_id=$1 AND request_id='second-writer' ORDER BY action",
          [c.tenant],
        )
      ).rows,
    ).toEqual([{ actor_user_id: actor }, { actor_user_id: actor }]);
    expect((await store.getPreview(c.tenant, c.actor, p.id)).createdBy).toBe(c.actor);
  });
  it("replays the immutable receipt after edit, finalization, expiry and archived references", async () => {
    const p = await preview(),
      key = randomUUID(),
      result = await apply(p, key);
    if (!p.proposedDraft) throw new Error("Missing fixture draft");
    await receiving.saveDraft(
      c.tenant,
      c.actor,
      result.eventId,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        // Correct the imported draft's linked-lot source before QA finalization.
        draft: { ...c.draft, notes: "Edited later" },
      },
      "edit",
    );
    const readiness = await receiving.checkReadiness(c.tenant, c.actor, result.eventId, {
      expectedDraftVersion: 2,
    });
    expect(readiness.issues).toEqual([]);
    await receiving.finalize(
      c.tenant,
      c.actor,
      result.eventId,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 2,
        expectedInputDigest: readiness.inputDigest,
      },
      "finalize",
    );
    await expire(p.id);
    await f.db
      .update(schema.products)
      .set({ archived: true })
      .where(eq(schema.products.id, c.product));
    const before = await state();
    expect(await apply(p, key, "retry")).toEqual(result);
    expect(await state()).toEqual(before);
    expect((await receiving.getLiveRecord(c.tenant, c.actor, result.eventId)).status).toBe(
      "finalized",
    );
  });
  it("returns the original result for another key on the applied preview", async () => {
    const p = await preview(),
      result = await apply(p);
    await expire(p.id);
    const before = await state();
    expect(await apply(p)).toEqual(result);
    expect(await state()).toEqual(before);
  });
  it("binds an equal-content retry preview to the original result without another draft or audit", async () => {
    const a = await preview(),
      b = await preview({ ...input(), fileName: "another.csv" }),
      key = randomUUID();
    const result = await apply(a, key);
    await expire(b.id);
    expect(await apply(b, key)).toEqual(result);
    const before = await state();
    expect(await apply(b)).toEqual(result);
    expect(await state()).toEqual(before);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS count FROM receiving_csv_applications WHERE tenant_id=$1",
          [c.tenant],
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS count FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.csv_applied'",
          [c.tenant],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  it("allows equal bytes as a separate delivery with a fresh preview and operation", async () => {
    const a = await preview(),
      b = await preview();
    const first = await apply(a),
      second = await apply(b);
    expect(first.eventId).not.toBe(second.eventId);
    expect(first.record.eventNumber).not.toBe(second.record.eventNumber);
  });
  it("rejects changed content with the same operation key", async () => {
    const a = await preview(),
      b = await preview({ ...input(), header: { ...input().header, notes: "Different delivery" } }),
      key = randomUUID();
    await apply(a, key);
    await rejectWithoutWrites(() => apply(b, key), 409, "receiving_operation_conflict");
  });
  it("rejects contradictory key and already-bound preview results", async () => {
    const a = await preview(),
      b = await preview(),
      key = randomUUID();
    await apply(a, key);
    await apply(b);
    await rejectWithoutWrites(() => apply(b, key), 409, "receiving_operation_conflict");
  });
  it("rejects an expired first application", async () => {
    const p = await preview();
    await expire(p.id);
    await rejectWithoutWrites(() => apply(p), 409, "receiving_csv_preview_expired");
  });
  it("rejects an invalid preview without partial rows", async () => {
    const p = await preview(csvRequest([csvRow(c.product), "broken"]));
    await rejectWithoutWrites(
      () =>
        store.applyPreview(
          c.tenant,
          c.actor,
          p.id,
          { operationKey: randomUUID(), expectedPreviewDigest: "a".repeat(64) },
          "invalid",
        ),
      409,
      "receiving_csv_preview_not_applicable",
    );
  });
  it.each([false, true])(
    "rejects a mismatched confirmation digest, applied=%s",
    async (applied) => {
      const p = await preview(),
        key = randomUUID();
      if (applied) await apply(p, key);
      await rejectWithoutWrites(
        () =>
          store.applyPreview(
            c.tenant,
            c.actor,
            p.id,
            { operationKey: key, expectedPreviewDigest: "a".repeat(64) },
            "wrong-digest",
          ),
        409,
        "receiving_csv_preview_conflict",
      );
    },
  );
  it("never silently retargets a GTIN", async () => {
    await f.db
      .update(schema.products)
      .set({ gtin14: "00000096385074" })
      .where(eq(schema.products.id, c.product));
    const p = await preview(csvRequest([csvRow("", { product_gtin: "96385074" })]));
    await f.db
      .update(schema.products)
      .set({ archived: true })
      .where(eq(schema.products.id, c.product));
    await f.db.insert(schema.products).values({
      tenantId: c.tenant,
      id: randomUUID(),
      name: "Replacement",
      gtin14: "00000096385074",
    });
    await rejectWithoutWrites(() => apply(p), 409, "receiving_csv_preview_stale");
  });
  it.each(["product", "lot", "location", "party", "document"])(
    "rejects an archived %s",
    async (target) => {
      const p = await preview();
      const table = {
        product: "products",
        lot: "traceability_lots",
        location: "traceability_locations",
        party: "traceability_parties",
        document: "reference_documents",
      }[target];
      const id = {
        product: c.product,
        lot: c.lot,
        location: c.location,
        party: c.party,
        document: c.document,
      }[target];
      const assignment =
        target === "lot"
          ? "status='archived'"
          : target === "document"
            ? "archived_at=now()"
            : "archived=true";
      await f.pool.query(`UPDATE ${table} SET ${assignment} WHERE id=$1`, [id]);
      await rejectWithoutWrites(() => apply(p), 409, "receiving_csv_preview_stale");
    },
  );
  it.each(["traceability_auditor", "traceability_shipping", "traceability_production", "member"])(
    "reauthorizes %s before parsing and replay",
    async (role) => {
      const p = await preview(),
        key = randomUUID();
      await apply(p, key);
      await f.db.update(schema.member).set({ role }).where(eq(schema.member.id, c.member));
      await rejectWithoutWrites(() => apply(p, key), 403, "insufficient_permission");
      await rejectWithoutWrites(
        () => store.applyPreview(c.tenant, c.actor, "bad", {}, "invalid"),
        403,
        "insufficient_permission",
      );
    },
  );
  it("rejects missing US profile even on replay", async () => {
    const p = await preview(),
      key = randomUUID();
    await apply(p, key);
    await f.db
      .delete(schema.traceabilityProfiles)
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    await rejectWithoutWrites(() => apply(p, key), 403, "traceability_profile_required");
  });
  it("does not expose another tenant's preview", async () => {
    const p = await preview(),
      other = await seedCompleteReceiving(f.db);
    await rejectWithoutWrites(
      () =>
        store.applyPreview(
          other.tenant,
          other.actor,
          p.id,
          { operationKey: randomUUID(), expectedPreviewDigest: p.previewDigest },
          "foreign",
        ),
      404,
      "receiving_csv_preview_not_found",
    );
  });
  it("rejects unknown preview identity", async () => {
    await rejectWithoutWrites(
      () =>
        store.applyPreview(
          c.tenant,
          c.actor,
          randomUUID(),
          { operationKey: randomUUID(), expectedPreviewDigest: "a".repeat(64) },
          "missing",
        ),
      404,
      "receiving_csv_preview_not_found",
    );
  });
  it.each([
    {},
    { operationKey: "invalid", expectedPreviewDigest: "a".repeat(64) },
    { operationKey: randomUUID(), expectedPreviewDigest: "a".repeat(64), tenantId: "foreign" },
  ])("rejects malformed command %j", async (body) => {
    const p = await preview();
    await rejectWithoutWrites(
      () => store.applyPreview(c.tenant, c.actor, p.id, body, "invalid"),
      400,
    );
  });
  it.each(["draft-audit", "import-audit", "receipt", "binding"])(
    "rolls back the complete operation on %s failure",
    async (failure) => {
      const p = await preview(),
        before = await state();
      const table = failure.endsWith("audit")
        ? "tenant_audit_events"
        : failure === "receipt"
          ? "receiving_operations"
          : "receiving_csv_applications";
      const condition =
        failure === "draft-audit"
          ? "NEW.action='traceability.receiving.draft_created'"
          : failure === "import-audit"
            ? "NEW.action='traceability.receiving.csv_applied'"
            : "true";
      await f.pool.query(
        `CREATE FUNCTION synthetic_csv_apply_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'synthetic CSV failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_csv_apply_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_csv_apply_fail()`,
      );
      try {
        await expect(apply(p)).rejects.toBeDefined();
      } finally {
        await f.pool.query(
          `DROP TRIGGER synthetic_csv_apply_fail ON ${table}; DROP FUNCTION synthetic_csv_apply_fail()`,
        );
      }
      expect(await state()).toEqual(before);
    },
  );
  it.each(["eventId", "operationKey", "importId", "inputDigest", "command", "extra", "record"])(
    "fails closed on corrupt receipt %s",
    async (field) => {
      const p = await preview(),
        key = randomUUID(),
        result = await apply(p, key);
      const corrupted = {
        ...result,
        [field]:
          field === "record"
            ? {}
            : field === "inputDigest"
              ? "b".repeat(64)
              : field === "command"
                ? "receiving.create"
                : randomUUID(),
      };
      await f.db
        .update(schema.receivingOperations)
        .set({ result: corrupted })
        .where(eq(schema.receivingOperations.operationKey, key));
      await rejectWithoutWrites(() => apply(p, key), 503, "receiving_csv_apply_unavailable");
    },
  );
  it("rejects a valid-shaped historical record with content different from its preview", async () => {
    const p = await preview(),
      key = randomUUID(),
      result = await apply(p, key);
    if (result.record.content.kind !== "draft") throw new Error("Missing initial draft");
    const corrupted = {
      ...result,
      record: {
        ...result.record,
        content: {
          kind: "draft",
          draft: { ...result.record.content.draft, notes: "Different content" },
        },
      },
    };
    await f.db
      .update(schema.receivingOperations)
      .set({ result: corrupted })
      .where(eq(schema.receivingOperations.operationKey, key));
    await rejectWithoutWrites(() => apply(p, key), 503, "receiving_csv_apply_unavailable");
  });
  it("does not repair a missing originating application binding on replay", async () => {
    const p = await preview(),
      key = randomUUID();
    await apply(p, key);
    await f.db
      .delete(schema.receivingCsvApplications)
      .where(eq(schema.receivingCsvApplications.previewId, p.id));
    await rejectWithoutWrites(() => apply(p, key), 503, "receiving_csv_apply_unavailable");
  });
  it.each([true, false])(
    "bounds exact application-key collision retries, matching=%s",
    async (matching) => {
      const p = await preview(),
        before = await state();
      const constraint = matching
        ? "receiving_csv_applications_tenant_id_preview_id_pk"
        : "synthetic_other_unique";
      await f.pool.query(
        `CREATE SEQUENCE synthetic_csv_attempt; CREATE FUNCTION synthetic_csv_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('synthetic_csv_attempt'); RAISE EXCEPTION 'synthetic collision' USING ERRCODE='23505', TABLE='receiving_csv_applications', CONSTRAINT='${constraint}'; END $$; CREATE TRIGGER synthetic_csv_retry BEFORE INSERT ON receiving_csv_applications FOR EACH ROW EXECUTE FUNCTION synthetic_csv_retry()`,
      );
      try {
        if (matching) await expect(apply(p)).rejects.toMatchObject({ status: 503 });
        else await expect(apply(p)).rejects.toMatchObject({ cause: { code: "23505", constraint } });
        expect(
          (await f.pool.query("SELECT last_value::int AS attempts FROM synthetic_csv_attempt"))
            .rows,
        ).toEqual([{ attempts: matching ? 3 : 1 }]);
      } finally {
        await f.pool.query(
          "DROP TRIGGER synthetic_csv_retry ON receiving_csv_applications; DROP FUNCTION synthetic_csv_retry(); DROP SEQUENCE synthetic_csv_attempt",
        );
      }
      expect(await state()).toEqual(before);
    },
  );
});
