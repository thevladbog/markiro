import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import type { UsTraceRequestCreateBody } from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as authorization from "../src/modules/traceability/master-data/us-master-data-support";
import {
  UsRequestStore,
  type UsRequestRow,
} from "../src/modules/traceability/requests/us-request-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedReceivingTenant } from "./support/us-receiving-fixture";
import { createUsRequestResourceTestScope } from "./support/us-request-resource-test-scope";

const url = process.env.US_TEST_DATABASE_URL;
const body: UsTraceRequestCreateBody = {
  requestNumber: "NATIVE-001",
  requesterName: "Synthetic native requester",
  requesterOrganization: null,
  requesterContact: "private-native@example.test",
  receivedAt: "2026-03-08T01:30:00-06:00",
  scope: { tlc: "Synthetic-001" },
};

describe.skipIf(!url)("US Request creation in caller-owned PostgreSQL transactions", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsRequestStore;
  let c: Awaited<ReturnType<typeof seedReceivingTenant>>;
  let childName: string;
  const work = createUsRequestResourceTestScope();
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    fixture = await createUsProfileTestDatabase(url);
    const identity = await fixture.pool.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    const name = identity.rows[0]?.name;
    if (!name) throw new Error("Missing owned child identity");
    childName = name;
    process.stdout.write(`Owned native Request child: ${childName}\n`);
    store = new UsRequestStore(fixture.db);
  }, 60_000);
  beforeEach(async () => {
    work.assertIdle();
    c = await seedReceivingTenant(fixture.db);
  });
  afterAll(async () => {
    await work.drain();
    work.assertIdle();
    await fixture?.close();
    if (url && childName) {
      const admin = createDb(url);
      try {
        expect(
          (await admin.pool.query("SELECT datname FROM pg_database WHERE datname=$1", [childName]))
            .rows,
        ).toEqual([]);
        process.stdout.write(`Owned native Request child absent: ${childName}\n`);
      } finally {
        await admin.pool.end();
      }
    }
  }, 60_000);
  const requests = (tenant = c.tenant) =>
    fixture.db.select().from(schema.traceRequests).where(eq(schema.traceRequests.tenantId, tenant));
  const audits = (tenant = c.tenant) =>
    fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, tenant));
  const audit = (
    targetId: string | null,
    outcome: string,
    after: unknown,
    requestId: string | null,
  ) => ({
    id: expect.any(String),
    createdAt: expect.any(Date),
    organizationId: c.tenant,
    actorUserId: c.actor,
    action: "traceability.request.created",
    outcome,
    targetType: "trace_request",
    targetId,
    before: null,
    after,
    requestId,
  });
  const native = (input: unknown = body, tenant = c.tenant, actor = c.actor) =>
    fixture.db.transaction((tx) => store.createCommandInTransaction(tx, tenant, actor, input));
  const fullState = async () => ({
    requests: await fixture.db.select().from(schema.traceRequests).orderBy(schema.traceRequests.id),
    audits: await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .orderBy(schema.tenantAuditEvents.id),
    runs: await fixture.db.select().from(schema.traceExportRuns).orderBy(schema.traceExportRuns.id),
    artifacts: await fixture.db
      .select()
      .from(schema.traceExportArtifacts)
      .orderBy(schema.traceExportArtifacts.id),
  });

  it(
    "commits generated identity, revision/open defaults, elapsed DST deadline and exact success audit together",
    work.phase(async () => {
      const row = await fixture.db.transaction((tx) =>
        store.createCommandInTransaction(tx, c.tenant, c.actor, body, "native-create-commit"),
      );
      expect(row.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(row).toEqual({
        id: row.id,
        tenantId: c.tenant,
        requestNumber: "NATIVE-001",
        requesterName: "Synthetic native requester",
        requesterOrganization: null,
        requesterContact: "private-native@example.test",
        receivedAt: new Date("2026-03-08T07:30:00.000Z"),
        dueAt: new Date("2026-03-09T07:30:00.000Z"),
        alternateDeadlineReason: null,
        scope: { tlc: "Synthetic-001" },
        revision: 1,
        status: "open",
        lastValidation: null,
        lastValidationDigest: null,
        lastValidatedAt: null,
        warningAckDigest: null,
        warningAckReason: null,
        warningAckAt: null,
        warningAckBy: null,
        createdBy: c.actor,
        closedAt: null,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
      expect(row.dueAt.getTime() - row.receivedAt.getTime()).toBe(86_400_000);
      expect(await requests()).toEqual([row]);
      expect(await audits()).toEqual([
        audit(
          row.id,
          "success",
          { revision: 1, status: "open", lastValidationDigest: null },
          "native-create-commit",
        ),
      ]);
    }),
  );

  it(
    "leaves commit and rollback to the owner, rolling back Request and audit after later failure",
    work.phase(async () => {
      const before = await fullState();
      const ownerFailure = new Error("Synthetic caller failure");
      await expect(
        fixture.db.transaction(async (tx) => {
          const row = await store.createCommandInTransaction(tx, c.tenant, c.actor, body);
          expect(
            await tx.select().from(schema.traceRequests).where(eq(schema.traceRequests.id, row.id)),
          ).toEqual([row]);
          expect(
            await tx
              .select()
              .from(schema.tenantAuditEvents)
              .where(eq(schema.tenantAuditEvents.organizationId, c.tenant)),
          ).toEqual([
            audit(
              row.id,
              "success",
              { revision: 1, status: "open", lastValidationDigest: null },
              null,
            ),
          ]);
          throw ownerFailure;
        }),
      ).rejects.toBe(ownerFailure);
      expect(await fullState()).toEqual(before);
    }),
  );

  it(
    "uses the shared explicit deadline policy and rolls invalid deadline back without outside audit",
    work.phase(async () => {
      await expect(native({ ...body, dueAt: "2026-03-10T07:30:00Z" })).rejects.toMatchObject({
        status: 400,
        response: { code: "us_request_alternate_reason_required" },
      });
      expect(await requests()).toEqual([]);
      expect(await audits()).toEqual([]);
      const row = await native({
        ...body,
        dueAt: "2026-03-10T07:30:00Z",
        alternateDeadlineReason: "Agreed synthetic extension",
      });
      expect(row.dueAt.toISOString()).toBe("2026-03-10T07:30:00.000Z");
      expect(row.alternateDeadlineReason).toBe("Agreed synthetic extension");
    }),
  );

  it.each(["foreign_actor", "nonmember", "readonly"] as const)(
    "reloads authorization before strict parsing for %s",
    work.phase(async (kind) => {
      let actor = c.actor;
      if (kind === "foreign_actor") actor = (await seedReceivingTenant(fixture.db)).actor;
      else if (kind === "nonmember")
        await fixture.db.delete(schema.member).where(eq(schema.member.id, c.member));
      else
        await fixture.db
          .update(schema.member)
          .set({ role: "traceability_auditor" })
          .where(eq(schema.member.id, c.member));
      const before = await fullState();
      await expect(native(null, c.tenant, actor)).rejects.toMatchObject({
        status: 403,
        response: { code: "insufficient_permission" },
      });
      expect(await fullState()).toEqual(before);
    }),
  );

  it.each(["missing", "unsupported", "invalid"] as const)(
    "reloads %s processor profile before strict parsing",
    work.phase(async (kind) => {
      await fixture.pool.query("ALTER TABLE traceability_profiles DISABLE TRIGGER USER");
      try {
        if (kind === "missing")
          await fixture.db
            .delete(schema.traceabilityProfiles)
            .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
        else
          await fixture.db
            .update(schema.traceabilityProfiles)
            .set(
              kind === "unsupported"
                ? { code: "US_GENERIC_LOT_TRACEABILITY" }
                : { baselineVersion: "synthetic-invalid" },
            )
            .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
      } finally {
        await fixture.pool.query("ALTER TABLE traceability_profiles ENABLE TRIGGER USER");
      }
      const before = await fullState();
      await expect(native(null)).rejects.toMatchObject({
        status: kind === "invalid" ? 503 : 403,
        response: {
          code:
            kind === "missing"
              ? "traceability_profile_required"
              : kind === "unsupported"
                ? "us_request_profile_unsupported"
                : "traceability_profile_invalid",
        },
      });
      expect(await fullState()).toEqual(before);
    }),
  );

  it.each([
    { id: randomUUID() },
    { tenantId: randomUUID() },
    { actorUserId: randomUUID() },
    { createdBy: randomUUID() },
    { revision: 2 },
    { status: "ready" },
    { lastValidation: { findings: [] } },
    { lastValidationDigest: "a".repeat(64) },
    { warningAckDigest: "a".repeat(64) },
    { runId: randomUUID() },
    { inputSnapshot: {} },
    { exportReady: true },
  ])(
    "rejects forged server-owned creation state %j",
    work.phase(async (forged) => {
      const before = await fullState();
      await expect(native({ ...body, ...forged })).rejects.toMatchObject({
        status: 400,
        response: { code: "invalid_master_data" },
      });
      expect(await fullState()).toEqual(before);
    }),
  );

  it(
    "propagates native tenant-number uniqueness once without mapping or an outside conflict audit",
    work.phase(async () => {
      const winner = await native();
      const before = await fullState();
      await fixture.pool.query("CREATE SEQUENCE native_duplicate_attempts");
      await fixture.pool.query(
        "CREATE FUNCTION count_native_duplicate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('native_duplicate_attempts'); RETURN NEW; END $$",
      );
      await fixture.pool.query(
        "CREATE TRIGGER count_native_duplicate BEFORE INSERT ON trace_requests FOR EACH ROW EXECUTE FUNCTION count_native_duplicate()",
      );
      try {
        await expect(native()).rejects.toMatchObject({
          cause: { code: "23505", constraint: "trace_requests_number_uq" },
        });
        expect(
          (
            await fixture.pool.query(
              "SELECT last_value::integer AS attempts FROM native_duplicate_attempts",
            )
          ).rows,
        ).toEqual([{ attempts: 1 }]);
        expect(await fullState()).toEqual(before);
      } finally {
        await fixture.pool.query("DROP TRIGGER count_native_duplicate ON trace_requests");
        await fixture.pool.query("DROP FUNCTION count_native_duplicate()");
        await fixture.pool.query("DROP SEQUENCE native_duplicate_attempts");
      }
      const other = await seedReceivingTenant(fixture.db);
      const otherRow = await native(body, other.tenant, other.actor);
      expect(otherRow.id).not.toBe(winner.id);
      expect(otherRow.tenantId).toBe(other.tenant);
    }),
  );

  it.each(["40001", "40P01", "P0001"])(
    "propagates real audit SQLSTATE %s on one native attempt with full-table rollback",
    work.phase(async (code) => {
      const before = await fullState();
      await fixture.pool.query("CREATE SEQUENCE native_request_attempts");
      await fixture.pool.query(
        `CREATE FUNCTION reject_native_request_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='traceability.request.created' THEN PERFORM nextval('native_request_attempts'); RAISE EXCEPTION 'synthetic native infrastructure failure' USING ERRCODE='${code}'; END IF; RETURN NEW; END $$`,
      );
      await fixture.pool.query(
        "CREATE TRIGGER reject_native_request_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_native_request_audit()",
      );
      try {
        await expect(native()).rejects.toMatchObject({ cause: { code } });
        expect(
          (
            await fixture.pool.query(
              "SELECT last_value::integer AS attempts FROM native_request_attempts",
            )
          ).rows,
        ).toEqual([{ attempts: 1 }]);
        expect(await fullState()).toEqual(before);
      } finally {
        await fixture.pool.query("DROP TRIGGER reject_native_request_audit ON tenant_audit_events");
        await fixture.pool.query("DROP FUNCTION reject_native_request_audit()");
        await fixture.pool.query("DROP SEQUENCE native_request_attempts");
      }
    }),
  );

  it(
    "retains public repeatable-read retry with one authorization reload for each of three attempts",
    work.phase(async () => {
      const authorize = vi.spyOn(authorization, "authorizeUsMasterData");
      await fixture.pool.query("CREATE SEQUENCE public_request_attempts");
      await fixture.pool.query(
        "CREATE FUNCTION retry_public_request_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('transaction_isolation') <> 'repeatable read' THEN RAISE EXCEPTION 'wrong public isolation'; END IF; IF NEW.action='traceability.request.created' AND nextval('public_request_attempts') < 3 THEN RAISE EXCEPTION 'synthetic retry' USING ERRCODE='40001'; END IF; RETURN NEW; END $$",
      );
      await fixture.pool.query(
        "CREATE TRIGGER retry_public_request_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION retry_public_request_audit()",
      );
      try {
        const row = await store.create(c.tenant, c.actor, body, "public-retry");
        expect(
          (
            await fixture.pool.query(
              "SELECT last_value::integer AS attempts FROM public_request_attempts",
            )
          ).rows,
        ).toEqual([{ attempts: 3 }]);
        expect(authorize).toHaveBeenCalledTimes(3);
        expect(await requests()).toEqual([row]);
        expect(await audits()).toEqual([
          audit(
            row.id,
            "success",
            { revision: 1, status: "open", lastValidationDigest: null },
            "public-retry",
          ),
        ]);
      } finally {
        authorize.mockRestore();
        await fixture.pool.query("DROP TRIGGER retry_public_request_audit ON tenant_audit_events");
        await fixture.pool.query("DROP FUNCTION retry_public_request_audit()");
        await fixture.pool.query("DROP SEQUENCE public_request_attempts");
      }
    }),
  );

  it(
    "retains public concurrent unique-number winner and exact correlated losing audit",
    work.phase(async () => {
      await fixture.pool.query(
        "CREATE FUNCTION gate_public_request_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(913204001); RETURN NEW; END $$",
      );
      await fixture.pool.query(
        "CREATE TRIGGER gate_public_request_insert BEFORE INSERT ON trace_requests FOR EACH ROW EXECUTE FUNCTION gate_public_request_insert()",
      );
      const blocker = await fixture.pool.connect();
      let pending: Promise<PromiseSettledResult<UsRequestRow>[]> | undefined;
      let results: PromiseSettledResult<UsRequestRow>[];
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(913204001)");
        const identity = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const pid = identity.rows[0]?.pid;
        if (!pid) throw new Error("Missing owned blocker PID");
        pending = Promise.allSettled(
          ["public-one", "public-two"].map((id) => store.create(c.tenant, c.actor, body, id)),
        );
        let concurrent = false;
        for (let probe = 0; probe < 100; probe++) {
          const state = await fixture.pool.query<{ blocked: number }>(
            "SELECT count(*)::integer AS blocked FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
            [pid],
          );
          if (state.rows[0]?.blocked === 2) {
            concurrent = true;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        expect(concurrent).toBe(true);
        await blocker.query("ROLLBACK");
        results = await pending;
      } finally {
        await blocker.query("ROLLBACK");
        await pending;
        blocker.release();
        await fixture.pool.query("DROP TRIGGER gate_public_request_insert ON trace_requests");
        await fixture.pool.query("DROP FUNCTION gate_public_request_insert()");
      }
      const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
      const winner = results[winnerIndex];
      if (!winner || winner.status !== "fulfilled") throw new Error("Missing unique-number winner");
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected")).toMatchObject({
        reason: { status: 409, response: { code: "us_request_number_conflict" } },
      });
      expect(await requests()).toEqual([winner.value]);
      expect(await audits()).toHaveLength(2);
      expect(await audits()).toEqual(
        expect.arrayContaining([
          audit(
            winner.value.id,
            "success",
            { revision: 1, status: "open", lastValidationDigest: null },
            winnerIndex === 0 ? "public-one" : "public-two",
          ),
          audit(
            null,
            "conflict",
            { code: "us_request_number_conflict" },
            winnerIndex === 0 ? "public-two" : "public-one",
          ),
        ]),
      );
    }),
  );
});
