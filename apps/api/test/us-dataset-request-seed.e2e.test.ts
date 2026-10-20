import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { UsDatasetRequestSeedStore } from "../src/modules/traceability/demo/us-dataset-request-seed";
import { createUsDatasetRequestFixture } from "./support/us-dataset-request-fixture";
import { readUsRequestPublishedState } from "../src/modules/traceability/requests/us-request-publication-read";
import { unzipSync } from "fflate";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import { UsRequestPrepareStore } from "../src/modules/traceability/requests/us-request-prepare";
import { createUsWorkerDatabaseTransport } from "./support/us-request-worker-fixture";
import { canonicalExportDigest } from "../src/modules/traceability/demo/us-demo-canonical";
import type {
  UsDatasetRequestResult,
  UsDatasetRequestUnitKey,
} from "../src/modules/traceability/demo/us-dataset-request-contract";

const base = process.env.US_TEST_DATABASE_URL;
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe.skipIf(!base)("owned dataset Request packages on PostgreSQL", () => {
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
  const store = () => new UsDatasetRequestSeedStore(f.db, f.services);
  const initialize = () => store().initialize(f.context, "request_scenario_a");
  async function stage(kind: "request" | "package") {
    const journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
    const header = await journal.read(f.context);
    if (!header) throw new Error("Missing owned header");
    return journal.readStage(f.context, header.id, "request_scenario_a", kind);
  }
  async function interrupt(kind: "request" | "package", event: "INSERT" | "UPDATE OF receipt") {
    await f.pool.query(
      "CREATE FUNCTION reject_request_stage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_request_stage_failure' USING ERRCODE='XX000'; END $$",
    );
    await f.pool.query(
      `CREATE TRIGGER reject_request_stage BEFORE ${event} ON traceability_demo_dataset_stages FOR EACH ROW WHEN (NEW.unit_key='request_scenario_a' AND NEW.stage='${kind}') EXECUTE FUNCTION reject_request_stage()`,
    );
    return async () => {
      await f.pool.query("DROP TRIGGER reject_request_stage ON traceability_demo_dataset_stages");
      await f.pool.query("DROP FUNCTION reject_request_stage()");
    };
  }
  async function pending(kind: "request" | "package", event: "INSERT" | "UPDATE OF receipt") {
    const remove = await interrupt(kind, event);
    try {
      await expect(initialize()).rejects.toMatchObject({ cause: { code: "XX000" } });
    } finally {
      await remove();
    }
  }
  async function unchangedRejection() {
    const before = await f.snapshot(),
      writes = f.writes();
    await expect(initialize()).rejects.toThrow();
    await expect(store().verify(f.context, "request_scenario_a")).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
    expect(f.writes()).toEqual(writes);
  }
  async function corrupt(
    table:
      | "trace_export_runs"
      | "trace_export_render_checkpoints"
      | "traceability_plan_versions"
      | "traceability_demo_dataset_stages",
    statement: string,
    params: unknown[] = [],
  ) {
    await f.pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    try {
      await f.pool.query(statement, params);
    } finally {
      await f.pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    }
  }
  function scenario<T>(
    title: string,
    prepare: () => Promise<T>,
    check: (value: T) => Promise<void>,
  ) {
    describe(title, () => {
      let value: T;
      beforeEach(async () => {
        const started = performance.now();
        value = await track(prepare());
        console.info(`Native scenario preparation: ${Math.round(performance.now() - started)}ms`);
      }, 60_000);
      it("verifies the complete bounded outcome", () => track(check(value)));
    });
  }
  beforeEach(async () => {
    if (!base) throw new Error("Missing synthetic database");
    await track(
      createUsDatasetRequestFixture(base).then((value) => {
        f = value;
      }),
    );
    console.info(`Owned Request dataset database: ${f.databaseName}`);
  }, 60_000);
  afterEach(async () => {
    while (work.size) await Promise.allSettled([...work]);
    if (f) await f.close();
  }, 60_000);
  describe("actual publication and replay", () => {
    let ready: UsDatasetRequestResult;
    beforeEach(async () => {
      const started = performance.now();
      ready = await track(initialize());
      console.info(`Request initialize phase: ${Math.round(performance.now() - started)}ms`);
    }, 60_000);
    it("publishes actual Ready bytes and an exact ZIP, then replays without writes", () =>
      track(
        (async () => {
          const store = new UsDatasetRequestSeedStore(f.db, f.services);
          const result = ready;
          expect(result).toMatchObject({
            state: "request_package_verified",
            datasetComplete: false,
          });
          const published = await f.db.transaction((tx) =>
            readUsRequestPublishedState(tx, f.context.tenantId, result.run.id),
          );
          expect(published.run.status).toBe("ready");
          expect(published.run.planVersionId).toBe(f.ownedPlan.plan.id);
          expect(published.expectation.manifest.findingsSummary).toEqual({
            validation: { error: 0, warning: 0, info: 6 },
            render: { error: 0, warning: 0, info: 12 },
          });
          const objects = new Map<string, Buffer>();
          for (const descriptor of published.artifacts) {
            const bytes = await f.packages.store.readVerified(
              { tenantId: f.context.tenantId, runId: result.run.id },
              descriptor,
            );
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(descriptor.sha256);
            objects.set(descriptor.name, bytes);
          }
          const zip = objects.get("package.zip");
          if (!zip) throw new Error("Missing published ZIP");
          const entries = unzipSync(zip);
          expect(Object.keys(entries).sort()).toEqual(
            published.expectation.entries.map((e) => e.name).sort(),
          );
          for (const entry of published.expectation.entries) {
            const bytes = entries[entry.name];
            if (!bytes) throw new Error("Missing ZIP entry");
            expect(bytes.length).toBe(entry.byteSize);
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
          }
          const before = await f.snapshot(),
            writes = f.writes();
          expect(await store.initialize(f.context, "request_scenario_a")).toEqual(result);
          expect(await store.verify(f.context, "request_scenario_a")).toEqual(result);
          expect(await f.snapshot()).toEqual(before);
          expect(f.writes()).toEqual(writes);
        })(),
      ));
  });
  it("rolls back Request, exact create audit and pending identity together", () =>
    track(
      (async () => {
        const before = await f.snapshot(),
          writes = f.writes();
        await pending("request", "INSERT");
        expect(await f.snapshot()).toEqual(before);
        expect(f.writes()).toEqual(writes);
        expect(await stage("request")).toBeNull();
      })(),
    ));
  scenario(
    "rolls back run, prepare audit and package identity together",
    async () => {
      await pending("package", "INSERT");
      return { before: await f.snapshot(), writes: f.writes() };
    },
    async ({ before, writes }) => {
      expect(await f.db.select().from(schema.traceExportRuns)).toEqual([]);
      expect(await stage("package")).toBeNull();
      expect((await stage("request"))?.receipt).toBeTruthy();
      expect(
        (
          await f.pool.query(
            "SELECT id FROM tenant_audit_events WHERE action='traceability.request.prepared'",
          )
        ).rows,
      ).toEqual([]);
      expect(f.packages.objects.size).toBe(0);
      expect(await f.snapshot()).toEqual(before);
      expect(f.writes()).toEqual(writes);
    },
  );
  scenario(
    "resumes a rolled-back package preparation",
    async () => {
      await pending("package", "INSERT");
      return initialize();
    },
    async (result) => {
      expect(result.state).toBe("request_package_verified");
      expect(await f.db.select().from(schema.traceRequests)).toHaveLength(1);
      expect(await f.db.select().from(schema.traceExportRuns)).toHaveLength(1);
    },
  );
  scenario(
    "rejects pending source drift before revalidation or preparation",
    async () => {
      await pending("request", "UPDATE OF receipt");
      await f.pool.query("UPDATE traceability_lots SET revision=revision+1 WHERE tenant_id=$1", [
        f.context.tenantId,
      ]);
    },
    async () => {
      await unchangedRejection();
      expect(await f.db.select().from(schema.traceExportRuns)).toEqual([]);
    },
  );
  scenario(
    "keeps retry-scheduled runs incomplete and resumes only through native policy",
    async () => {
      f.packages.faults.before = async (command) => {
        if (command instanceof PutObjectCommand)
          throw { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } };
      };
      await expect(initialize()).rejects.toThrow("us_dataset_request_incomplete");
      const [queued] = await f.db.select().from(schema.traceExportRuns);
      if (!queued?.nextAttemptAt) throw new Error("Missing native retry schedule");
      expect(queued.status).toBe("queued");
      expect((await stage("package"))?.receipt).toBeNull();
      f.packages.faults.before = null;
      const transport = createUsWorkerDatabaseTransport(f.db);
      await transport.advancePast(queued.nextAttemptAt);
      const result = await new UsDatasetRequestSeedStore(transport.db, f.services).initialize(
        f.context,
        "request_scenario_a",
      );
      return { queued, result };
    },
    async ({ queued, result }) => {
      expect(result.run.id).toBe(queued.id);
      expect(result.run.scopedContentDigest).toBe(queued.scopedContentDigest);
      expect(await f.db.select().from(schema.traceExportAttempts)).toHaveLength(2);
      expect((await stage("package"))?.receipt).toBeTruthy();
    },
  );
  for (const kind of ["request", "package"] as const)
    scenario(
      `resumes ${kind} pending receipt without renewing receipt time`,
      async () => {
        await pending(kind, "UPDATE OF receipt");
        const before = await f.db.select().from(schema.traceRequests);
        expect(before).toHaveLength(1);
        const request = before[0];
        if (!request) throw new Error("Missing request");
        const pendingStage = await stage(kind);
        expect(pendingStage?.receipt).toBeNull();
        const puts = f.packages.calls.filter((c) => c.kind === "put").length;
        const result = await initialize();
        return { request, result, pendingStage, puts };
      },
      async ({ request, result, pendingStage, puts }) => {
        expect(result.request).toEqual({
          id: request.id,
          revision: request.revision,
          receivedAt: request.receivedAt.toISOString(),
          dueAt: request.dueAt.toISOString(),
        });
        expect(Date.parse(result.request.dueAt) - Date.parse(result.request.receivedAt)).toBe(
          86_400_000,
        );
        expect((await stage(kind))?.intent).toEqual(pendingStage?.intent);
        if (kind === "package")
          expect(f.packages.calls.filter((c) => c.kind === "put")).toHaveLength(puts);
      },
    );
  for (const target of ["request", "run"] as const)
    scenario(
      `recovers committed ${target} reply loss before receipt using owned identity`,
      async () => {
        const transport = createUsWorkerDatabaseTransport(f.db);
        transport.faultCommit("commit", (text) =>
          text.includes(
            `insert into "${target === "request" ? "trace_requests" : "trace_export_runs"}"`,
          ),
        );
        await expect(
          new UsDatasetRequestSeedStore(transport.db, f.services).initialize(
            f.context,
            "request_scenario_a",
          ),
        ).rejects.toMatchObject({ cause: { code: "08007" } });
        expect(
          transport.statements.filter((s) => s.outcome === "committed_reply_lost"),
        ).toHaveLength(1);
        const owned = await stage(target === "request" ? "request" : "package");
        expect(owned?.receipt).toBeNull();
        const rows = await f.db.select().from(schema.traceRequests);
        const original = rows[0];
        if (!original) throw new Error("Missing committed request");
        const result = await initialize();
        return { result, original, owned };
      },
      async ({ result, original, owned }) => {
        expect(result.request.id).toBe(original.id);
        expect(result.request.receivedAt).toBe(original.receivedAt.toISOString());
        expect(result.request.dueAt).toBe(original.dueAt.toISOString());
        expect((await stage(target === "request" ? "request" : "package"))?.intent).toEqual(
          owned?.intent,
        );
        expect(await f.db.select().from(schema.traceRequests)).toHaveLength(1);
        expect(await f.db.select().from(schema.traceExportRuns)).toHaveLength(1);
      },
    );
  scenario(
    "recovers committed final publication receipt reply loss with zero subsequent writes",
    async () => {
      await pending("package", "UPDATE OF receipt");
      const transport = createUsWorkerDatabaseTransport(f.db);
      transport.faultCommit("commit", (text) =>
        text.startsWith('update "traceability_demo_dataset_stages"'),
      );
      await expect(
        new UsDatasetRequestSeedStore(transport.db, f.services).initialize(
          f.context,
          "request_scenario_a",
        ),
      ).rejects.toMatchObject({ cause: { code: "08007" } });
      expect(transport.statements.filter((s) => s.outcome === "committed_reply_lost")).toHaveLength(
        1,
      );
      expect((await stage("package"))?.receipt).toBeTruthy();
      return { before: await f.snapshot(), writes: f.writes() };
    },
    async ({ before, writes }) => {
      const result = await initialize();
      expect(await store().verify(f.context, "request_scenario_a")).toEqual(result);
      expect(await f.snapshot()).toEqual(before);
      expect(f.writes()).toEqual(writes);
    },
  );
  it("denies unowned duplicate Request numbers without adopting any row", () =>
    track(
      (async () => {
        const request = await new UsRequestStore(f.db).create(
          f.context.tenantId,
          f.context.actorUserId,
          {
            requestNumber: "REQ-2026-APPLE-001",
            requesterName: "Unowned synthetic request",
            requesterOrganization: null,
            requesterContact: null,
            receivedAt: new Date().toISOString(),
            scope: null,
          },
        );
        await unchangedRejection();
        expect(await stage("request")).toBeNull();
        expect((await f.db.select().from(schema.traceRequests)).map((r) => r.id)).toEqual([
          request.id,
        ]);
      })(),
    ));
  it("denies same-TLC foreign-source injection without filtering or adopting it", () =>
    track(
      (async () => {
        const [lot] = await f.db.select().from(schema.traceabilityLots).limit(1);
        if (!lot) throw new Error("Missing owned lot");
        const foreign = await new UsLotStore(f.db).createLot(
          f.context.tenantId,
          f.context.actorUserId,
          {
            productId: lot.productId,
            tlc: lot.tlc,
            assignmentBasis: "imported",
            source: null,
          },
          randomUUID(),
        );
        expect(foreign.id).not.toBe(lot.id);
        await unchangedRejection();
        expect(await stage("request")).toBeNull();
      })(),
    ));
  it("rejects malformed/accessor unit selectors before provider access", () =>
    track(
      (async () => {
        let called = false;
        const accessor = Object.defineProperty({}, "unitKey", {
          enumerable: true,
          get() {
            called = true;
            throw new Error("getter invoked");
          },
        });
        const before = await f.snapshot(),
          calls = f.plan.transport.calls.length;
        for (const raw of [
          "request_other",
          null,
          accessor,
          { unitKey: "request_scenario_a", scope: {} },
        ]) {
          await expect(
            store().initialize(f.context, raw as UsDatasetRequestUnitKey),
          ).rejects.toThrow();
        }
        expect(called).toBe(false);
        expect(await f.snapshot()).toEqual(before);
        expect(f.plan.transport.calls).toHaveLength(calls);
        expect(f.packages.calls).toEqual([]);
      })(),
    ));
  it("denies wrong tenant, actor and database target before selector access", () =>
    track(
      (async () => {
        let called = false;
        const raw = Object.defineProperty({}, "unitKey", {
          enumerable: true,
          get() {
            called = true;
          },
        });
        const before = await f.snapshot(),
          calls = f.plan.transport.calls.length;
        for (const context of [
          { ...f.context, tenantId: randomUUID() },
          { ...f.context, actorUserId: randomUUID() },
          { ...f.context, expectedDatabaseName: "markiro_us_wrong_target" },
        ])
          await expect(store().initialize(context, raw as UsDatasetRequestUnitKey)).rejects.toThrow(
            "us_dataset_target_invalid",
          );
        expect(called).toBe(false);
        expect(await f.snapshot()).toEqual(before);
        expect(f.plan.transport.calls).toHaveLength(calls);
      })(),
    ));
  it("denies a revoked original owner without writes", () =>
    track(
      (async () => {
        await f.pool.query(
          "UPDATE member SET role='viewer' WHERE organization_id=$1 AND user_id=$2",
          [f.context.tenantId, f.context.actorUserId],
        );
        await unchangedRejection();
      })(),
    ));
  scenario(
    "leaves an unrelated queued native run exactly unchanged",
    async () => {
      const [lot] = await f.db.select().from(schema.traceabilityLots).limit(1);
      if (!lot) throw new Error("Missing source");
      const other = await new UsRequestStore(f.db).create(
        f.context.tenantId,
        f.context.actorUserId,
        {
          requestNumber: "UNRELATED-001",
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
      const queued = await new UsRequestPrepareStore(f.db).prepare(
        f.context.tenantId,
        f.context.actorUserId,
        other.id,
        { mode: "export_ready", idempotencyKey: randomUUID() },
        f.services.execution.build,
      );
      await initialize();
      return queued;
    },
    async (queued) => {
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
        expect(await f.db.select().from(table).where(eq(table.runId, queued.id))).toEqual([]);
    },
  );
  scenario(
    "concurrent initializers retain one identity and let only native lease publication win",
    async () => {
      const entered = deferred(),
        release = deferred();
      let gated = false;
      f.packages.faults.before = async (command) => {
        if (!gated && command instanceof PutObjectCommand) {
          gated = true;
          entered.resolve();
          await release.promise;
        }
      };
      const first = track(initialize());
      try {
        await Promise.race([
          entered.promise,
          first.then(() => {
            throw new Error("Worker completed without real PUT gate");
          }),
        ]);
        await expect(initialize()).rejects.toThrow("us_dataset_request_incomplete");
        expect(await f.db.select().from(schema.traceRequests)).toHaveLength(1);
        expect(await f.db.select().from(schema.traceExportRuns)).toHaveLength(1);
        expect(await f.db.select().from(schema.traceExportAttempts)).toHaveLength(1);
      } finally {
        release.resolve();
      }
      const result = await first;
      return result;
    },
    async (result) => {
      expect(await initialize()).toEqual(result);
      expect(await f.db.select().from(schema.traceExportAttempts)).toHaveLength(1);
    },
  );
  describe("completed ownership and corruption checks", () => {
    let result: UsDatasetRequestResult;
    beforeEach(async () => {
      result = await track(initialize());
    }, 60_000);
    it("freezes bounded public facts, fixed time and all nested descriptors", () =>
      track(
        (async () => {
          expect(Object.isFrozen(result)).toBe(true);
          expect(Object.isFrozen(result.request)).toBe(true);
          expect(Object.isFrozen(result.artifacts)).toBe(true);
          expect(result.artifacts.every(Object.isFrozen)).toBe(true);
          expect(JSON.stringify(result)).not.toContain("objectKey");
          expect(Buffer.byteLength(JSON.stringify((await stage("package"))?.receipt))).toBeLessThan(
            256 * 1024,
          );
          expect(Date.parse(result.request.dueAt) - Date.parse(result.request.receivedAt)).toBe(
            86_400_000,
          );
          expect(Date.parse(result.request.receivedAt)).toBeGreaterThan(Date.parse("2026-10-01"));
        })(),
      ));
    it.each(["missing", "corrupt"] as const)(
      "rejects %s published private bytes without replacement",
      (fault) =>
        track(
          (async () => {
            const [entry] = f.packages.objects.entries();
            if (!entry) throw new Error("Missing artifact");
            if (fault === "missing") f.packages.objects.delete(entry[0]);
            else
              f.packages.objects.set(entry[0], {
                ...entry[1],
                bytes: Buffer.alloc(entry[1].bytes.length),
              });
            await unchangedRejection();
          })(),
        ),
    );
    it("rejects corrupt owned Plan PDF without replacement", () =>
      track(
        (async () => {
          const [entry] = f.plan.objects.entries();
          if (!entry) throw new Error("Missing Plan");
          f.plan.objects.set(entry[0], Buffer.alloc(entry[1].length));
          await unchangedRejection();
        })(),
      ));
    it("rejects changed native Request body", () =>
      track(
        (async () => {
          await f.pool.query(
            "UPDATE trace_requests SET requester_name='Drifted synthetic requester' WHERE id=$1",
            [result.request.id],
          );
          await unchangedRejection();
        })(),
      ));
    it("rejects changed native source revision", () =>
      track(
        (async () => {
          await f.pool.query(
            "UPDATE traceability_lots SET revision=revision+1 WHERE tenant_id=$1",
            [f.context.tenantId],
          );
          await unchangedRejection();
        })(),
      ));
    it("rejects changed native effective Plan content", () =>
      track(
        (async () => {
          await corrupt(
            "traceability_plan_versions",
            "UPDATE traceability_plan_versions SET change_summary='Changed synthetic content' WHERE id=$1",
            [result.plan.id],
          );
          await unchangedRejection();
        })(),
      ));
    it("rejects changed native frozen run evidence", () =>
      track(
        (async () => {
          await corrupt(
            "trace_export_runs",
            "UPDATE trace_export_runs SET scoped_content_digest=$1 WHERE id=$2",
            ["b".repeat(64), result.run.id],
          );
          await unchangedRejection();
        })(),
      ));
    it("rejects a different execution checkpoint identity", () =>
      track(
        (async () => {
          await corrupt(
            "trace_export_render_checkpoints",
            "UPDATE trace_export_render_checkpoints SET execution_digest=$1 WHERE run_id=$2",
            ["b".repeat(64), result.run.id],
          );
          await unchangedRejection();
        })(),
      ));
    it("rejects altered exact Request creation audit ownership", () =>
      track(
        (async () => {
          await f.pool.query(
            "UPDATE tenant_audit_events SET request_id=$1 WHERE target_id=$2 AND action='traceability.request.created'",
            [randomUUID(), result.request.id],
          );
          await unchangedRejection();
        })(),
      ));
    it("rejects altered exact Prepare audit ownership", () =>
      track(
        (async () => {
          await f.pool.query(
            "UPDATE tenant_audit_events SET request_id=$1 WHERE target_id=$2 AND action='traceability.request.prepared'",
            [randomUUID(), result.request.id],
          );
          await unchangedRejection();
        })(),
      ));
    it("rechecks completed Request ownership after private reads", () =>
      track(
        (async () => {
          let mutated = false;
          f.packages.faults.after = async (command, response) => {
            if (!mutated && command instanceof GetObjectCommand) {
              mutated = true;
              await f.pool.query(
                "UPDATE trace_requests SET requester_name='Changed during verification' WHERE id=$1",
                [result.request.id],
              );
            }
            return response;
          };
          const writes = f.writes();
          await expect(store().verify(f.context, "request_scenario_a")).rejects.toThrow();
          expect(mutated).toBe(true);
          expect(f.writes()).toEqual(writes);
        })(),
      ));
  });
  describe("final journal guard", () => {
    beforeEach(async () => {
      await track(pending("package", "UPDATE OF receipt"));
    }, 60_000);
    it("rechecks the actual Request journal receipt after private I/O before final receipt", () =>
      track(
        (async () => {
          let mutated = false;
          f.packages.faults.after = async (command, response) => {
            if (!mutated && command instanceof GetObjectCommand) {
              mutated = true;
              const requestStage = await stage("request");
              if (!requestStage?.receipt) throw new Error("Missing owned request receipt");
              const result = { changed: true };
              const receipt = {
                ...requestStage.receipt,
                result,
                resultDigest: canonicalExportDigest(result),
              };
              await corrupt(
                "traceability_demo_dataset_stages",
                "UPDATE traceability_demo_dataset_stages SET receipt=$1::jsonb WHERE unit_key='request_scenario_a' AND stage='request'",
                [JSON.stringify(receipt)],
              );
              expect((await stage("request"))?.receipt).toEqual(receipt);
            }
            return response;
          };
          await expect(initialize()).rejects.toThrow();
          expect(mutated).toBe(true);
          expect((await stage("package"))?.receipt).toBeNull();
        })(),
      ));
  });
});
