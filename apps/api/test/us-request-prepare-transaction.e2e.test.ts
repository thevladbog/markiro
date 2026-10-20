import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsRequestPrepareStore } from "../src/modules/traceability/requests/us-request-prepare";
import { UsRequestStore } from "../src/modules/traceability/requests/us-request-store";
import { UsRequestValidationStore } from "../src/modules/traceability/requests/us-request-validation";
import { verifyUsRequestRunEvidence } from "../src/modules/traceability/requests/us-request-run-evidence";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";
import {
  finalizeUsRequestPayloadReceiving,
  seedUsRequestPayloadPlan,
} from "./support/us-request-payload-fixture";
import { createUsRequestResourceTestScope } from "./support/us-request-resource-test-scope";

const base = process.env.US_TEST_DATABASE_URL;
const build = { apiVersion: "test-native-prepare", gitSha: "a".repeat(40), dirty: false } as const;

describe.skipIf(!base)("US Request Prepare in caller-owned PostgreSQL transactions", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsRequestPrepareStore;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  let childName: string;
  const work = createUsRequestResourceTestScope();
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database URL");
    fixture = await createUsProfileTestDatabase(base);
    const identity = await fixture.pool.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    const name = identity.rows[0]?.name;
    if (!name) throw new Error("Missing owned child identity");
    childName = name;
    process.stdout.write(`Owned native Prepare child: ${childName}\n`);
    store = new UsRequestPrepareStore(fixture.db);
  }, 60_000);
  beforeEach(async () => {
    work.assertIdle();
    c = await seedCompleteReceiving(fixture.db);
  });
  afterAll(async () => {
    await work.drain();
    work.assertIdle();
    process.stdout.write(`Owned native Prepare work drained: ${childName}\n`);
    await fixture?.close();
    if (base && childName) {
      const admin = createDb(base);
      try {
        expect(
          (await admin.pool.query("SELECT datname FROM pg_database WHERE datname=$1", [childName]))
            .rows,
        ).toEqual([]);
        process.stdout.write(`Owned native Prepare child absent: ${childName}\n`);
      } finally {
        await admin.pool.end();
      }
    }
  }, 60_000);
  const prepareActions = ["traceability.request.prepared", "traceability.request.prepare_replayed"];
  const audits = () =>
    fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, c.tenant),
          inArray(schema.tenantAuditEvents.action, prepareActions),
        ),
      )
      .orderBy(schema.tenantAuditEvents.createdAt, schema.tenantAuditEvents.id);
  const state = async () => ({
    requests: await fixture.db.select().from(schema.traceRequests).orderBy(schema.traceRequests.id),
    runs: await fixture.db.select().from(schema.traceExportRuns).orderBy(schema.traceExportRuns.id),
    audits: await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .orderBy(schema.tenantAuditEvents.id),
    artifacts: await fixture.db
      .select()
      .from(schema.traceExportArtifacts)
      .orderBy(schema.traceExportArtifacts.id),
    organizations: await fixture.db
      .select()
      .from(schema.organization)
      .orderBy(schema.organization.id),
  });
  const preparedInput = async () => {
    const source = await finalizeUsRequestPayloadReceiving(fixture.db, c);
    const planId = await seedUsRequestPayloadPlan(fixture.db, c);
    const request = await new UsRequestStore(fixture.db).create(c.tenant, c.actor, {
      requestNumber: randomUUID(),
      requesterName: "Synthetic native Prepare requester",
      requesterOrganization: null,
      requesterContact: "private@example.test",
      receivedAt: "2026-10-04T00:00:00Z",
      scope: { lotId: c.lot },
    });
    const checked = await new UsRequestValidationStore(fixture.db).validate(
      c.tenant,
      c.actor,
      request.id,
      build,
    );
    return {
      request,
      source,
      planId,
      input: {
        expectedRevision: request.revision,
        validationDigest: checked.digest,
        idempotencyKey: randomUUID(),
        mode: "export_ready" as const,
      },
    };
  };
  const audit = (
    run: typeof schema.traceExportRuns.$inferSelect,
    replay: boolean,
    requestId: string | null,
  ) => ({
    id: expect.any(String),
    createdAt: expect.any(Date),
    organizationId: c.tenant,
    actorUserId: c.actor,
    requestId,
    action: replay ? "traceability.request.prepare_replayed" : "traceability.request.prepared",
    outcome: "success",
    targetType: "trace_request",
    targetId: run.requestId,
    before: null,
    after: {
      runId: run.id,
      revision: run.revision,
      ...(replay ? {} : { requestRevision: 1 }),
      mode: "export_ready",
      digest: run.scopedContentDigest,
      inputDigest: run.inputDigest,
    },
  });
  const native = (requestId: string, input: unknown, tenant = c.tenant, actor = c.actor) =>
    fixture.db.transaction((tx) =>
      store.prepareCommandInTransaction(tx, tenant, actor, requestId, input, build),
    );

  it(
    "rolls back the run, success audit and companion caller write without changing Request validation",
    work.phase(async () => {
      const { request, input } = await preparedInput();
      const before = await state();
      const callerFailure = new Error("Synthetic caller failure after Prepare");
      await expect(
        fixture.db.transaction(async (tx) => {
          await tx
            .update(schema.organization)
            .set({ name: "Synthetic caller transaction write" })
            .where(eq(schema.organization.id, c.tenant));
          const run = await store.prepareCommandInTransaction(
            tx,
            c.tenant,
            c.actor,
            request.id,
            input,
            build,
          );
          expect(
            await tx
              .select()
              .from(schema.traceExportRuns)
              .where(eq(schema.traceExportRuns.id, run.id)),
          ).toEqual([run]);
          expect(
            await tx
              .select()
              .from(schema.tenantAuditEvents)
              .where(
                and(
                  eq(schema.tenantAuditEvents.organizationId, c.tenant),
                  inArray(schema.tenantAuditEvents.action, prepareActions),
                ),
              ),
          ).toEqual([audit(run, false, null)]);
          throw callerFailure;
        }),
      ).rejects.toBe(callerFailure);
      expect(await state()).toEqual(before);
      expect(await audits()).toEqual([]);
    }),
  );

  it(
    "commits one queued frozen run and exact audits, then replays the saved identity and deadline",
    work.phase(async () => {
      const { request, input, planId } = await preparedInput();
      const before = await state();
      const run = await fixture.db.transaction((tx) =>
        store.prepareCommandInTransaction(
          tx,
          c.tenant,
          c.actor,
          request.id,
          input,
          build,
          "native-prepare-commit",
        ),
      );
      expect(run).toMatchObject({
        tenantId: c.tenant,
        requestId: request.id,
        revision: 1,
        mode: "export_ready",
        status: "queued",
        exportReady: false,
        createdBy: c.actor,
        idempotencyKey: input.idempotencyKey,
        scopedContentDigest: input.validationDigest,
        planVersionId: planId,
        planPdfSha256: "d".repeat(64),
        attemptCount: 0,
      });
      const frozen = verifyUsRequestRunEvidence(run, c.tenant);
      expect(frozen.validationSnapshot.request).toMatchObject({
        id: request.id,
        revision: 1,
        receivedAt: "2026-10-04T00:00:00.000Z",
        dueAt: "2026-10-05T00:00:00.000Z",
      });
      expect(frozen.validationSnapshot.plan?.id).toBe(planId);
      expect(frozen.validationSnapshot.sources.map((source) => source.type)).toEqual(["receiving"]);
      expect(
        frozen.validationSnapshot.selection.relations.some((line) => line.lotId === c.lot),
      ).toBe(true);
      expect(await audits()).toEqual([audit(run, false, "native-prepare-commit")]);
      const replay = await fixture.db.transaction((tx) =>
        store.prepareCommandInTransaction(
          tx,
          c.tenant,
          c.actor,
          request.id,
          input,
          build,
          "native-prepare-replay",
        ),
      );
      expect(replay).toEqual(run);
      const after = await state();
      expect(after.runs.filter((row) => row.tenantId === c.tenant)).toEqual([run]);
      expect(after.requests).toEqual(before.requests);
      expect(after.artifacts).toEqual(before.artifacts);
      expect(await audits()).toEqual([
        audit(run, false, "native-prepare-commit"),
        audit(run, true, "native-prepare-replay"),
      ]);
    }),
  );

  it.each([
    "extra_key",
    "null",
    "legacy_body",
    "bad_revision",
    "bad_digest",
    "bad_key",
    "bad_mode",
  ] as const)(
    "rejects strict malformed %s input without standalone rejection audit",
    work.phase(async (kind) => {
      const { request, input } = await preparedInput();
      const invalid: unknown =
        kind === "extra_key"
          ? { ...input, unexpected: true }
          : kind === "null"
            ? null
            : kind === "legacy_body"
              ? { mode: input.mode, idempotencyKey: input.idempotencyKey }
              : kind === "bad_revision"
                ? { ...input, expectedRevision: 0 }
                : kind === "bad_digest"
                  ? { ...input, validationDigest: "malformed" }
                  : kind === "bad_key"
                    ? { ...input, idempotencyKey: "malformed" }
                    : { ...input, mode: "ready" };
      const before = await state();
      await expect(native(request.id, invalid)).rejects.toMatchObject({
        status: 400,
        response: { code: "invalid_master_data" },
      });
      expect(await state()).toEqual(before);
    }),
  );

  it.each(["revision", "digest"] as const)(
    "rejects stale %s and rolls back a companion write without outside conflict audit",
    work.phase(async (kind) => {
      const { request, input } = await preparedInput();
      const before = await state();
      await expect(
        fixture.db.transaction(async (tx) => {
          await tx
            .update(schema.organization)
            .set({ name: "Synthetic rejected companion write" })
            .where(eq(schema.organization.id, c.tenant));
          return store.prepareCommandInTransaction(
            tx,
            c.tenant,
            c.actor,
            request.id,
            kind === "revision"
              ? { ...input, expectedRevision: 2 }
              : { ...input, validationDigest: "0".repeat(64) },
            build,
            "native-prepare-rejected",
          );
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code:
            kind === "revision" ? "us_request_revision_conflict" : "us_request_validation_stale",
        },
      });
      expect(await state()).toEqual(before);
    }),
  );

  it.each(["revision", "digest"] as const)(
    "binds idempotent replay to the original %s",
    work.phase(async (kind) => {
      const { request, input } = await preparedInput();
      await native(request.id, input);
      const before = await state();
      await expect(
        native(
          request.id,
          kind === "revision"
            ? { ...input, expectedRevision: 2 }
            : { ...input, validationDigest: "0".repeat(64) },
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: "us_request_idempotency_conflict" },
      });
      expect(await state()).toEqual(before);
    }),
  );

  it(
    "denies a foreign tenant's Request to an authorized owner without leaking an audit",
    work.phase(async () => {
      const { request, input } = await preparedInput();
      const foreign = await seedCompleteReceiving(fixture.db);
      const before = await state();
      await expect(native(request.id, input, foreign.tenant, foreign.actor)).rejects.toMatchObject({
        status: 404,
        response: { code: "us_request_not_found" },
      });
      expect(await state()).toEqual(before);
    }),
  );

  it.each(["new", "replay"] as const)(
    "reloads a revoked owner's role before parsing or preparing %s input",
    work.phase(async (kind) => {
      const { request, input } = await preparedInput();
      if (kind === "replay") await native(request.id, input);
      await fixture.db
        .update(schema.member)
        .set({ role: "traceability_auditor" })
        .where(eq(schema.member.id, c.member));
      const before = await state();
      await expect(native(request.id, kind === "new" ? null : input)).rejects.toMatchObject({
        status: 403,
        response: { code: "insufficient_permission" },
      });
      expect(await state()).toEqual(before);
    }),
  );

  it(
    "checks frozen run evidence before replay and leaves corrupt stored evidence untouched",
    work.phase(async () => {
      const { request, input } = await preparedInput();
      const run = await native(request.id, input);
      const corruptInput = { ...input, idempotencyKey: randomUUID() };
      await fixture.db.insert(schema.traceExportRuns).values({
        ...run,
        id: randomUUID(),
        revision: 2,
        idempotencyKey: corruptInput.idempotencyKey,
        scopedContentDigest: "0".repeat(64),
      });
      const before = await state();
      await expect(native(request.id, corruptInput)).rejects.toMatchObject({
        status: 503,
        response: { code: "us_request_run_stored_invalid" },
      });
      expect(await state()).toEqual(before);
    }),
  );
});
