import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { canonicalExportDigest, type UsPlanSections } from "@markiro/domain";
import type * as Domain from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsPlanStore } from "../src/modules/traceability/plans/us-plan-store";
import { UsPlanApprovalStore } from "../src/modules/traceability/plans/us-plan-approval";
import {
  UsPlanArtifactStore,
  type UsPlanArtifactS3Transport,
} from "../src/modules/traceability/plans/us-plan-artifacts";
import { loadUsPlanArtifactStorageConfig } from "../src/modules/traceability/plans/us-plan-artifact-config";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { UsDevelopmentOwnerStore } from "../src/deployment/us-development-owner";
import { renderUsPlanPdf } from "../src/modules/traceability/plans/us-plan-pdf";
import { parseUsPlanPublishedRow } from "../src/modules/traceability/plans/us-plan-published";
import type * as HistoricalPolicy from "../src/modules/traceability/plans/us-plan-historical-policy";

const policyDeployment = vi.hoisted(() => ({ v2: false }));
// Simulate a future deployment, including its explicitly registered v2 decoder.
// Historical v1 decoding always uses the real production implementation.
vi.mock("../src/modules/traceability/plans/us-plan-historical-policy", async (importOriginal) => {
  const original = await importOriginal<typeof HistoricalPolicy>();
  return {
    ...original,
    parseUsPlanHistoricalWorkflow(value: unknown) {
      if (
        policyDeployment.v2 &&
        value !== null &&
        typeof value === "object" &&
        "version" in value &&
        value.version === 2
      ) {
        return { ...original.parseUsPlanHistoricalWorkflow({ ...value, version: 1 }), version: 2 };
      }
      return original.parseUsPlanHistoricalWorkflow(value);
    },
  };
});
vi.mock("@markiro/domain", async (importOriginal) => {
  const original = await importOriginal<typeof Domain>();
  return {
    ...original,
    buildUsPlanSnapshot(...args: Parameters<typeof original.buildUsPlanSnapshot>) {
      const snapshot = original.buildUsPlanSnapshot(...args);
      if (policyDeployment.v2) snapshot.ftlReviewWorkflow.version = 2;
      return snapshot;
    },
    buildUsPlanDraftFactSources(...args: Parameters<typeof original.buildUsPlanDraftFactSources>) {
      const manifest = original.buildUsPlanDraftFactSources(...args);
      if (policyDeployment.v2) {
        for (const entry of manifest.entries) {
          if (entry.source.origin === "application_policy") entry.source.version = 2;
        }
      }
      return manifest;
    },
    buildUsPlanApprovedEvidence(...args: Parameters<typeof original.buildUsPlanApprovedEvidence>) {
      const [snapshot, manifest, authority] = args;
      const priorManifest = structuredClone(manifest);
      if (policyDeployment.v2) {
        for (const entry of priorManifest.entries) {
          if (entry.source.origin === "application_policy") entry.source.version = 1;
        }
      }
      const evidence = original.buildUsPlanApprovedEvidence(snapshot, priorManifest, authority);
      if (policyDeployment.v2) {
        for (const entry of evidence.factSources.entries) {
          if (entry.source.origin === "application_policy") entry.source.version = 2;
        }
      }
      return evidence;
    },
  };
});

const url = process.env.US_TEST_DATABASE_URL;
const confirmations = {
  procedures: true,
  backupAndRecovery: true,
  contact: true,
  nonFarmScope: true,
};
const sections: UsPlanSections = {
  recordMaintenance: {
    systemOfRecord: "Register",
    formats: ["PDF"],
    recordLocations: ["QA cabinet"],
    responsibleRoles: ["QA"],
    backupAndRecovery: "Operator reports backups",
    narrative: [],
  },
  ftlIdentification: { procedure: "Review FTL", reviewCadence: "On change" },
  tlcAssignment: { procedure: "Assign at processing" },
  pointOfContact: { name: "Example QA", title: "QA", phone: "+1 555 0100", email: null },
  farmActivity: { status: "no", explanation: "No farming" },
  reviewAndUpdate: { procedure: "Update on change" },
};

describe.skipIf(!url)("US plan atomic approval in owned disposable PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let drafts: UsPlanStore;
  let approvals: UsPlanApprovalStore;
  let tenant: string;
  let actor: string;
  let location: string;
  let onPut: (() => Promise<void>) | undefined;
  let putFailure: boolean;
  let deleteFailure: boolean;
  let realPdf: boolean;
  const objects = new Map<string, Buffer>();
  const deleted: string[] = [];
  const request = (versionId: string, idempotencyKey = randomUUID()) => ({
    versionId,
    expectedRevision: 1,
    idempotencyKey,
    confirmations,
  });
  const create = (value = sections, summary = "") =>
    drafts.createDraft(tenant, actor, { sections: value, changeSummary: summary }, "create");
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US test database");
    fixture = await createUsProfileTestDatabase(url);
    drafts = new UsPlanStore(fixture.db);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    policyDeployment.v2 = false;
    realPdf = false;
    tenant = randomUUID();
    actor = randomUUID();
    location = randomUUID();
    objects.clear();
    deleted.length = 0;
    onPut = undefined;
    putFailure = false;
    deleteFailure = false;
    await fixture.db
      .insert(schema.user)
      .values({ id: actor, name: "Synthetic QA", email: `${actor}@example.test` });
    await fixture.db
      .insert(schema.organization)
      .values({ id: tenant, name: "Example foods", slug: tenant, createdAt: new Date() });
    await fixture.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: tenant,
      userId: actor,
      role: "owner",
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId: tenant,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
    });
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId: tenant, timeZone: "America/Chicago" });
    const partyId = randomUUID();
    await fixture.db
      .insert(schema.traceabilityParties)
      .values({ id: partyId, tenantId: tenant, name: "Source" });
    await fixture.db.insert(schema.traceabilityLocations).values({
      id: location,
      tenantId: tenant,
      partyId,
      name: "Source",
      businessName: "Source",
      phoneNumber: "+1 555 0100",
      streetAddress: "10 Main",
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      roles: ["tlc_source"],
    });
    const config = loadUsPlanArtifactStorageConfig({
      NODE_ENV: "test",
      MARKIRO_DEPLOYMENT_EDITION: "US",
      US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
      US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
      US_PLAN_ARTIFACT_S3_BUCKET: "synthetic-plan-test",
      US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "synthetic",
      US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "synthetic",
      US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
    });
    if (!config) throw new Error("Missing fixture config");
    const transport: UsPlanArtifactS3Transport = {
      async send(command) {
        const key = command.input.Key ?? "";
        if (command.constructor.name === "PutObjectCommand") {
          if (!("Body" in command.input) || !(command.input.Body instanceof Uint8Array))
            throw new Error("Invalid fixture bytes");
          objects.set(key, Buffer.from(command.input.Body));
          await onPut?.();
          if (putFailure) throw new Error("Ambiguous put");
          return {};
        }
        if (command.constructor.name === "DeleteObjectCommand") {
          const fences = await fixture.pool.query(
            "SELECT state FROM traceability_plan_cleanup_fences WHERE tenant_id = $1 AND object_key = $2",
            [tenant, key],
          );
          expect(fences.rows).toEqual([{ state: "fenced" }]); // Must be committed, visible outside deletion transaction.
          const lock = await fixture.pool.connect();
          try {
            await lock.query("BEGIN");
            await lock.query("SELECT id FROM organization WHERE id=$1 FOR UPDATE NOWAIT", [tenant]);
            await lock.query("ROLLBACK");
          } finally {
            await lock.query("ROLLBACK");
            lock.release();
          }
          deleted.push(key);
          objects.delete(key);
          if (deleteFailure) throw new Error("Ambiguous delete");
          return {};
        }
        const bytes = objects.get(key);
        if (!bytes) throw Object.assign(new Error("Missing"), { name: "NoSuchKey" });
        return { Body: bytes, ContentLength: bytes.length, ContentType: "application/pdf" };
      },
    };
    approvals = new UsPlanApprovalStore(
      fixture.db,
      new UsPlanArtifactStore(config, transport),
      async (model) => {
        if (realPdf) return renderUsPlanPdf(model);
        const bytes = Buffer.from(JSON.stringify(model));
        return {
          bytes,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteSize: bytes.length,
          rendererVersion: "us-plan-pdf-v1",
        };
      },
      () => new Date("2026-10-03T01:00:00.000Z"),
    );
  });

  it("retains v1 detail, exact PDF, retries and supersession after a current-policy v2 deployment", async () => {
    realPdf = true;
    const firstDraft = await create();
    const input = request(firstDraft.id);
    const first = await approvals.approve(tenant, actor, input, "policy-v1");
    const bytes = await approvals.readPdf(tenant, actor, first.id, "v1-before");
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(first.evidence.snapshot.ftlReviewWorkflow.version).toBe(1);

    policyDeployment.v2 = true;
    expect(await approvals.getPublished(tenant, actor, first.id)).toEqual(first);
    expect(await approvals.readPdf(tenant, actor, first.id, "v1-after")).toEqual(bytes);
    expect(await approvals.approve(tenant, actor, input, "v1-retry")).toEqual(first);
    const nextDraft = await create(sections, "New application policy");
    const second = await approvals.approve(tenant, actor, request(nextDraft.id), "policy-v2");
    expect(second.evidence.snapshot.ftlReviewWorkflow.version).toBe(2);
    const retained = await approvals.getPublished(tenant, actor, first.id);
    expect(retained).toMatchObject({
      status: "superseded",
      evidence: first.evidence,
      artifact: first.artifact,
      configDigest: first.configDigest,
    });
    expect(await approvals.readPdf(tenant, actor, first.id, "v1-superseded")).toEqual(bytes);
    expect(await approvals.approve(tenant, actor, input, "v1-superseded-retry")).toEqual(first);
    expect(deleted).toEqual([]);
  }, 20_000);

  it("publishes frozen evidence, exact audit, same-key retry and immutable retained v1", async () => {
    const draft = await create();
    const input = request(draft.id);
    const first = await approvals.approve(tenant, actor, input, "approve-v1");
    expect(first).toMatchObject({
      id: draft.id,
      status: "effective",
      approvedBy: actor,
      approvedAt: "2026-10-03T01:00:00.000Z",
      retainThrough: null,
    });
    expect(first.evidence.snapshot.provenance).toBe("operational");
    const bytes = await approvals.readPdf(tenant, actor, draft.id, "download");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(first.artifact.sha256);
    expect(await approvals.approve(tenant, actor, input, "retry")).toEqual(first);
    await expect(
      approvals.approve(
        tenant,
        actor,
        { ...input, confirmations: { ...confirmations, contact: false } },
        "changed",
      ),
    ).rejects.toMatchObject({ response: { code: "us_plan_idempotency_conflict" } });
    await fixture.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed source" })
      .where(eq(schema.traceabilityLocations.id, location));
    const v2 = await create(
      { ...sections, pointOfContact: { ...sections.pointOfContact, name: "New QA" } },
      "Updated contact",
    );
    await approvals.approve(tenant, actor, request(v2.id), "approve-v2");
    const retained = await approvals.getPublished(tenant, actor, draft.id);
    expect(retained).toMatchObject({
      status: "superseded",
      retainThrough: "2031-10-02",
      evidence: first.evidence,
      artifact: first.artifact,
    });
    expect(await approvals.readPdf(tenant, actor, draft.id, "read-v1")).toEqual(bytes);
    expect(await approvals.approve(tenant, actor, input, "retry-superseded")).toEqual(first);
    expect(deleted).toEqual([]);
    const audits = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, "approve-v1"));
    expect(audits).toEqual([
      expect.objectContaining({
        organizationId: tenant,
        actorUserId: actor,
        requestId: "approve-v1",
        action: "traceability.plan.approved",
        outcome: "success",
        targetType: "traceability_plan_version",
        targetId: draft.id,
        before: { draftRevision: 1, versionNumber: 1 },
        after: {
          versionNumber: 1,
          draftRevision: 1,
          sha256: first.artifact.sha256,
          objectKey: first.artifact.objectKey,
          configDigest: first.configDigest,
        },
      }),
    ]);
  });

  it.each(["unknown", "yes"] as const)("blocks %s farm status before upload", async (status) => {
    const draft = await create({ ...sections, farmActivity: { status, explanation: "Scope" } });
    await expect(
      approvals.approve(tenant, actor, request(draft.id), "invalid"),
    ).rejects.toMatchObject({ response: { code: "us_plan_validation_failed" } });
    expect(objects.size).toBe(0);
  });
  it.each(["floor", "hold", "indefinite"])("preserves saved %s on supersession", async (kind) => {
    const draft = await create();
    await fixture.db
      .update(schema.traceabilityPlanVersions)
      .set({
        retentionFloor: kind === "floor" ? "2040-01-01" : null,
        holdUntil: kind === "hold" ? "2041-01-01" : null,
        indefiniteHold: kind === "indefinite",
      })
      .where(eq(schema.traceabilityPlanVersions.id, draft.id));
    await approvals.approve(tenant, actor, request(draft.id), "v1");
    const v2 = await create(sections, "New version");
    await approvals.approve(tenant, actor, request(v2.id), "v2");
    expect(await approvals.getPublished(tenant, actor, draft.id)).toMatchObject({
      retainThrough: kind === "indefinite" ? null : kind === "floor" ? "2040-01-01" : "2041-01-01",
      retentionIndefiniteReason: kind === "indefinite" ? "hold" : null,
    });
  });
  it.each(["same", "different"])(
    "serializes concurrent %s keys, retaining one winning object",
    async (kind) => {
      const draft = await create();
      const input = request(draft.id);
      let arrived = 0;
      let release: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      onPut = async () => {
        arrived++;
        if (arrived === 2) release();
        await barrier;
      };
      const results = await Promise.allSettled([
        approvals.approve(tenant, actor, input, "a"),
        approvals.approve(tenant, actor, kind === "same" ? input : request(draft.id), "b"),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(
        kind === "same" ? 2 : 1,
      );
      const winner = await approvals.getPublished(tenant, actor, draft.id);
      expect(objects.has(winner.artifact.objectKey)).toBe(true);
      expect(deleted).toHaveLength(1);
      expect(deleted).not.toContain(winner.artifact.objectKey);
    },
  );
  it("reloads role after upload and denies foreign versions without source disclosure", async () => {
    const draft = await create();
    await expect(
      approvals.approve(tenant, actor, request(randomUUID()), "foreign"),
    ).rejects.toMatchObject({ response: { code: "us_plan_version_not_found" } });
    onPut = async () => {
      await fixture.db
        .update(schema.member)
        .set({ role: "traceability_auditor" })
        .where(eq(schema.member.organizationId, tenant));
    };
    await expect(
      approvals.approve(tenant, actor, request(draft.id), "revoked"),
    ).rejects.toMatchObject({ response: { code: "insufficient_permission" } });
    expect(deleted).toHaveLength(1);
    expect((await drafts.getVersion(tenant, actor, draft.id, "read")).status).toBe("draft");
  });
  it.each(["confirmation", "source_missing", "source_incomplete", "wording"])(
    "blocks %s before upload",
    async (kind) => {
      const draft = await create(
        kind === "wording"
          ? { ...sections, tlcAssignment: { procedure: "FDA approved" } }
          : sections,
      );
      if (kind === "source_missing")
        await fixture.db
          .update(schema.traceabilityLocations)
          .set({ archived: true })
          .where(eq(schema.traceabilityLocations.id, location));
      if (kind === "source_incomplete")
        await fixture.db
          .update(schema.traceabilityLocations)
          .set({ phoneNumber: null })
          .where(eq(schema.traceabilityLocations.id, location));
      const input = request(draft.id);
      await expect(
        approvals.approve(
          tenant,
          actor,
          kind === "confirmation"
            ? { ...input, confirmations: { ...confirmations, procedures: false } }
            : input,
          "invalid",
        ),
      ).rejects.toMatchObject({ response: { code: "us_plan_validation_failed" } });
      expect(objects.size).toBe(0);
    },
  );
  it.each(["config", "draft"])(
    "rejects stale %s after render and durably fences cleanup",
    async (kind) => {
      const draft = await create();
      onPut = async () => {
        if (kind === "config")
          await fixture.db
            .update(schema.traceabilityLocations)
            .set({ phoneNumber: "+1 555 0199" })
            .where(eq(schema.traceabilityLocations.id, location));
        else
          await drafts.saveDraft(
            tenant,
            actor,
            draft.id,
            { sections, changeSummary: "Edit", expectedRevision: 1 },
            "edit",
          );
      };
      await expect(
        approvals.approve(tenant, actor, request(draft.id), "stale"),
      ).rejects.toMatchObject({
        response: {
          code: kind === "config" ? "us_plan_configuration_conflict" : "us_plan_revision_conflict",
        },
      });
      expect(deleted).toHaveLength(1);
      expect(objects.size).toBe(0);
      expect((await drafts.getVersion(tenant, actor, draft.id, "read")).status).toBe("draft");
    },
  );
  it("never deletes an uncertain upload and persists failed deletion's fence", async () => {
    const draft = await create();
    putFailure = true;
    await expect(
      approvals.approve(tenant, actor, request(draft.id), "put-failed"),
    ).rejects.toThrow();
    expect(deleted).toEqual([]);
    expect(objects.size).toBe(1);
    putFailure = false;
    deleteFailure = true;
    onPut = async () => {
      await fixture.db
        .update(schema.traceabilityLocations)
        .set({ businessName: "Changed" })
        .where(eq(schema.traceabilityLocations.id, location));
    };
    await expect(
      approvals.approve(tenant, actor, request(draft.id), "cleanup-failed"),
    ).rejects.toThrow();
    const fences = await fixture.pool.query(
      "SELECT state FROM traceability_plan_cleanup_fences WHERE tenant_id = $1",
      [tenant],
    );
    expect(fences.rows).toEqual([{ state: "fenced" }]);
    const cleanupAudits = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.action, "traceability.plan.artifact_cleanup"));
    expect(cleanupAudits.find((audit) => audit.requestId === "put-failed")).toMatchObject({
      outcome: "unconfirmed",
      after: { cleanupOutcome: "unresolved_upload" },
    });
    expect(cleanupAudits.find((audit) => audit.requestId === "cleanup-failed")).toMatchObject({
      outcome: "rejected",
      after: { cleanupOutcome: "retry_required" },
    });
    expect((await drafts.getVersion(tenant, actor, draft.id, "read")).status).toBe("draft");
  });

  it("rolls back publication and prior supersession if the success audit fails", async () => {
    const first = await create();
    const approved = await approvals.approve(tenant, actor, request(first.id), "v1");
    const second = await create(sections, "Update");
    await fixture.pool.query(
      "CREATE FUNCTION reject_approval_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'traceability.plan.approved' AND NEW.outcome = 'success' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$",
    );
    await fixture.pool.query(
      "CREATE TRIGGER reject_approval_audit BEFORE INSERT ON tenant_audit_events FOR EACH ROW EXECUTE FUNCTION reject_approval_audit()",
    );
    try {
      await expect(
        approvals.approve(tenant, actor, request(second.id), "rollback"),
      ).rejects.toThrow();
      expect(await approvals.getPublished(tenant, actor, first.id)).toEqual(approved);
      expect((await drafts.getVersion(tenant, actor, second.id, "read")).status).toBe("draft");
      expect(deleted).toHaveLength(1);
      expect(objects.has(approved.artifact.objectKey)).toBe(true);
    } finally {
      await fixture.pool.query("DROP TRIGGER reject_approval_audit ON tenant_audit_events");
      await fixture.pool.query("DROP FUNCTION reject_approval_audit()");
    }
  });

  it("never deletes a winner after an ambiguous COMMIT acknowledgement", async () => {
    const draft = await create();
    const input = request(draft.id);
    const original = fixture.db.transaction.bind(fixture.db);
    let injected = false;
    const spy = vi.spyOn(fixture.db, "transaction").mockImplementation(async (run, options) => {
      const result = await original(run, options);
      if (!injected && result && typeof result === "object" && "artifact" in result) {
        injected = true;
        throw new Error("Synthetic lost commit acknowledgement");
      }
      return result;
    });
    try {
      await expect(approvals.approve(tenant, actor, input, "ambiguous")).rejects.toThrow();
      expect(injected).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const published = await approvals.getPublished(tenant, actor, draft.id);
    expect(deleted).toEqual([]);
    expect(objects.has(published.artifact.objectKey)).toBe(true);
    expect(await approvals.approve(tenant, actor, input, "retry")).toEqual(published);
    const outcomes = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.requestId, "ambiguous"));
    expect(
      outcomes
        .filter((audit) => audit.action === "traceability.plan.approved")
        .map((audit) => audit.outcome)
        .sort(),
    ).toEqual(["success", "unconfirmed"]);
  });

  it("blocks known fenced keys at publication even in a fresh service instance", async () => {
    const draft = await create();
    onPut = async () => {
      const [key, bytes] = [...objects.entries()][0] ?? [];
      if (!key || !bytes) throw new Error("Missing upload");
      await fixture.db.insert(schema.traceabilityPlanCleanupFences).values({
        tenantId: tenant,
        versionId: draft.id,
        versionNumber: 1,
        actorUserId: actor,
        requestId: "restart",
        objectKey: key,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    };
    await expect(
      approvals.approve(tenant, actor, request(draft.id), "fenced"),
    ).rejects.toMatchObject({ response: { code: "us_plan_attempt_fenced" } });
    expect((await drafts.getVersion(tenant, actor, draft.id, "read")).status).toBe("draft");
    expect(deleted).toHaveLength(1);
  });

  it.each([
    "fence",
    "configuration",
    "product",
    "location",
    "timezone",
    "retention",
    "baseline",
  ] as const)(
    "sees a committed %s change after Phase B waits for the organization lock",
    async (kind) => {
      const draft = await create();
      const connect = () => fixture.pool.connect();
      let blocker: Awaited<ReturnType<typeof connect>> | undefined;
      const expectedCode =
        kind === "fence"
          ? "us_plan_attempt_fenced"
          : kind === "baseline"
            ? "traceability_profile_invalid"
            : "us_plan_configuration_conflict";
      let blockerPid: number | undefined;
      onPut = async () => {
        blocker = await connect();
        await blocker.query("BEGIN");
        const identity = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        blockerPid = identity.rows[0]?.pid;
        await blocker.query("SELECT id FROM organization WHERE id=$1 FOR UPDATE", [tenant]);
      };
      const resultPromise = approvals
        .approve(tenant, actor, request(draft.id), `lock-wait-${kind}`)
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      try {
        const deadline = Date.now() + 3000;
        let waiting = false;
        while (Date.now() < deadline) {
          if (blockerPid !== undefined) {
            const state = await fixture.pool.query<{ blocked: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked",
              [blockerPid],
            );
            if (state.rows[0]?.blocked) {
              waiting = true;
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        if (!blocker) throw new Error("Missing blocker");
        const [key, bytes] = [...objects.entries()][0] ?? [];
        if (!key || !bytes) throw new Error("Missing uploaded artifact");
        if (kind === "fence") {
          await blocker.query(
            "INSERT INTO traceability_plan_cleanup_fences(object_key,tenant_id,version_id,version_number,actor_user_id,request_id,sha256) VALUES($1,$2,$3,1,$4,'lock-wait-cleanup',$5)",
            [key, tenant, draft.id, actor, createHash("sha256").update(bytes).digest("hex")],
          );
        } else if (kind === "product") {
          const productId = randomUUID();
          await blocker.query(
            "INSERT INTO products(id,tenant_id,name) VALUES($1,$2,'Later product')",
            [productId, tenant],
          );
          await blocker.query(
            "INSERT INTO product_traceability_profiles(product_id,tenant_id,product_name) VALUES($1,$2,'Later product')",
            [productId, tenant],
          );
        } else if (kind === "location") {
          await blocker.query(
            "UPDATE traceability_locations SET archived=true WHERE tenant_id=$1 AND id=$2",
            [tenant, location],
          );
        } else if (kind === "timezone") {
          await blocker.query(
            "UPDATE org_profiles SET time_zone='America/New_York' WHERE tenant_id=$1",
            [tenant],
          );
        } else if (kind === "retention") {
          await blocker.query(
            "UPDATE traceability_profiles SET retention_years=7 WHERE tenant_id=$1",
            [tenant],
          );
        } else if (kind === "baseline") {
          await blocker.query(
            "UPDATE traceability_profiles SET baseline_version='US-REG-2026-10-03' WHERE tenant_id=$1",
            [tenant],
          );
        } else {
          await blocker.query(
            "UPDATE traceability_locations SET phone_number='+1 555 0199' WHERE tenant_id=$1 AND id=$2",
            [tenant, location],
          );
        }
        await blocker.query("COMMIT");
        if (kind === "fence") objects.delete(key);
        blocker.release();
        blocker = undefined;
        const result = await resultPromise;
        expect(result).toMatchObject({
          ok: false,
          error: {
            response: {
              code: expectedCode,
            },
          },
        });
        expect(
          (
            await fixture.pool.query(
              "SELECT status FROM traceability_plan_versions WHERE tenant_id=$1 AND id=$2",
              [tenant, draft.id],
            )
          ).rows,
        ).toEqual([{ status: "draft" }]);
        const audits = await fixture.db
          .select()
          .from(schema.tenantAuditEvents)
          .where(eq(schema.tenantAuditEvents.requestId, `lock-wait-${kind}`));
        expect(audits.filter((audit) => audit.action === "traceability.plan.approved")).toEqual([
          expect.objectContaining({
            organizationId: tenant,
            actorUserId: actor,
            targetId: draft.id,
            targetType: "traceability_plan_version",
            requestId: `lock-wait-${kind}`,
            before: null,
            action: "traceability.plan.approved",
            outcome: kind === "baseline" ? "unconfirmed" : "conflict",
            after: {
              code: expectedCode,
              versionNumber: 1,
              draftRevision: 1,
              objectKey: key,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          }),
        ]);
      } finally {
        if (blocker) {
          await blocker.query("ROLLBACK");
          blocker.release();
        }
        await resultPromise;
      }
    },
  );

  it("rejects tampered stored evidence and object bytes without rerendering", async () => {
    const draft = await create();
    const published = await approvals.approve(tenant, actor, request(draft.id), "approve");
    objects.set(published.artifact.objectKey, Buffer.from("changed"));
    await expect(approvals.readPdf(tenant, actor, draft.id, "bad-bytes")).rejects.toMatchObject({
      response: { code: "us_plan_artifact_read_failed" },
    });
    expect(
      await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.requestId, "bad-bytes")),
    ).toEqual([
      expect.objectContaining({
        organizationId: tenant,
        actorUserId: actor,
        targetType: "traceability_plan_version",
        targetId: draft.id,
        action: "traceability.plan.downloaded",
        requestId: "bad-bytes",
        outcome: "rejected",
        before: null,
        after: {
          code: "us_plan_artifact_read_failed",
          versionNumber: 1,
          sha256: published.artifact.sha256,
        },
      }),
    ]);
    await fixture.pool.query("ALTER TABLE traceability_plan_versions DISABLE TRIGGER USER");
    try {
      await fixture.db
        .update(schema.traceabilityPlanVersions)
        .set({ approvedEvidence: {} })
        .where(eq(schema.traceabilityPlanVersions.id, draft.id));
      await expect(approvals.getPublished(tenant, actor, draft.id)).rejects.toMatchObject({
        response: { code: "us_plan_stored_published_invalid" },
      });
    } finally {
      await fixture.pool.query("ALTER TABLE traceability_plan_versions ENABLE TRIGGER USER");
    }
  });
  it.each([
    "unknown_policy",
    "changed_policy",
    "missing_path",
    "duplicate_path",
    "extra_path",
    "wrong_policy_root",
    "wrong_policy_leaf",
    "wrong_actor",
    "wrong_time",
    "pending_source",
    "unknown_snapshot_schema",
    "unknown_evidence_schema",
    "duplicate_configured_id",
    "blank_approver",
  ])("rejects historical %s even with a matching snapshot digest", async (kind) => {
    const draft = await create();
    const published = await approvals.approve(tenant, actor, request(draft.id), "approve");
    const [stored] = await fixture.db
      .select()
      .from(schema.traceabilityPlanVersions)
      .where(eq(schema.traceabilityPlanVersions.id, draft.id));
    if (!stored) throw new Error("Missing published fixture");
    const row = structuredClone(stored);
    const evidence = structuredClone(published.evidence);
    const entries = evidence.factSources.entries;
    if (kind === "unknown_policy") evidence.snapshot.ftlReviewWorkflow.version = 99;
    if (kind === "changed_policy")
      evidence.snapshot.ftlReviewWorkflow.positiveCoverageStatuses = [];
    if (kind === "missing_path") entries.pop();
    if (kind === "duplicate_path")
      entries.push({ path: "/provenance", source: { origin: "configured" } });
    if (kind === "extra_path")
      entries.push({ path: "/not-a-fact", source: { origin: "configured" } });
    if (kind === "wrong_policy_root" || kind === "wrong_policy_leaf") {
      const entry = entries.find(
        ({ path }) =>
          path ===
          (kind === "wrong_policy_root" ? "/ftlReviewWorkflow" : "/ftlReviewWorkflow/version"),
      );
      if (!entry) throw new Error("Missing policy fixture");
      entry.source = { origin: "application_policy", version: 2 };
    }
    if (kind === "wrong_actor")
      evidence.confirmations.contact = {
        origin: "operator_confirmed",
        actorId: randomUUID(),
        confirmedAt: published.approvedAt,
      };
    if (kind === "wrong_time")
      evidence.confirmations.contact = {
        origin: "operator_confirmed",
        actorId: actor,
        confirmedAt: "2026-10-02T01:00:00.000Z",
      };
    if (kind === "pending_source") {
      const entry = entries.find(({ path }) => path === "/sections/pointOfContact/name");
      if (!entry) throw new Error("Missing contact fixture");
      entry.source = { origin: "operator_pending" };
    }
    if (kind === "duplicate_configured_id") {
      const source = evidence.snapshot.configured.tlcSourceLocations[0];
      if (!source) throw new Error("Missing source fixture");
      evidence.snapshot.configured.tlcSourceLocations.push(structuredClone(source));
    }
    if (kind === "blank_approver") {
      row.approvedBy = " ";
      for (const confirmation of Object.values(evidence.confirmations)) {
        if (confirmation.origin === "operator_confirmed") confirmation.actorId = " ";
      }
      for (const entry of entries) {
        if (entry.source.origin === "operator_confirmed") entry.source.actorId = " ";
      }
    }
    row.configSnapshot =
      kind === "unknown_snapshot_schema"
        ? { ...evidence.snapshot, schemaVersion: 2 }
        : evidence.snapshot;
    row.configDigest = canonicalExportDigest(row.configSnapshot);
    row.approvedEvidence =
      kind === "unknown_evidence_schema" ? { ...evidence, schemaVersion: 2 } : evidence;
    expect(() => parseUsPlanPublishedRow(row)).toThrow(
      expect.objectContaining({
        response: { code: "us_plan_stored_published_invalid" },
      }),
    );
  });
  it("rejects real foreign IDs with exact non-disclosing audit", async () => {
    const draft = await create();
    const other = randomUUID();
    await fixture.db
      .insert(schema.organization)
      .values({ id: other, name: "Other", slug: other, createdAt: new Date() });
    await fixture.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: other,
      userId: actor,
      role: "owner",
      createdAt: new Date(),
    });
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId: other,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
    });
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId: other, timeZone: "America/Chicago" });
    await expect(
      approvals.approve(other, actor, request(draft.id), "foreign-id"),
    ).rejects.toMatchObject({ response: { code: "us_plan_version_not_found" } });
    await expect(approvals.getPublished(other, actor, draft.id)).rejects.toMatchObject({
      response: { code: "us_plan_version_not_found" },
    });
    expect(
      await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.requestId, "foreign-id")),
    ).toEqual([
      {
        id: expect.any(String),
        createdAt: expect.any(Date),
        organizationId: other,
        actorUserId: actor,
        requestId: "foreign-id",
        action: "traceability.plan.approved",
        outcome: "rejected",
        targetType: "traceability_plan_version",
        targetId: draft.id,
        before: null,
        after: { code: "us_plan_version_not_found" },
      },
    ]);
    expect(objects.size).toBe(0);
  });
  it.each(["US_GENERIC_LOT_TRACEABILITY", "RU_CHZ"] as const)(
    "rejects unsupported %s profiles",
    async (code) => {
      const draft = await create();
      await fixture.pool.query("ALTER TABLE traceability_profiles DISABLE TRIGGER USER");
      try {
        await fixture.db
          .update(schema.traceabilityProfiles)
          .set({ code })
          .where(eq(schema.traceabilityProfiles.tenantId, tenant));
      } finally {
        await fixture.pool.query("ALTER TABLE traceability_profiles ENABLE TRIGGER USER");
      }
      await expect(
        approvals.approve(tenant, actor, request(draft.id), "profile"),
      ).rejects.toMatchObject({
        response: {
          code: code === "RU_CHZ" ? "traceability_profile_invalid" : "us_plan_profile_unsupported",
        },
      });
      expect(objects.size).toBe(0);
    },
  );
  it("uses exact trusted seed identity for synthetic evidence; copied narrative cannot bypass confirmations", async () => {
    const real = await create();
    await expect(
      approvals.approve(
        tenant,
        actor,
        {
          ...request(real.id),
          confirmations: {
            procedures: false,
            backupAndRecovery: false,
            contact: false,
            nonFarmScope: false,
          },
        },
        "real",
      ),
    ).rejects.toMatchObject({ response: { code: "us_plan_validation_failed" } });
    const seed = await new UsDevelopmentOwnerStore(fixture.db).provision(
      "synthetic-test-password",
      "seed",
    );
    tenant = seed.tenantId;
    actor = seed.userId;
    await fixture.db.insert(schema.traceabilityProfiles).values({
      tenantId: tenant,
      code: "US_FSMA204_PROCESSOR",
      baselineVersion: "US-REG-2026-09-03",
      retentionYears: 5,
    });
    await fixture.db
      .insert(schema.orgProfiles)
      .values({ tenantId: tenant, timeZone: "America/Chicago" });
    const partyId = randomUUID();
    await fixture.db
      .insert(schema.traceabilityParties)
      .values({ id: partyId, tenantId: tenant, name: "Source" });
    await fixture.db.insert(schema.traceabilityLocations).values({
      tenantId: tenant,
      partyId,
      name: "Source",
      businessName: "Source",
      phoneNumber: "+1 555 0100",
      streetAddress: "10 Main",
      city: "Chicago",
      stateOrRegion: "IL",
      zipOrPostalCode: "60601",
      countryCode: "US",
      roles: ["tlc_source"],
    });
    const draft = await create();
    const published = await approvals.approve(
      tenant,
      actor,
      {
        ...request(draft.id),
        confirmations: {
          procedures: false,
          backupAndRecovery: false,
          contact: false,
          nonFarmScope: false,
        },
      },
      "demo",
    );
    expect(published.evidence.snapshot.provenance).toBe("trusted_synthetic");
    expect(published.evidence.confirmations.procedures).toEqual({
      origin: "synthetic_fixture",
      trustedSeed: {
        seedId: tenant,
        verifiedBy: "us-development-owner-v1",
        verifiedAt: "2026-10-03T01:00:00.000Z",
      },
    });
    const bytes = await approvals.readPdf(tenant, actor, draft.id, "synthetic-v1-before");
    policyDeployment.v2 = true;
    expect(await approvals.getPublished(tenant, actor, draft.id)).toEqual(published);
    expect(await approvals.readPdf(tenant, actor, draft.id, "synthetic-v1-after")).toEqual(bytes);
  });
  it("requires change summary for v2 and uses current years with the frozen v1 timezone", async () => {
    const first = await create();
    await approvals.approve(tenant, actor, request(first.id), "v1");
    await fixture.db
      .update(schema.orgProfiles)
      .set({ timeZone: "Asia/Tokyo" })
      .where(eq(schema.orgProfiles.tenantId, tenant));
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ retentionYears: 2 })
      .where(eq(schema.traceabilityProfiles.tenantId, tenant));
    const second = await create();
    await expect(
      approvals.approve(tenant, actor, request(second.id), "no-summary"),
    ).rejects.toMatchObject({ response: { code: "us_plan_validation_failed" } });
    await drafts.saveDraft(
      tenant,
      actor,
      second.id,
      { expectedRevision: 1, sections, changeSummary: "Changed" },
      "edit",
    );
    await approvals.approve(tenant, actor, { ...request(second.id), expectedRevision: 2 }, "v2");
    expect(await approvals.getPublished(tenant, actor, first.id)).toMatchObject({
      retainThrough: "2028-10-02",
    });
  });
});
