import { ConflictException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import { productLabelValueDigest, type TaskGrant } from "@markiro/domain";
import type { GrantEvidenceEnvelope } from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  GrantEvidenceService,
  type EvidenceFact,
} from "../src/modules/device-grants/grant-evidence.service";
import { withEvidenceTransaction } from "../src/modules/device-grants/evidence-transaction";
import { createOrganization } from "./support/subscription-fixtures";
import { seedGrantPolicy } from "./support/grant-policy-fixture";

describe.skipIf(!process.env.DATABASE_URL)("durable evidence classification", () => {
  const connection = createDb(process.env.DATABASE_URL ?? "postgres://invalid");
  const db = connection.db;
  afterAll(() => connection.pool.end());
  async function fixture(mode: "observe" | "strict" = "strict") {
    const tenantId = await createOrganization(db),
      deviceId = randomUUID(),
      apiKeyId = randomUUID(),
      taskId = randomUUID();
    await db.insert(schema.apikey).values({
      id: apiKeyId,
      referenceId: tenantId,
      configId: "station",
      key: `test-${apiKeyId}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .insert(schema.stationDevices)
      .values({ id: deviceId, tenantId, name: "Evidence", apiKeyId });
    const owner = { tenantId, deviceId, kind: "station" as const, apiKeyId };
    const columns = {
      tenantId,
      stationDeviceId: deviceId,
      ownerKind: "station" as const,
      credentialEpoch: 1,
    };
    const policy = await seedGrantPolicy(db, {
      shift: { "shift.scan.v1": { maxEvents: 2, maxUnits: 2 } },
    });
    const now = Date.now(),
      sourceId = randomUUID();
    const grant: TaskGrant = {
      version: 1,
      issuer: "https://api.example.invalid",
      grantId: randomUUID(),
      ...owner,
      credentialEpoch: 1,
      kindOfGrant: "task",
      entitlementRevision: "fixture",
      policyRevision: policy.revision,
      issuedAt: now - 1000,
      notBefore: now - 1000,
      completeNotAfter: now + 1000,
      taskKind: "shift",
      taskId,
      snapshotDigest: "a".repeat(64),
      eventTypes: ["shift.scan.v1"],
      budget: [
        { id: "shift.scan.v1:events", unit: "event", maximum: 2 },
        { id: "shift.scan.v1:units", unit: "unit", maximum: 2 },
      ],
    };
    // Issuance is a trusted durable boundary; this test isolates receipt/owner
    // transactions from separately tested signing. Do not manufacture a public key.
    delete (grant as TaskGrant & { apiKeyId?: string }).apiKeyId;
    const compact = `e30.${Buffer.from(JSON.stringify(grant)).toString("base64url")}.AA`;
    await db.insert(schema.deviceGrantTaskSources).values({
      id: sourceId,
      ...columns,
      taskKind: "shift",
      taskId,
      snapshotDigest: grant.snapshotDigest,
      scope: { shiftId: taskId },
      eventTypes: grant.eventTypes,
      budget: grant.budget,
      policyId: policy.id,
      policyRevision: policy.revision,
    });
    await db.insert(schema.deviceGrantIssuances).values({
      grantId: grant.grantId,
      ...columns,
      kindOfGrant: "task",
      taskSourceId: sourceId,
      policyId: policy.id,
      policyRevision: policy.revision,
      entitlementRevision: "fixture",
      requestIdentity: randomUUID(),
      headerKid: "test",
      compactJws: compact,
      payloadDigest: productLabelValueDigest(grant),
      issuedAt: new Date(grant.issuedAt),
      completeNotAfter: new Date(grant.completeNotAfter),
    });
    await db.insert(schema.deviceGrantConfigurations).values({
      ...columns,
      mode,
      policyId: policy.id,
      policyRevision: policy.revision,
      decisionReference: "test-only",
    });
    let clock = now;
    const service = new GrantEvidenceService(db, () => clock);
    const envelope = (
      id: string = randomUUID(),
      event: string = randomUUID(),
    ): GrantEvidenceEnvelope => {
      const payload = { event, raw: "010123\u001d91AB" };
      return {
        protocol: "offline-grants-v1",
        batchId: id,
        payloadDigest: productLabelValueDigest(payload),
        payload,
        grants: [compact],
        eventGrants: { "/#shift.scan.v1": grant.grantId },
      };
    };
    const fact = (body: GrantEvidenceEnvelope): EvidenceFact => ({
      pointer: "/",
      eventType: "shift.scan.v1",
      taskKind: "shift",
      taskId,
      identity: String(body.payload.event),
      payload: body.payload,
      units: 1,
      matchesScope: (scope) => scope.shiftId === taskId,
    });
    const run = (body: GrantEvidenceEnvelope, failure = false) =>
      service.ingest(
        owner,
        "test-owner",
        body,
        undefined,
        (hook) =>
          db.transaction((tx) =>
            withEvidenceTransaction(tx, hook, async () => {
              await tx.insert(schema.tenantAuditEvents).values({
                organizationId: tenantId,
                actorUserId: null,
                action: "test.effect",
                outcome: "success",
                targetType: "test",
                targetId: String(body.payload.event),
              });
              if (failure) throw new Error("simulated owner crash");
              return { accepted: body.payload.event };
            }),
          ),
        async () => [fact(body)],
      );
    return {
      owner,
      columns,
      grant,
      now,
      run,
      envelope,
      fact,
      service,
      setClock: (value: number) => {
        clock = value;
      },
    };
  }
  it("commits one effect/cost/final receipt and returns exact lost-response replay", async () => {
    const f = await fixture(),
      body = f.envelope();
    const first = await f.run(body),
      duplicate = await f.run(body);
    expect(first).toMatchObject({
      outcome: "accepted",
      reason: null,
      reconciliation: { status: "applied", result: { accepted: body.payload.event } },
    });
    expect(duplicate).toEqual({ ...first, outcome: "duplicate" });
    expect(
      await db
        .select()
        .from(schema.deviceGrantEffects)
        .where(eq(schema.deviceGrantEffects.tenantId, f.owner.tenantId)),
    ).toHaveLength(1);
    const counters = await db
      .select()
      .from(schema.deviceGrantConsumption)
      .where(eq(schema.deviceGrantConsumption.tenantId, f.owner.tenantId));
    expect(counters.map((row) => row.consumed)).toEqual([1, 1]);
    expect(
      await db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, f.owner.tenantId),
            eq(schema.tenantAuditEvents.action, "test.effect"),
          ),
        ),
    ).toHaveLength(1);
  });
  it("retains quarantine at exact expiry without committing native effects", async () => {
    const f = await fixture();
    f.setClock(f.grant.completeNotAfter);
    const result = await f.run(f.envelope());
    expect(result).toMatchObject({
      outcome: "quarantined",
      reason: "completion_time_unproven",
      reconciliation: { status: "not_applied" },
    });
    expect(
      await db
        .select()
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, f.owner.tenantId),
            eq(schema.tenantAuditEvents.action, "test.effect"),
          ),
        ),
    ).toHaveLength(0);
  });
  it("preserves pending raw data across crash and resumes with the original receipt time", async () => {
    const f = await fixture(),
      body = f.envelope();
    await expect(f.run(body, true)).rejects.toThrow("simulated owner crash");
    const [pending] = await db
      .select()
      .from(schema.deviceGrantIngestReceipts)
      .where(eq(schema.deviceGrantIngestReceipts.tenantId, f.owner.tenantId));
    expect(pending?.finalResponse).toBeNull();
    expect(pending?.retainedPayload.payload).toEqual(body.payload);
    f.setClock(f.grant.completeNotAfter + 1000);
    expect(await f.run(body)).toMatchObject({ outcome: "accepted", receiptId: pending?.id });
  });
  it("rolls back over-budget native work and retains immutable quarantine", async () => {
    const f = await fixture();
    await f.run(f.envelope());
    await f.run(f.envelope());
    const body = f.envelope(),
      result = await f.run(body);
    expect(result).toMatchObject({ outcome: "quarantined", reason: "budget_exceeded" });
    expect(await f.run(body)).toEqual({ ...result, outcome: "duplicate" });
    await expect(
      db
        .update(schema.deviceGrantIngestReceipts)
        .set({ finalResponse: {} })
        .where(eq(schema.deviceGrantIngestReceipts.id, result.receiptId)),
    ).rejects.toThrow();
  });
  it("observe stores would-deny while preserving the native productive result", async () => {
    const f = await fixture("observe");
    f.setClock(f.grant.completeNotAfter);
    expect(await f.run(f.envelope())).toMatchObject({
      outcome: "accepted",
      reason: "completion_time_unproven",
      reconciliation: { status: "applied" },
    });
  });
  it("conflicts on changed payload or grants, denies revoked keys, and isolates tenants", async () => {
    const f = await fixture(),
      body = f.envelope();
    await f.run(body);
    const changed = f.envelope(body.batchId);
    await expect(f.run(changed)).rejects.toMatchObject({ status: 409 });
    const other = await fixture();
    await expect(
      f.service.ingest(
        { ...f.owner, tenantId: other.owner.tenantId },
        "test-owner",
        body,
        undefined,
        async () => ({}),
        async () => [],
      ),
    ).rejects.toMatchObject({ status: 401 });
    await db
      .update(schema.apikey)
      .set({ enabled: false })
      .where(eq(schema.apikey.id, f.owner.apiKeyId));
    await expect(f.run(body)).rejects.toMatchObject({ status: 401 });
  });
  it("serializes concurrent identical delivery and keeps one final audit", async () => {
    const f = await fixture(),
      body = f.envelope();
    const results = await Promise.all([f.run(body), f.run(body)]);
    expect(results.map((row) => row.outcome).sort()).toEqual(["accepted", "duplicate"]);
    expect(results[0]?.receiptId).toBe(results[1]?.receiptId);
    const audits = await db
      .select()
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, f.owner.tenantId),
          eq(schema.tenantAuditEvents.action, "device.grant.evidence"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: null,
      targetType: "device_grant_receipt",
      targetId: results[0]?.receiptId,
      outcome: "success",
      after: {
        tenantId: f.owner.tenantId,
        deviceId: f.owner.deviceId,
        receiptCredentialEpoch: 1,
        recoveredCredentialEpoch: 1,
        classification: "accepted",
        eventCount: 1,
        originalGrants: [{ grantId: f.grant.grantId, credentialEpoch: 1 }],
      },
    });
  });
  it("same-owner recovery retains old epoch provenance without resetting consumption", async () => {
    const f = await fixture();
    await f.run(f.envelope());
    const newKey = randomUUID();
    await db.insert(schema.apikey).values({
      id: newKey,
      referenceId: f.owner.tenantId,
      configId: "station",
      key: `test-${newKey}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(schema.stationDevices)
      .set({ apiKeyId: newKey })
      .where(eq(schema.stationDevices.id, f.owner.deviceId));
    f.owner.apiKeyId = newKey;
    expect(await f.run(f.envelope())).toMatchObject({ outcome: "accepted" });
    expect(await f.run(f.envelope())).toMatchObject({
      outcome: "quarantined",
      reason: "budget_exceeded",
    });
    const effects = await db
      .select()
      .from(schema.deviceGrantEffects)
      .where(eq(schema.deviceGrantEffects.tenantId, f.owner.tenantId));
    expect(effects.map((row) => row.credentialEpoch)).toEqual([1, 1]);
    const counters = await db
      .select()
      .from(schema.deviceGrantConsumption)
      .where(eq(schema.deviceGrantConsumption.tenantId, f.owner.tenantId));
    expect(counters.map((row) => row.consumed)).toEqual([2, 2]);
  });
  it("stores missing grant diagnostics in observe and quarantines them in strict", async () => {
    for (const mode of ["observe", "strict"] as const) {
      const f = await fixture(mode),
        body = f.envelope();
      body.grants = [];
      expect(await f.run(body)).toMatchObject({
        outcome: mode === "strict" ? "quarantined" : "accepted",
        reason: "grant_missing_or_unrecognized",
        reconciliation: { status: mode === "strict" ? "not_applied" : "applied" },
      });
    }
  });
  it("retains native permanent rejection separately from evidence acceptance", async () => {
    const f = await fixture(),
      body = f.envelope();
    const result = await f.service.ingest(
      f.owner,
      "rejecting-owner",
      body,
      undefined,
      async (hook) =>
        db.transaction((tx) =>
          withEvidenceTransaction(tx, hook, () =>
            Promise.reject(new ConflictException({ code: "NATIVE_CONFLICT" })),
          ),
        ),
      async () => [],
    );
    expect(result).toMatchObject({
      outcome: "accepted",
      reconciliation: { status: "rejected", statusCode: 409, result: { code: "NATIVE_CONFLICT" } },
    });
  });
  it("does not accept a borrowed same-tenant device grant", async () => {
    const f = await fixture(),
      body = f.envelope(),
      otherDevice = randomUUID(),
      key = randomUUID();
    await db.insert(schema.apikey).values({
      id: key,
      referenceId: f.owner.tenantId,
      configId: "station",
      key: `test-${key}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .insert(schema.stationDevices)
      .values({ id: otherDevice, tenantId: f.owner.tenantId, name: "Other", apiKeyId: key });
    const [configuration] = await db
      .select()
      .from(schema.deviceGrantConfigurations)
      .where(eq(schema.deviceGrantConfigurations.stationDeviceId, f.owner.deviceId));
    if (!configuration) throw new Error("fixture config missing");
    await db.insert(schema.deviceGrantConfigurations).values({
      ...configuration,
      id: randomUUID(),
      sequence: undefined,
      stationDeviceId: otherDevice,
    });
    const identity = { ...f.owner, deviceId: otherDevice, apiKeyId: key };
    const result = await f.service.ingest(
      identity,
      "other-owner",
      body,
      undefined,
      (hook) =>
        db.transaction((tx) => withEvidenceTransaction(tx, hook, () => Promise.resolve({}))),
      async () => [f.fact(body)],
    );
    expect(result).toMatchObject({
      outcome: "quarantined",
      reason: "grant_missing_or_unrecognized",
    });
  });
});
