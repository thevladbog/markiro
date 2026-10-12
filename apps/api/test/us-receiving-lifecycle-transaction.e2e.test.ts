import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { schema } from "@markiro/db";
import { receivingAmendmentDraftSchema } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UsMasterDataTransaction } from "../src/modules/traceability/master-data/us-master-data-support";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";

const base = process.env.US_TEST_DATABASE_URL;

// Run the actual suite hooks in a second real runner. Only the first two case bodies and
// witness-local budgets are instrumented; the guard/phase/drain/fixture code is not copied.
async function witnessTimedOutReceivingPhase() {
  const directory = await mkdtemp(join(tmpdir(), "receiving-lifecycle-timeout-"));
  const target = resolve("test/us-receiving-lifecycle-transaction.e2e.test.ts");
  const config = join(directory, "vitest.config.mjs");
  const names = [
    "composes real amendment/save/readiness/finalization with retained lot identities",
    "voids a real finalized original with retained lots and absent current basis",
  ];
  try {
    await writeFile(
      config,
      String.raw`
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const ts = require(${JSON.stringify(resolve("node_modules/typescript"))});
      const target = ${JSON.stringify(target)};
      const names = ${JSON.stringify(names)};
      export default {
        plugins: [{ name: "owned-receiving-timeout-witness", enforce: "pre",
          transform(code, id) {
            if (id.split("?")[0] !== target) return;
            const source = ts.createSourceFile(target, code, ts.ScriptTarget.Latest, true);
            const edits = [];
            let hooks = 0, bodies = 0, provisions = 0;
            function visit(node) {
              if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                if (node.expression.text === "afterEach") {
                  const budget = node.arguments[1];
                  if (!budget || !ts.isNumericLiteral(budget) || budget.text !== "60000")
                    throw new Error("Witness expected existing afterEach budget");
                  edits.push({ start: budget.getStart(source), end: budget.end, text: "50" });
                  hooks++;
                }
                const label = node.arguments[0];
                if (node.expression.text === "it" && label && ts.isStringLiteral(label) && names.includes(label.text)) {
                  const phase = node.arguments[1];
                  const callback = phase && ts.isCallExpression(phase) ? phase.arguments[0] : undefined;
                  if (!callback || !ts.isArrowFunction(callback) || !ts.isBlock(callback.body))
                    throw new Error("Witness expected actual tracked test phase");
                  const first = label.text === names[0];
                  const body = first
                    ? '{ const retainedTenant = c.tenant; console.info("witness:prior-live"); await track(f.pool.query("SELECT pg_sleep(1)")); console.info("witness:prior-drained", c.tenant !== retainedTenant); }'
                    : '{ console.info("witness:next-test-started"); }';
                  edits.push({ start: callback.body.getStart(source), end: callback.body.end, text: body });
                  if (first) edits.push({ start: node.end - 1, end: node.end - 1, text: node.arguments.hasTrailingComma ? "50" : ", 50" });
                  bodies++;
                }
              }
              if (ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)) {
                const call = node.expression.expression;
                if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
                  && call.expression.expression.getText(source) === "f" && call.expression.name.text === "provision") {
                  edits.push({ start: node.getStart(source), end: node.getStart(source), text: 'console.info("witness:provision-start");\n' });
                  provisions++;
                }
              }
              ts.forEachChild(node, visit);
            }
            visit(source);
            if (hooks !== 1 || bodies !== 2 || provisions !== 1)
              throw new Error("Witness target instrumentation incomplete");
            for (const edit of edits.sort((a, b) => b.start - a.start))
              code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
            if (ts.createSourceFile(target, code, ts.ScriptTarget.Latest, true).parseDiagnostics.length)
              throw new Error("Witness instrumentation produced invalid syntax");
            return { code, map: null };
          },
        }],
        test: { globals: true, environment: "node", include: [target],
          testNamePattern: names.join("|"), fileParallelism: false, maxWorkers: 1 },
      };
    `,
    );
    const environment = { ...process.env };
    delete environment.DATABASE_URL;
    const child = spawn(
      process.execPath,
      [resolve("node_modules/vitest/vitest.mjs"), "run", "--config", config, "--reporter=verbose"],
      {
        cwd: process.cwd(),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
    // Await actual process closure, never kill or dispose because the parent test timed out.
    const exitCode = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    expect(exitCode).toBe(1);
    expect(output).toMatch(/Tests\s+2 failed \| 36 skipped \(38\)/);
    expect(output).not.toMatch(/Failed Suites|Unhandled Errors|Unhandled Rejection/);
    expect(output).toContain("Test timed out in 50ms");
    expect(output).toContain("Hook timed out in 50ms");
    const owned = /Owned Receiving lifecycle database: (markiro_us_profile_[a-f0-9_]+)/.exec(
      output,
    )?.[1];
    if (!owned) throw new Error("Timeout witness did not acquire an owned child");
    expect(output).toContain(`Receiving lifecycle work drained: ${owned}`);
    expect(output).toContain(`Disposed dataset database verified absent: ${owned}`);
    expect(output.indexOf("witness:prior-drained")).toBeLessThan(
      output.indexOf(`Receiving lifecycle work drained: ${owned}`),
    );
    const provisionCount = output.split("witness:provision-start").length - 1;
    console.info(
      `Timeout witness child drained and absent: ${owned}; provisions=${provisionCount}`,
    );
    expect(provisionCount).toBe(1);
    expect(output).toContain("receiving_native_prior_work_live");
    expect(output).toContain("witness:prior-drained false");
    expect(output).not.toContain("witness:next-test-started");
    console.info(`Timeout witness verified guard, drained work and absent child: ${owned}`);
  } finally {
    // Only this invocation's generated directory, after the real child process exited.
    await rm(directory, { recursive: true });
  }
}

describe.skipIf(!base)(
  "Receiving native lifecycle on owned PostgreSQL",
  { timeout: 30_000 },
  () => {
    let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
    let acquisition: Promise<void> | undefined;
    let receiving: UsReceivingStore;
    let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
    const work = new Set<Promise<unknown>>();
    function track<T>(pending: Promise<T>): Promise<T> {
      work.add(pending);
      void pending.then(
        () => work.delete(pending),
        () => work.delete(pending),
      );
      return pending;
    }
    const native = <T>(run: (tx: UsMasterDataTransaction) => Promise<T>) =>
      track(f.db.transaction(run, { isolationLevel: "repeatable read" }));
    // Register the entire phase, including continuations and finally cleanup, so a Vitest
    // timeout cannot leave live work behind before the next provision or disposal.
    const phase =
      <Args extends unknown[]>(run: (...args: Args) => Promise<void>) =>
      (...args: Args) =>
        track(Promise.resolve().then(() => run(...args)));
    async function drain() {
      while (work.size) await Promise.allSettled([...work]);
    }
    beforeAll(async () => {
      if (!base) throw new Error("Missing isolated US database");
      acquisition = createUsDatasetJournalFixture(base).then((fixture) => {
        f = fixture;
        receiving = new UsReceivingStore(f.db);
        console.info(`Owned Receiving lifecycle database: ${f.databaseName}`);
      });
      await acquisition;
    }, 60_000);
    beforeEach(() => {
      // A timed-out drain hook does not cancel prior work. Refuse synchronously before
      // registering a new phase; waiting here could resume after its own hook timeout.
      if (work.size) throw new Error("receiving_native_prior_work_live");
      return phase(async () => {
        await f.provision();
        c = await seedCompleteReceiving(f.db);
      })();
    }, 60_000);
    afterEach(async () => {
      await drain();
    }, 60_000);
    afterAll(async () => {
      await acquisition?.catch(() => undefined);
      await drain();
      if (!f) return;
      try {
        const active = await f.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND state<>'idle'",
        );
        expect(active.rows).toEqual([{ count: 0 }]);
        console.info(`Receiving lifecycle work drained: ${f.databaseName}`);
      } finally {
        await f.close();
      }
    }, 60_000);

    const amendInput = (version = 2) => ({
      commandVersion: 2,
      operationKey: randomUUID(),
      expectedLifecycleVersion: version,
      reason: "Synthetic recount",
    });
    const voidInput = (version = 2, draftVersion: number | null = null) => ({
      ...amendInput(version),
      expectedDraftVersion: draftVersion,
      reason: "Synthetic entered in error",
    });
    async function finalize(tx: UsMasterDataTransaction, id: string, draftVersion: number) {
      const ready = await receiving.checkRevisionReadinessInTransaction(tx, c.tenant, c.actor, id, {
        expectedDraftVersion: draftVersion,
      });
      expect(ready.state).toBe("complete");
      const operationKey = randomUUID();
      const receipt = await receiving.finalizeCommandInTransaction(
        tx,
        c.tenant,
        c.actor,
        id,
        {
          commandVersion: 2,
          operationKey,
          expectedDraftVersion: ready.draftVersion,
          expectedLifecycleVersion: ready.expectedLifecycleVersion,
          previousRevisionId: ready.previousRevisionId,
          expectedInputDigest: ready.inputDigest,
          reviewedExemptLines: [],
        },
        operationKey,
      );
      if (!("receiptVersion" in receipt)) throw new Error("Expected versioned finalization");
      return receipt;
    }
    async function original() {
      return native(async (tx) => {
        const operationKey = randomUUID();
        const created = await receiving.createDraftCommandInTransaction(
          tx,
          c.tenant,
          c.actor,
          {
            operationKey,
            draft: c.draft,
          },
          operationKey,
        );
        if (!("receiptVersion" in created)) throw new Error("Expected versioned creation");
        return finalize(tx, created.eventId, 1);
      });
    }
    const amend = (tx: UsMasterDataTransaction, id: string, input = amendInput()) =>
      receiving.amendInTransaction(tx, c.tenant, c.actor, id, input, input.operationKey);
    const voidCommand = (tx: UsMasterDataTransaction, id: string, input = voidInput()) =>
      receiving.voidInTransaction(tx, c.tenant, c.actor, id, input, input.operationKey);
    const saveInput = (started: Awaited<ReturnType<typeof amend>>, changed = true) => {
      if (started.record.content.kind !== "draft") throw new Error("Expected amendment draft");
      const draft = receivingAmendmentDraftSchema.parse(started.record.content.draft);
      const first = draft.items[0];
      if (!first) throw new Error("Expected first retained line");
      if (changed) first.quantity = "300";
      return {
        commandVersion: 2,
        operationKey: randomUUID(),
        expectedLifecycleVersion: started.record.lifecycle.lifecycleVersion,
        expectedDraftVersion: started.record.draftVersion,
        draft,
      };
    };
    const save = (tx: UsMasterDataTransaction, id: string, input: ReturnType<typeof saveInput>) =>
      receiving.saveAmendmentInTransaction(tx, c.tenant, c.actor, id, input, input.operationKey);
    async function businessLots() {
      return (
        await f.pool.query(
          "SELECT to_jsonb(l)-'receiving_basis_version'-'current_dependency_version' AS lot FROM traceability_lots l WHERE tenant_id=$1 ORDER BY id",
          [c.tenant],
        )
      ).rows;
    }
    async function audit(requestId: string) {
      return f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, c.tenant),
            eq(schema.tenantAuditEvents.requestId, requestId),
          ),
        );
    }
    async function exactOperation(receipt: Awaited<ReturnType<typeof amend>>) {
      const rows = await f.db
        .select()
        .from(schema.receivingOperations)
        .where(
          and(
            eq(schema.receivingOperations.tenantId, c.tenant),
            eq(schema.receivingOperations.command, receipt.command),
            eq(schema.receivingOperations.operationKey, receipt.operationKey),
          ),
        );
      expect(rows).toEqual([
        expect.objectContaining({
          tenantId: c.tenant,
          command: receipt.command,
          operationKey: receipt.operationKey,
          inputDigest: receipt.inputDigest,
          eventId: receipt.eventId,
          result: receipt,
        }),
      ]);
    }

    it(
      "composes real amendment/save/readiness/finalization with retained lot identities",
      phase(async () => {
        const old = await original();
        if (old.record.content.kind !== "finalized") throw new Error("Expected original snapshot");
        const originalItems = old.record.content.snapshot.items;
        expect(new Set(originalItems.map((line) => line.lotId)).size).toBe(2);
        expect(originalItems.map((line) => line.quantity)).toEqual(["500.000", "0.250"]);
        const unchangedLots = await businessLots();
        const input = amendInput();
        const result = await native(async (tx) => {
          const started = await amend(tx, old.eventId, input);
          const command = saveInput(started);
          const saved = await save(tx, started.eventId, command);
          const predecessorBefore = await receiving.getLiveRecordInTransaction(
            tx,
            c.tenant,
            c.actor,
            old.eventId,
          );
          const corrected = await finalize(tx, saved.eventId, saved.record.draftVersion);
          return { started, saved, corrected, command, predecessorBefore };
        });
        expect(result.corrected.record).toMatchObject({
          status: "finalized",
          revision: 2,
          draftVersion: 2,
          lifecycle: {
            currentEventId: result.started.eventId,
            pendingDraftId: null,
            lifecycleVersion: 4,
          },
        });
        if (result.corrected.record.content.kind !== "finalized")
          throw new Error("Expected corrected snapshot");
        expect(result.corrected.record.content.snapshot.items.map((line) => line.quantity)).toEqual(
          ["300", "0.250"],
        );
        expect(
          result.corrected.record.content.snapshot.items.map((line) => ({
            lotId: line.lotId,
            productId: line.productId,
            tlc: line.tlc,
            source: line.source,
          })),
        ).toEqual(
          originalItems.map((line) => ({
            lotId: line.lotId,
            productId: line.productId,
            tlc: line.tlc,
            source: line.source,
          })),
        );
        expect(
          result.corrected.record.content.snapshot.items.map((line) =>
            "lotBinding" in line ? line.lotBinding : null,
          ),
        ).toEqual([
          { kind: "retained", previousEventId: old.eventId, previousLineNo: 1 },
          { kind: "retained", previousEventId: old.eventId, previousLineNo: 2 },
        ]);
        expect(await businessLots()).toEqual(unchangedLots);
        const predecessor = await receiving.getLiveRecord(c.tenant, c.actor, old.eventId);
        expect(predecessor).toMatchObject({
          status: "amended",
          content: old.record.content,
          lifecycle: {
            currentEventId: result.corrected.eventId,
            pendingDraftId: null,
            lifecycleVersion: 4,
            supersededByEventId: result.corrected.eventId,
            supersededBy: c.actor,
          },
        });
        for (const line of originalItems) {
          const basis = await receiving.getLotReceivingBasis(c.tenant, c.actor, line.lotId, {});
          expect(basis).toMatchObject({
            state: "present",
            supportCount: 1,
            basisVersion: 3,
            items: [
              {
                rootId: old.eventId,
                eventId: result.corrected.eventId,
                revision: 2,
                lineNos: [line.lineNo],
              },
            ],
          });
        }
        expect(await audit(input.operationKey)).toEqual([
          expect.objectContaining({
            organizationId: c.tenant,
            actorUserId: c.actor,
            action: "traceability.receiving.amendment_started",
            targetType: "traceability_event",
            targetId: result.started.eventId,
            outcome: "success",
            before: old.record,
            after: {
              rootId: old.eventId,
              revision: 2,
              reason: "Synthetic recount",
              result: "draft_started",
              record: result.started.record,
            },
            requestId: input.operationKey,
          }),
        ]);
        expect(await audit(result.command.operationKey)).toEqual([
          expect.objectContaining({
            organizationId: c.tenant,
            actorUserId: c.actor,
            action: "traceability.receiving.draft_saved",
            targetType: "traceability_event",
            targetId: result.started.eventId,
            outcome: "success",
            before: result.started.record,
            after: result.saved.record,
            requestId: result.command.operationKey,
          }),
        ]);
        const first = originalItems[0];
        if (!first) throw new Error("Expected first original line");
        expect(await audit(result.corrected.operationKey)).toEqual([
          expect.objectContaining({
            organizationId: c.tenant,
            actorUserId: c.actor,
            action: "traceability.receiving.finalized",
            targetType: "traceability_event",
            targetId: result.corrected.eventId,
            outcome: "success",
            requestId: result.corrected.operationKey,
            before: result.saved.record,
            after: {
              rootId: old.eventId,
              revision: 2,
              reason: "Synthetic recount",
              result: "finalized",
              effect: {
                kind: "material",
                affectedLotIds: [first.lotId],
                removedPreviousLineNos: [],
                identityLockedLineNos: [],
                invalidBindingLineNos: [],
              },
              record: result.corrected.record,
              predecessor: { before: result.predecessorBefore, after: predecessor },
              lineLots: {
                before: originalItems.map((line) => ({ lineNo: line.lineNo, lotId: line.lotId })),
                after: result.corrected.record.content.snapshot.items.map((line) => ({
                  lineNo: line.lineNo,
                  lotId: line.lotId,
                })),
              },
            },
          }),
        ]);
        for (const receipt of [result.started, result.saved, result.corrected])
          await exactOperation(receipt);
      }),
    );

    it(
      "voids a real finalized original with retained lots and absent current basis",
      phase(async () => {
        const old = await original();
        const unchangedLots = await businessLots();
        const input = voidInput();
        const receipt = await native((tx) => voidCommand(tx, old.eventId, input));
        expect(receipt.record).toMatchObject({
          status: "void",
          content: old.record.content,
          lifecycle: {
            currentEventId: null,
            pendingDraftId: null,
            lifecycleVersion: 3,
            voidedBy: c.actor,
            voidReason: input.reason,
          },
        });
        expect(await businessLots()).toEqual(unchangedLots);
        if (old.record.content.kind !== "finalized") throw new Error("Expected original snapshot");
        for (const line of old.record.content.snapshot.items)
          expect(
            await receiving.getLotReceivingBasis(c.tenant, c.actor, line.lotId, {}),
          ).toMatchObject({
            state: "missing",
            supportCount: 0,
            items: [],
            basisVersion: 3,
          });
        expect(await audit(input.operationKey)).toEqual([
          expect.objectContaining({
            organizationId: c.tenant,
            actorUserId: c.actor,
            action: "traceability.receiving.voided",
            targetType: "traceability_event",
            targetId: old.eventId,
            outcome: "success",
            before: old.record,
            after: {
              rootId: old.eventId,
              revision: 1,
              reason: input.reason,
              result: "voided",
              record: receipt.record,
            },
            requestId: input.operationKey,
          }),
        ]);
        await exactOperation(receipt);
      }),
    );

    const kinds = ["amend", "save", "void"] as const;
    type Kind = (typeof kinds)[number];
    async function prepare(kind: Kind, changed = true) {
      const old = await original();
      let id = old.eventId;
      let input:
        ReturnType<typeof amendInput> | ReturnType<typeof voidInput> | ReturnType<typeof saveInput>;
      if (kind === "save") {
        const command = amendInput();
        const started = await track(
          receiving.amend(c.tenant, c.actor, id, command, command.operationKey),
        );
        id = started.eventId;
        input = saveInput(started, changed);
      } else input = kind === "amend" ? amendInput() : voidInput();
      const execute = (
        tx: UsMasterDataTransaction,
        value: unknown = input,
        tenant = c.tenant,
        actor = c.actor,
        target: unknown = id,
      ) => {
        if (kind === "amend")
          return receiving.amendInTransaction(tx, tenant, actor, target, value, input.operationKey);
        if (kind === "save")
          return receiving.saveAmendmentInTransaction(
            tx,
            tenant,
            actor,
            target,
            value,
            input.operationKey,
          );
        return receiving.voidInTransaction(tx, tenant, actor, target, value, input.operationKey);
      };
      const publicCall = () => {
        if (kind === "amend")
          return receiving.amend(c.tenant, c.actor, id, input, input.operationKey);
        if (kind === "save")
          return receiving.saveAmendment(c.tenant, c.actor, id, input, input.operationKey);
        return receiving.void(c.tenant, c.actor, id, input, input.operationKey);
      };
      return { id, input, execute, publicCall };
    }
    async function snapshot() {
      const result = await f.snapshot();
      expect(Object.keys(result)).toHaveLength(198);
      return result;
    }
    async function denied(
      run: (tx: UsMasterDataTransaction) => Promise<unknown>,
      status: number,
      code: string,
    ) {
      const before = await snapshot();
      await expect(native(run)).rejects.toMatchObject({ status, response: { code } });
      expect(await snapshot()).toEqual(before);
    }
    async function setRole(role: string) {
      await f.db.update(schema.member).set({ role }).where(eq(schema.member.id, c.member));
    }
    async function failpoint(table: string, condition: string, retryable = false) {
      const name = `receiving_lifecycle_${randomUUID().replaceAll("-", "_")}`;
      const cleanups: (() => Promise<unknown>)[] = [];
      async function remove() {
        const outcomes = [];
        for (const cleanup of [...cleanups].reverse())
          outcomes.push(...(await Promise.allSettled([cleanup()])));
        cleanups.length = 0;
        const errors = outcomes
          .filter((outcome) => outcome.status === "rejected")
          .map((outcome) => outcome.reason);
        if (errors.length) throw new AggregateError(errors, "Owned failpoint cleanup failed");
      }
      try {
        if (retryable) {
          cleanups.push(() => f.pool.query(`DROP SEQUENCE IF EXISTS ${name}_attempt`));
          await f.pool.query(`CREATE SEQUENCE ${name}_attempt`);
        }
        cleanups.push(() => f.pool.query(`DROP FUNCTION IF EXISTS ${name}()`));
        await f.pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF ${condition} THEN ${retryable ? `PERFORM nextval('${name}_attempt');` : ""}
          RAISE EXCEPTION 'receiving_native_owned_failure' USING ERRCODE='${retryable ? "40001" : "P0001"}';
        END IF; RETURN NEW; END $$`);
        cleanups.push(() => f.pool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`));
        await f.pool.query(
          `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
        );
        return {
          remove,
          attempts: async () =>
            (
              await f.pool.query<{ count: number }>(
                `SELECT last_value::int AS count FROM ${name}_attempt`,
              )
            ).rows[0]?.count,
        };
      } catch (error) {
        await remove();
        throw error;
      }
    }

    it.each(kinds)(
      "rolls back all 198 tables on caller abort after native %s",
      phase(async (kind) => {
        const p = await prepare(kind);
        const before = await snapshot();
        await expect(
          native(async (tx) => {
            await p.execute(tx);
            throw new Error("receiving_native_outer_abort");
          }),
        ).rejects.toThrow("receiving_native_outer_abort");
        expect(await snapshot()).toEqual(before);
        await exactOperation(await native(p.execute));
      }),
    );
    it.each(kinds.flatMap((kind) => ["audit", "operation"].map((stage) => [kind, stage] as const)))(
      "rolls back every table on actual native %s %s insertion failure",
      phase(async (kind, stage) => {
        const p = await prepare(kind);
        const table = stage === "audit" ? "tenant_audit_events" : "receiving_operations";
        const action =
          kind === "amend" ? "amendment_started" : kind === "save" ? "draft_saved" : "voided";
        const condition =
          stage === "audit"
            ? `NEW.action='traceability.receiving.${action}'`
            : `NEW.command='receiving.${kind}'`;
        const owned = await failpoint(table, condition);
        try {
          const before = await snapshot();
          await expect(native(p.execute)).rejects.toMatchObject({
            cause: { code: "P0001", message: "receiving_native_owned_failure" },
          });
          expect(await snapshot()).toEqual(before);
        } finally {
          await owned.remove();
        }
        await exactOperation(await native(p.execute));
      }),
    );
    it.each(kinds)(
      "propagates native %s 40001 once; public retries three times; caller retry succeeds",
      phase(async (kind) => {
        const p = await prepare(kind);
        let owned = await failpoint(
          "receiving_operations",
          `NEW.command='receiving.${kind}'`,
          true,
        );
        const before = await snapshot();
        try {
          await expect(native(p.execute)).rejects.toMatchObject({
            cause: { code: "40001", message: "receiving_native_owned_failure" },
          });
          expect(await owned.attempts()).toBe(1);
          expect(await snapshot()).toEqual(before);
        } finally {
          await owned.remove();
        }
        owned = await failpoint("receiving_operations", `NEW.command='receiving.${kind}'`, true);
        try {
          await expect(track(p.publicCall())).rejects.toMatchObject({
            status: 503,
            response: { code: "us_database_unavailable" },
          });
          expect(await owned.attempts()).toBe(3);
          expect(await snapshot()).toEqual(before);
        } finally {
          await owned.remove();
        }
        await exactOperation(await native(p.execute));
      }),
    );

    it(
      "cancels a native amendment draft, preserves the original basis, and replays historical bytes after later void",
      phase(async () => {
        const old = await original();
        const command = amendInput();
        const started = await native((tx) => amend(tx, old.eventId, command));
        const input = saveInput(started);
        const saved = await native((tx) => save(tx, started.eventId, input));
        const unchangedLots = await businessLots();
        const basis = await receiving.getLotReceivingBasis(c.tenant, c.actor, c.lot, {});
        const cancel = voidInput(3, 2);
        const cancelled = await native((tx) => voidCommand(tx, saved.eventId, cancel));
        expect(cancelled.record).toMatchObject({
          status: "void",
          lifecycle: {
            lifecycleVersion: 4,
            currentEventId: old.eventId,
            pendingDraftId: null,
          },
        });
        expect(await businessLots()).toEqual(unchangedLots);
        expect(await receiving.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toEqual(basis);
        await native((tx) => voidCommand(tx, old.eventId, voidInput(4)));
        const before = await snapshot();
        await native(async (tx) => {
          expect(await amend(tx, old.eventId, command)).toEqual(started);
          expect(await save(tx, saved.eventId, input)).toEqual(saved);
          expect(await voidCommand(tx, saved.eventId, cancel)).toEqual(cancelled);
          expect(
            await receiving.getLiveRecordInTransaction(tx, c.tenant, c.actor, saved.eventId),
          ).toMatchObject({
            status: "void",
            lifecycle: { currentEventId: null, lifecycleVersion: 5 },
          });
          expect(
            await receiving.getLotReceivingBasisInTransaction(tx, c.tenant, c.actor, c.lot, {}),
          ).toMatchObject({
            state: "missing",
            supportCount: 0,
          });
        });
        expect(await snapshot()).toEqual(before);
        await denied(
          (tx) => amend(tx, old.eventId, { ...command, reason: "Changed reason" }),
          409,
          "receiving_operation_conflict",
        );
        await denied(
          (tx) =>
            save(tx, saved.eventId, {
              ...input,
              draft: { ...input.draft, notes: "Changed draft" },
            }),
          409,
          "receiving_operation_conflict",
        );
        await denied(
          (tx) => voidCommand(tx, saved.eventId, { ...cancel, reason: "Changed void" }),
          409,
          "receiving_operation_conflict",
        );
      }),
    );

    it(
      "replays amendment/save after correction while live history and basis use revision 2",
      phase(async () => {
        const old = await original();
        const command = amendInput();
        const started = await native((tx) => amend(tx, old.eventId, command));
        const input = saveInput(started);
        const saved = await native((tx) => save(tx, started.eventId, input));
        await native((tx) => finalize(tx, saved.eventId, 2));
        const before = await snapshot();
        await native(async (tx) => {
          expect(await amend(tx, old.eventId, command)).toEqual(started);
          expect(await save(tx, saved.eventId, input)).toEqual(saved);
          expect(
            await receiving.getLiveRecordInTransaction(tx, c.tenant, c.actor, old.eventId),
          ).toMatchObject({ status: "amended" });
          expect(
            await receiving.getLotReceivingBasisInTransaction(tx, c.tenant, c.actor, c.lot, {}),
          ).toMatchObject({
            state: "present",
            items: [{ eventId: saved.eventId, revision: 2 }],
          });
        });
        expect(await snapshot()).toEqual(before);
      }),
    );

    it(
      "unchanged native save adds only an operation receipt without timestamps, versions or audit mutation",
      phase(async () => {
        const old = await original();
        const started = await native((tx) => amend(tx, old.eventId));
        const input = saveInput(started, false);
        const before = await snapshot();
        const receipt = await native((tx) => save(tx, started.eventId, input));
        expect(receipt.record).toEqual(started.record);
        expect(await audit(input.operationKey)).toEqual([]);
        const after = await snapshot();
        expect(Object.keys(before).filter((table) => before[table] !== after[table])).toEqual([
          "receiving_operations",
        ]);
        await exactOperation(receipt);
        expect(await native((tx) => save(tx, started.eventId, input))).toEqual(receipt);
        expect(await snapshot()).toEqual(after);
      }),
    );

    it.each(kinds)(
      "reauthorizes native %s before malicious getters and historical replay",
      phase(async (kind) => {
        const p = await prepare(kind);
        const receipt = await native(p.execute);
        const hostile = {
          get commandVersion() {
            throw new Error("parser_touched_hostile_input");
          },
        };
        await setRole("traceability_auditor");
        await denied(
          (tx) => p.execute(tx, hostile, c.tenant, c.actor, "invalid"),
          403,
          "insufficient_permission",
        );
        await denied(p.execute, 403, "insufficient_permission");
        await setRole("traceability_qa");
        expect(await native(p.execute)).toEqual(receipt);
        const outsider = randomUUID();
        await denied(
          (tx) => p.execute(tx, hostile, c.tenant, outsider, "invalid"),
          403,
          "insufficient_permission",
        );
        await denied(
          (tx) => p.execute(tx, p.input, c.tenant, outsider),
          403,
          "insufficient_permission",
        );
        const other = await track(seedCompleteReceiving(f.db));
        await denied(
          (tx) => p.execute(tx, p.input, other.tenant, other.actor),
          404,
          "receiving_draft_not_found",
        );
      }),
    );
    it.each(kinds)(
      "rejects stale native %s lifecycle version without writes",
      phase(async (kind) => {
        const p = await prepare(kind);
        await denied(
          (tx) => p.execute(tx, { ...p.input, expectedLifecycleVersion: 99 }),
          409,
          "receiving_lifecycle_conflict",
        );
      }),
    );
    it.each(["save", "void"] as const)(
      "rejects stale native %s draft version without writes",
      phase(async (kind) => {
        const p = await prepare(kind);
        await denied(
          (tx) => p.execute(tx, { ...p.input, expectedDraftVersion: 99 }),
          409,
          "receiving_draft_conflict",
        );
      }),
    );
    it.each(["product", "tlc", "source"] as const)(
      "rejects retained %s identity changes before writes",
      phase(async (field) => {
        const old = await original();
        const started = await native((tx) => amend(tx, old.eventId));
        const input = saveInput(started);
        const line = input.draft.items[0];
        if (!line) throw new Error("Expected retained line");
        if (field === "product") line.productId = randomUUID();
        if (field === "tlc") line.tlc = "REPLACEMENT";
        if (field === "source") line.source = { kind: "location", locationId: randomUUID() };
        await denied((tx) => save(tx, started.eventId, input), 409, "lot_identity_locked");
      }),
    );
    it(
      "denies native void of a real finalized downstream consumer without changing any table",
      phase(async () => {
        const downstream = await track(seedFinalizableTransformation(f));
        c = downstream;
        await track(
          downstream.store.finalize(
            c.tenant,
            c.actor,
            downstream.saved.id,
            downstream.command,
            "downstream",
          ),
        );
        const before = await snapshot();
        await expect(native((tx) => voidCommand(tx, downstream.origin.id))).rejects.toMatchObject({
          status: 409,
          response: {
            code: "traceability_downstream_blocked",
            blockers: downstream.origin.snapshot.items
              .map((line) => ({
                lotId: line.lotId,
                eventId: downstream.saved.id,
                rootId: downstream.saved.id,
                revision: 1,
              }))
              .sort((a, b) => a.lotId.localeCompare(b.lotId)),
          },
        });
        expect(await snapshot()).toEqual(before);
      }),
    );

    it.each([
      ...kinds.flatMap((kind) =>
        [false, true].map((publicFirst) => [kind, publicFirst, true] as const),
      ),
      ...[false, true].map((publicFirst) => ["save", publicFirst, false] as const),
    ])(
      "drains equal public/native %s workers (public first: %s; changed: %s)",
      phase(async (kind, publicFirst, changed) => {
        const p = await prepare(kind, changed);
        const gate = await f.pool.connect();
        let workers: Promise<Awaited<ReturnType<typeof amend>>>[] = [];
        try {
          await gate.query("BEGIN");
          const pid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
            ?.pid;
          if (!pid) throw new Error("Expected owned barrier PID");
          await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            JSON.stringify(["us-receiving", c.tenant, `receiving.${kind}`, p.input.operationKey]),
          ]);
          async function waitFor(count: number) {
            await expect
              .poll(
                async () =>
                  (
                    await f.pool.query<{ count: number }>(
                      "WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT count(*)::int AS count FROM blocked",
                      [pid],
                    )
                  ).rows[0]?.count,
                { timeout: 5_000 },
              )
              .toBeGreaterThanOrEqual(count);
          }
          const nativeCall = () => native(p.execute);
          workers = [track(publicFirst ? p.publicCall() : nativeCall())];
          await waitFor(1);
          workers.push(track(publicFirst ? nativeCall() : p.publicCall()));
          const settled = Promise.allSettled(workers);
          await waitFor(2);
          await gate.query("ROLLBACK");
          const outcomes = await settled;
          expect(outcomes.map((outcome) => outcome.status)).toEqual([
            "fulfilled",
            publicFirst ? "rejected" : "fulfilled",
          ]);
          const [a, b] = outcomes;
          if (a?.status !== "fulfilled" || !b) throw new Error("Expected command winner");
          if (b.status === "rejected") {
            expect(b.reason).toMatchObject({
              cause: changed
                ? { code: "40001" }
                : {
                    code: "23505",
                    table: "receiving_operations",
                    constraint: "receiving_operations_tenant_id_command_operation_key_pk",
                  },
            });
            // The loser belongs to the caller: retry the entire transaction using a fresh
            // snapshot after draining both original workers. No native inner retry occurs.
            const before = await snapshot();
            expect(await nativeCall()).toEqual(a.value);
            expect(await snapshot()).toEqual(before);
          } else expect(a.value).toEqual(b.value);
          await exactOperation(a.value);
          expect(await audit(p.input.operationKey)).toHaveLength(changed ? 1 : 0);
        } finally {
          try {
            await gate.query("ROLLBACK");
          } finally {
            gate.release();
          }
          await Promise.allSettled(workers);
        }
      }),
    );

    it(
      "refuses reprovision after a real runner drain-hook timeout until prior work settles",
      phase(async () => {
        await witnessTimedOutReceivingPhase();
      }),
    );
  },
);
