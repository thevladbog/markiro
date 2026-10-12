import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { buildSscc } from "@markiro/domain";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UsMasterDataTransaction } from "../src/modules/traceability/master-data/us-master-data-support";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import {
  insertCaseTransactionSupport,
  seedCaseTransactionTarget,
  type CaseTransactionFixture,
  type CaseTransactionTarget,
} from "./support/us-case-transaction-fixture";
import {
  driverCode,
  outcome,
  withOwnedWork,
  type OwnCleanup,
} from "./support/us-transformation-lock-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Case native manual transaction seams on owned PostgreSQL", () => {
  let f: CaseTransactionFixture;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  const transaction = <T>(run: (tx: UsMasterDataTransaction) => Promise<T>) =>
    f.db.transaction(run, { isolationLevel: "repeatable read" });
  const codes = (count = 2) =>
    Array.from({ length: count }, (_, i) => buildSscc(9, "9999999", i + 1));
  const native = (target: CaseTransactionTarget, input: unknown, lotId: unknown = target.lotId) =>
    transaction((tx) =>
      target.caseStore.linkInTransaction(
        tx,
        target.tenant,
        target.actor,
        lotId,
        input,
        "case-native-check",
      ),
    );
  async function receiptState(target: CaseTransactionTarget, operationKey: string) {
    const receipts = await f.pool.query<{
      command: string;
      operation_key: string;
      input_digest: string;
      target_id: string;
      bytes: string;
    }>(
      "SELECT command, operation_key, input_digest, target_id, result::text AS bytes FROM trace_lot_box_operations WHERE tenant_id=$1 ORDER BY command, operation_key",
      [target.tenant],
    );
    const audits = await f.pool.query<{ body: Record<string, unknown> }>(
      "SELECT to_jsonb(a) AS body FROM tenant_audit_events a WHERE organization_id=$1 AND action IN ('case.link','case.unlink') ORDER BY id",
      [target.tenant],
    );
    return {
      receipts: receipts.rows,
      audits: audits.rows,
      receipt: receipts.rows.find((row) => row.operation_key === operationKey),
    };
  }
  async function deniedUnchanged(run: () => Promise<unknown>, status: number, code: string) {
    const before = await f.snapshot();
    await expect(run()).rejects.toMatchObject({ status, response: { code } });
    expect(await f.snapshot()).toEqual(before);
  }

  async function failureTrigger(
    own: OwnCleanup,
    target: CaseTransactionTarget,
    operationKey: string,
    boundary: "link" | "dependency" | "audit" | "receipt",
    code: string,
    firstOnly = false,
    constraint = "owned_case_nonretryable",
  ) {
    const name = "case_failure_" + randomUUID().replaceAll("-", "");
    const table = {
      link: "trace_lot_boxes",
      dependency: "traceability_lots",
      audit: "tenant_audit_events",
      receipt: "trace_lot_box_operations",
    }[boundary];
    const condition =
      boundary === "audit"
        ? `NEW.organization_id='${target.tenant}' AND NEW.target_id='${target.lotId}' AND NEW.action='case.link'`
        : boundary === "receipt"
          ? `NEW.tenant_id='${target.tenant}' AND NEW.target_id='${target.lotId}' AND NEW.command='case.link' AND NEW.operation_key='${operationKey}'`
          : boundary === "dependency"
            ? `NEW.tenant_id='${target.tenant}' AND NEW.id='${target.lotId}' AND NEW.current_dependency_version<>OLD.current_dependency_version`
            : `NEW.tenant_id='${target.tenant}' AND NEW.lot_id='${target.lotId}'`;
    await f.pool.query(`CREATE SEQUENCE ${name}_attempts`);
    own("failure-sequence", () =>
      f.pool.query(`DROP SEQUENCE IF EXISTS ${name}_attempts`).then(() => {}),
    );
    await f.pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE attempt bigint; BEGIN IF ${condition} THEN attempt := nextval('${name}_attempts'); IF ${firstOnly ? "attempt=1" : "true"} THEN RAISE EXCEPTION 'owned_case_injected_failure' USING ERRCODE='${code}', CONSTRAINT='${constraint}'; END IF; END IF; RETURN NEW; END $$`,
    );
    own("failure-function", () => f.pool.query(`DROP FUNCTION IF EXISTS ${name}()`).then(() => {}));
    await f.pool.query(
      `CREATE TRIGGER ${name} BEFORE ${boundary === "dependency" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    const remove = () => f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`).then(() => {});
    own("failure-trigger", remove);
    return {
      remove,
      attempts: async () => {
        const row = (
          await f.pool.query<{ n: number }>(
            `SELECT CASE WHEN is_called THEN last_value ELSE 0 END::int AS n FROM ${name}_attempts`,
          )
        ).rows[0];
        return row?.n;
      },
    };
  }

  // Catches an independent public transaction accidentally escaping caller rollback.
  it("rolls back every support and business table when the native caller aborts", async () => {
    const target = await seedCaseTransactionTarget(f);
    const before = await f.snapshot();
    const abort = new Error("owned_case_caller_abort");
    await expect(
      transaction(async (tx) => {
        const ssccs = codes();
        await insertCaseTransactionSupport(tx, target, ssccs, 1);
        await target.caseStore.linkInTransaction(
          tx,
          target.tenant,
          target.actor,
          target.lotId,
          { operationKey: randomUUID(), ssccs },
          "case-native-rollback",
        );
        throw abort;
      }),
    ).rejects.toBe(abort);
    expect(await f.snapshot()).toEqual(before);
  });

  // A swallowed driver error, inner retry or partial commit breaks these checks.
  it.each(["link", "dependency", "audit", "receipt"] as const)(
    "rolls back %s injected SQLSTATE failures with one native attempt and a fresh caller retry",
    async (boundary) => {
      for (const code of ["40001", "40P01", "23514"]) {
        const target = await seedCaseTransactionTarget(f);
        const operationKey = randomUUID();
        const ssccs = codes(1);
        const before = await f.snapshot();
        await withOwnedWork(async (own) => {
          const failure = await failureTrigger(own, target, operationKey, boundary, code);
          let observed: unknown;
          const result = await outcome(
            transaction(async (tx) => {
              await insertCaseTransactionSupport(tx, target, ssccs, 1);
              try {
                return await target.caseStore.linkInTransaction(
                  tx,
                  target.tenant,
                  target.actor,
                  target.lotId,
                  { operationKey, ssccs },
                  "case-native-injected",
                );
              } catch (error) {
                observed = error;
                throw error;
              }
            }),
          );
          expect(driverCode(result.error)).toBe(code);
          expect(result.error).toBe(observed);
          expect(await failure.attempts()).toBe(1);
          expect(await f.snapshot()).toEqual(before);
          console.info("Case injected rollback", { boundary, code, attempts: 1 });
          await failure.remove();
          const retried = await transaction(async (tx) => {
            await insertCaseTransactionSupport(tx, target, ssccs, 1);
            return target.caseStore.linkInTransaction(
              tx,
              target.tenant,
              target.actor,
              target.lotId,
              { operationKey, ssccs },
              "case-native-external-retry",
            );
          });
          expect(retried.created).toHaveLength(1);
          expect((await receiptState(target, operationKey)).receipts).toHaveLength(1);
        });
      }
    },
  );

  it.each([
    ["40001", "owned_case_nonretryable", true],
    ["40P01", "owned_case_nonretryable", true],
    ["23505", "trace_lot_box_operations_tenant_id_command_operation_key_pk", true],
    ["23505", "trace_lot_boxes_one_active_box_uq", true],
    ["23505", "owned_case_nonretryable", false],
  ] as const)(
    "preserves public retry classification for %s / %s",
    async (code, constraint, retryable) => {
      for (const firstOnly of [true, false]) {
        const target = await seedCaseTransactionTarget(f);
        const operationKey = randomUUID(),
          ssccs = codes(1);
        await transaction((tx) => insertCaseTransactionSupport(tx, target, ssccs, 1));
        const before = await f.snapshot();
        await withOwnedWork(async (own) => {
          const failure = await failureTrigger(
            own,
            target,
            operationKey,
            "receipt",
            code,
            firstOnly,
            constraint,
          );
          const actual = await outcome(
            target.caseStore.link(
              target.tenant,
              target.actor,
              target.lotId,
              { operationKey, ssccs },
              "public-injected",
            ),
          );
          const attempts = retryable ? (firstOnly ? 2 : 3) : 1;
          expect(await failure.attempts()).toBe(attempts);
          if (retryable && firstOnly) {
            expect(actual.error).toBeUndefined();
            expect(actual.value?.created).toHaveLength(1);
            const state = await receiptState(target, operationKey);
            expect(state.receipts).toHaveLength(1);
            expect(state.audits).toHaveLength(1);
          } else {
            if (retryable)
              expect(actual.error).toMatchObject({
                status: 503,
                response: { code: "us_database_unavailable" },
              });
            else expect(driverCode(actual.error)).toBe("23505");
            expect(await f.snapshot()).toEqual(before);
          }
          console.info("Case injected public attempts", { code, constraint, firstOnly, attempts });
        });
        const nativeTarget = await seedCaseTransactionTarget(f);
        const nativeKey = randomUUID();
        const nativeBefore = await f.snapshot();
        await withOwnedWork(async (own) => {
          const failure = await failureTrigger(
            own,
            nativeTarget,
            nativeKey,
            "receipt",
            code,
            firstOnly,
            constraint,
          );
          const actual = await outcome(
            transaction(async (tx) => {
              await insertCaseTransactionSupport(tx, nativeTarget, ssccs, 1);
              return nativeTarget.caseStore.linkInTransaction(
                tx,
                nativeTarget.tenant,
                nativeTarget.actor,
                nativeTarget.lotId,
                { operationKey: nativeKey, ssccs },
                "native-no-retry",
              );
            }),
          );
          expect(driverCode(actual.error)).toBe(code);
          expect(await failure.attempts()).toBe(1);
          expect(await f.snapshot()).toEqual(nativeBefore);
        });
      }
    },
  );

  it("links 100 uncommitted support boxes and exposes manual synthetic rows through public reads", async () => {
    const target = await seedCaseTransactionTarget(f);
    const ssccs = Array.from({ length: 100 }, (_, i) => buildSscc(9, "9999999", i + 1));
    const operationKey = randomUUID();
    const before = await f.snapshot();
    const [lotBefore] = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(
        and(
          eq(schema.traceabilityLots.tenantId, target.tenant),
          eq(schema.traceabilityLots.id, target.lotId),
        ),
      );
    if (!lotBefore) throw new Error("Expected finalized output lot");
    const result = await f.db.transaction(
      async (tx) => {
        const boxes = await insertCaseTransactionSupport(tx, target, ssccs, 1);
        const linked = await target.caseStore.linkInTransaction(
          tx,
          target.tenant,
          target.actor,
          target.lotId,
          { operationKey, ssccs },
          "case-native-compose",
        );
        expect(linked.created).toHaveLength(100);
        expect(linked.unchanged).toEqual([]);
        expect(new Set(linked.created.map((row) => row.boxId))).toEqual(
          new Set(boxes.map((row) => row.id)),
        );
        for (const row of linked.created) {
          expect(row).toMatchObject({
            lotId: target.lotId,
            linkSource: "manual",
            provenance: "synthetic_demo",
            linkedBy: target.actor,
            originState: "current",
            ssccState: "consistent",
            unlinkedAt: null,
            unlinkedBy: null,
            unlinkReason: null,
          });
        }
        return linked;
      },
      { isolationLevel: "repeatable read" },
    );
    const page = await target.caseStore.list(target.tenant, target.actor, target.lotId, {
      limit: 100,
    });
    expect(page.activeCount).toBe(100);
    expect(new Set(page.rows.map((row) => row.linkId))).toEqual(
      new Set(result.created.map((row) => row.linkId)),
    );
    const state = await receiptState(target, operationKey);
    expect(state.receipts).toHaveLength(1);
    expect(state.receipt).toEqual({
      command: "case.link",
      operation_key: operationKey,
      input_digest: createHash("sha256")
        .update(
          JSON.stringify({
            commandVersion: 1,
            command: "case.link",
            lotId: target.lotId,
            input: { ssccs: [...ssccs].sort() },
          }),
        )
        .digest("hex"),
      target_id: target.lotId,
      bytes: expect.any(String),
    });
    if (!state.receipt) throw new Error("Expected native receipt");
    expect(JSON.parse(state.receipt.bytes)).toEqual(result);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]?.body).toMatchObject({
      organization_id: target.tenant,
      actor_user_id: target.actor,
      action: "case.link",
      outcome: "success",
      target_type: "traceability_lot",
      target_id: target.lotId,
      request_id: "case-native-compose",
      before: { links: [] },
      after: {
        tenantId: target.tenant,
        operationKey,
        lotId: target.lotId,
        source: "manual",
        result,
      },
    });
    expect(state.audits[0]?.body.before).toEqual({ links: [] });
    expect(state.audits[0]?.body.after).toEqual({
      tenantId: target.tenant,
      operationKey,
      lotId: target.lotId,
      source: "manual",
      result,
    });
    const [lotAfter] = await f.db
      .select()
      .from(schema.traceabilityLots)
      .where(
        and(
          eq(schema.traceabilityLots.tenantId, target.tenant),
          eq(schema.traceabilityLots.id, target.lotId),
        ),
      );
    expect(lotAfter).toEqual({
      ...lotBefore,
      currentDependencyVersion: lotBefore.currentDependencyVersion + 1,
    });
    const lookup = await target.caseStore.lookup(target.tenant, target.actor, { sscc: ssccs[0] });
    expect(lookup).toEqual({
      boxId: result.created[0]?.boxId,
      sscc: ssccs[0],
      provenance: "synthetic_demo",
      activeLink: result.created[0],
    });
    const support = await f.db
      .select()
      .from(schema.boxes)
      .where(eq(schema.boxes.tenantId, target.tenant));
    expect(support).toHaveLength(100);
    for (const box of support)
      expect(box).toMatchObject({
        terminalId: null,
        operatorId: null,
        closedAt: null,
        closureReceivedAt: null,
        printVerifiedAt: null,
        printSkippedAt: null,
        disassembledAt: null,
      });
    const shift = await f.db
      .select()
      .from(schema.shifts)
      .where(eq(schema.shifts.tenantId, target.tenant));
    expect(shift).toHaveLength(1);
    expect(shift[0]).toMatchObject({
      mode: "aggregation",
      numberMonthKey: "SEP26",
      numberSeq: 1,
      closedAt: null,
    });
    const after = await f.snapshot();
    for (const table of [
      "traceability_events",
      "lot_genealogy_edges",
      "transformation_event_inputs",
      "transformation_event_outputs",
      "box_items",
      "scan_events",
    ]) {
      expect(before[table]).toBeDefined();
      expect(after[table]).toBe(before[table]);
    }
    expect(target.finalized.snapshot.outputs[0]).toMatchObject({
      quantity: "100",
      unitOfMeasure: "case",
    });
  });

  it.each(["native-public", "public-native"] as const)(
    "replays exact original receipts across %s with normalized permuted wrappers",
    async (direction) => {
      const target = await seedCaseTransactionTarget(f);
      const ssccs = codes();
      await transaction((tx) => insertCaseTransactionSupport(tx, target, ssccs, 1));
      const operationKey = randomUUID();
      const input = { operationKey, ssccs };
      const first =
        direction === "native-public"
          ? await native(target, input)
          : await target.caseStore.link(
              target.tenant,
              target.actor,
              target.lotId,
              input,
              "public-first",
            );
      const normalized = { operationKey, ssccs: [...ssccs].reverse().map((s) => `(00)${s}`) };
      const before = await receiptState(target, operationKey);
      const snapshot = await f.snapshot();
      const replay =
        direction === "native-public"
          ? await target.caseStore.link(
              target.tenant,
              target.actor,
              target.lotId,
              normalized,
              "public-replay",
            )
          : await native(target, normalized);
      expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
      expect(await receiptState(target, operationKey)).toEqual(before);
      expect(await f.snapshot()).toEqual(snapshot);
      await deniedUnchanged(
        () => native(target, { operationKey, ssccs: [ssccs[0]] }),
        409,
        "case_operation_conflict",
      );
      const lots = (await f.snapshot()).traceability_lots;
      expect(await native(target, { operationKey: randomUUID(), ssccs })).toEqual({
        lotId: target.lotId,
        created: [],
        unchanged: first.created,
      });
      expect((await f.snapshot()).traceability_lots).toBe(lots);
    },
  );

  it("returns the historical native receipt after public unlink without recreating links or rewriting bytes", async () => {
    const target = await seedCaseTransactionTarget(f);
    const ssccs = codes(1);
    await transaction((tx) => insertCaseTransactionSupport(tx, target, ssccs, 1));
    const input = { operationKey: randomUUID(), ssccs };
    const first = await native(target, input);
    const link = first.created[0];
    if (!link) throw new Error("Expected created link");
    await target.caseStore.unlink(
      target.tenant,
      target.actor,
      target.lotId,
      link.linkId,
      { operationKey: randomUUID(), reason: "Wrong lot" },
      "public-unlink",
    );
    const before = await receiptState(target, input.operationKey);
    const snapshot = await f.snapshot();
    expect(await native(target, input)).toEqual(first);
    expect(
      await target.caseStore.link(
        target.tenant,
        target.actor,
        target.lotId,
        input,
        "public-history",
      ),
    ).toEqual(first);
    expect(await receiptState(target, input.operationKey)).toEqual(before);
    expect(await f.snapshot()).toEqual(snapshot);
    expect(
      (await target.caseStore.list(target.tenant, target.actor, target.lotId, { limit: 100 }))
        .activeCount,
    ).toBe(0);
  });

  it("denies current capability or membership before malformed input and before native operation replay", async () => {
    const target = await seedCaseTransactionTarget(f);
    const ssccs = codes(1);
    await transaction((tx) => insertCaseTransactionSupport(tx, target, ssccs, 1));
    const input = { operationKey: randomUUID(), ssccs };
    await native(target, input);
    const where = and(
      eq(schema.member.organizationId, target.tenant),
      eq(schema.member.userId, target.actor),
    );
    const [membership] = await f.db.select().from(schema.member).where(where);
    if (!membership) throw new Error("Expected test-owned membership");
    try {
      await f.db.update(schema.member).set({ role: "viewer" }).where(where);
      await deniedUnchanged(() => native(target, input), 403, "insufficient_permission");
      await deniedUnchanged(
        () => native(target, null, "not-a-uuid"),
        403,
        "insufficient_permission",
      );
      await f.db.delete(schema.member).where(where);
      await deniedUnchanged(() => native(target, input), 403, "insufficient_permission");
      await deniedUnchanged(
        () => native(target, null, "not-a-uuid"),
        403,
        "insufficient_permission",
      );
    } finally {
      await f.db
        .insert(schema.member)
        .values(membership)
        .onConflictDoUpdate({ target: schema.member.id, set: { role: membership.role } });
    }
    expect(await native(target, input)).toMatchObject({ created: [{ linkedBy: target.actor }] });
  });

  it("rejects malformed, duplicate and oversized native batches and strict public source injection atomically", async () => {
    const target = await seedCaseTransactionTarget(f);
    const ssccs = codes();
    await transaction((tx) => insertCaseTransactionSupport(tx, target, ssccs, 1));
    const code = ssccs[0];
    if (!code) throw new Error("Expected SSCC");
    const badCheck = code.slice(0, -1) + ((Number(code.at(-1)) + 1) % 10);
    for (const batch of [[], ["invalid"], [badCheck], [code, `(00)${code}`], codes(101)]) {
      await deniedUnchanged(
        () => native(target, { operationKey: randomUUID(), ssccs: batch }),
        400,
        "invalid_master_data",
      );
    }
    await deniedUnchanged(
      () => native(target, { operationKey: randomUUID(), ssccs }, "bad-id"),
      400,
      "invalid_master_data",
    );
    for (const extra of [{ linkSource: "demo_seed" }, { synthetic: true }]) {
      await deniedUnchanged(
        () =>
          target.caseStore.link(
            target.tenant,
            target.actor,
            target.lotId,
            { operationKey: randomUUID(), ssccs, ...extra },
            "public-invalid",
          ),
        400,
        "invalid_master_data",
      );
    }
  });

  it("denies foreign tenant, foreign lot/box, missing box, disassembled box and cross-lot conflict without any writes", async () => {
    const target = await seedCaseTransactionTarget(f);
    const foreign = await seedCaseTransactionTarget(f);
    const ssccs = codes();
    const boxes = await transaction((tx) => insertCaseTransactionSupport(tx, target, ssccs, 1));
    const foreignCode = buildSscc(9, "8888888", 1);
    await transaction((tx) => insertCaseTransactionSupport(tx, foreign, [foreignCode], 1));
    await deniedUnchanged(
      () =>
        transaction((tx) =>
          target.caseStore.linkInTransaction(
            tx,
            foreign.tenant,
            target.actor,
            foreign.lotId,
            { operationKey: randomUUID(), ssccs: [foreignCode] },
            "foreign-tenant",
          ),
        ),
      403,
      "insufficient_permission",
    );
    await deniedUnchanged(
      () => native(target, { operationKey: randomUUID(), ssccs }, foreign.lotId),
      404,
      "case_lot_not_found",
    );
    await deniedUnchanged(
      () => native(target, { operationKey: randomUUID(), ssccs: [ssccs[0], foreignCode] }),
      404,
      "case_not_found",
    );
    await deniedUnchanged(
      () =>
        native(target, {
          operationKey: randomUUID(),
          ssccs: [ssccs[0], buildSscc(9, "7777777", 1)],
        }),
      404,
      "case_not_found",
    );
    const retired = boxes[1];
    if (!retired) throw new Error("Expected second box");
    await f.db
      .update(schema.boxes)
      .set({ disassembledAt: new Date() })
      .where(and(eq(schema.boxes.tenantId, target.tenant), eq(schema.boxes.id, retired.id)));
    await deniedUnchanged(
      () => native(target, { operationKey: randomUUID(), ssccs }),
      409,
      "case_disassembled",
    );
    await native(target, { operationKey: randomUUID(), ssccs: [ssccs[0]] });
    const otherLot = randomUUID();
    await f.db.insert(schema.traceabilityLots).values({
      id: otherLot,
      tenantId: target.tenant,
      productId: target.product,
      tlc: "OTHER-NATIVE",
      assignmentBasis: "imported",
      createdBy: target.actor,
      updatedBy: target.actor,
    });
    await deniedUnchanged(
      () => native(target, { operationKey: randomUUID(), ssccs: [ssccs[0]] }, otherLot),
      409,
      "case_link_conflict",
    );
  });
});
