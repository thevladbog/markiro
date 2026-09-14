import { upsertBundle } from "../src/lib/mirror.js";
import { readShiftExecutionProjection } from "../src/lib/offline-grants/semantic.js";
import { grantEvidenceEnvelopeSchema } from "@markiro/platform-contracts";
import { PRODUCT_LABEL_PROTOCOL } from "@markiro/domain";
import { createSyncEngine } from "../src/lib/sync.js";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openProductLabelWork } from "./support/product-label-work.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
} from "../src/lib/credential-recovery.js";
import { recordProductLabelAcceptanceWithOfflineGrant } from "../src/lib/product-labels/acceptance.js";
import { readStationChannelEvidence } from "../src/lib/offline-grants/scan-evidence.js";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));
async function fixture(exhaust: "scan" | "label" | null = null) {
  const generation = createCredentialGeneration("test-label-key");
  const owner = await credentialGenerationOwnership(generation);
  if (!owner) throw new Error("missing owner");
  const h = await openProductLabelWork("required", owner, false);
  cleanups.push(() => h.close());
  const [file] = await h.exec.all<{ file: string }>("PRAGMA database_list");
  if (!file) throw new Error("missing SQLite fixture");
  const held = new DatabaseSync(file.file);
  cleanups.push(() => held.close());
  const exec = {
    ...h.exec,
    async atomic(statements: readonly { sql: string; values?: readonly unknown[] }[]) {
      held.exec("BEGIN IMMEDIATE");
      try {
        const changes = statements.map((s) =>
          Number(held.prepare(s.sql).run(...((s.values ?? []) as never[])).changes),
        );
        held.exec("COMMIT");
        return changes;
      } catch (error) {
        held.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const value = h.input;
  const scope = {
    shift: {
      id: value.shiftId,
      productId: "product",
      mode: "validation",
      lineId: null,
      counterpartyId: null,
      counterpartyName: null,
      labelTemplateId: null,
      boxLabelTemplateId: null,
      palletLabelTemplateId: null,
      validationPrintMode: value.policy.mode,
      allowPreviouslyAcceptedCodes: false,
      validationPrintVerification: value.policy.verification,
      validationPrintTemplateId: value.policy.templateId,
      validationPrintSnapshot: value.policy.snapshot,
      validationPrintPolicyRevision: value.policy.policyRevision,
      boxCapacity: null,
      palletsEnabled: false,
      palletBoxCapacity: null,
      stationClosePolicy: null,
      stationCloseOwnerDeviceId: null,
      plannedDate: "2026-09-08",
      productionDate: "2026-09-08",
      number: value.fields["shift.no"],
    },
    product: {
      id: "product",
      gtin14: value.gtin14,
      name: value.fields["product.name"],
      printName: null,
      egaisCode: null,
      shelfLifeDays: 30,
    },
    templates: [],
  };
  await upsertBundle(exec, {
    shift: {
      ...scope.shift,
      status: "active",
      productName: scope.product.name,
      lineName: null,
      labelTemplateName: null,
      plannedQty: 20,
      openedAt: value.acceptedAt,
      validationPrint: value.policy,
      ssccIssuerCounterpartyId: null,
      createdFrom: "admin",
    },
    product: {
      ...scope.product,
      productGroup: null,
      boxCapacity: null,
      palletBoxCapacity: null,
      status: "active",
      defaultCounterpartyId: null,
      defaultLabelTemplateId: null,
    },
    labelTemplate: null,
    boxLabelTemplate: null,
    palletLabelTemplate: null,
    counterpartyGln: null,
    operators: [],
    sscc: null,
  });
  const published = await readShiftExecutionProjection(exec, value.shiftId);
  expect(published.scope.shift.allowPreviouslyAcceptedCodes).toBe(false);
  await exec.run(
    "INSERT INTO operators_mirror(operator_id,name,role,pin_hash,active) VALUES(?,?,?,?,1)",
    [value.operatorId, "Operator", "operator", "hash"],
  );
  await exec.run("INSERT INTO offline_grant_install_state VALUES(1,?,?,?,1,1,'strict')", [
    "tenant",
    value.deviceId,
    "station",
  ]);
  await exec.run("INSERT INTO offline_grant_clock VALUES(1,100,10,'boot',100,200)");
  const grantId = "11111111-1111-4111-8111-111111111111";
  const budget = ["shift.scan.v1", "shift.label.prepare.v1"].flatMap((type) => [
    { id: `${type}:events`, unit: "event", maximum: 1 },
    { id: `${type}:units`, unit: "unit", maximum: 1 },
  ]);
  const grant = {
    version: 1,
    kindOfGrant: "task",
    issuer: "https://issuer.invalid",
    grantId,
    tenantId: "tenant",
    deviceId: value.deviceId,
    kind: "station",
    credentialEpoch: 1,
    entitlementRevision: "entitlement",
    policyRevision: "policy",
    issuedAt: 50,
    notBefore: 50,
    taskKind: "shift",
    taskId: value.shiftId,
    snapshotDigest: "digest",
    completeNotAfter: 1000,
    eventTypes: ["shift.scan.v1", "shift.label.prepare.v1"],
    budget,
  };
  await exec.run("INSERT INTO offline_grant_grants VALUES(?,?,?,?,1,1)", [
    grantId,
    "kid",
    "original.compact.bytes",
    JSON.stringify(grant),
  ]);
  await exec.run("INSERT INTO offline_grant_snapshots VALUES('shift',?,'digest','canonical',?,1)", [
    value.shiftId,
    JSON.stringify({
      ...published.scope,
      shift: {
        ...published.scope.shift,
        numberMonthKey: "SEP26",
        numberSeq: 1,
        createdFrom: "admin",
      },
    }),
  ]);
  if (exhaust)
    await exec.run("INSERT INTO offline_grant_consumption VALUES(?,?,1,'shift',?,'digest',?,1)", [
      "tenant",
      value.deviceId,
      value.shiftId,
      `${exhaust === "scan" ? "shift.scan.v1" : "shift.label.prepare.v1"}:units`,
    ]);
  const accept = () =>
    recordProductLabelAcceptanceWithOfflineGrant(
      exec,
      value,
      createCredentialGeneration("test-label-key"),
      async () => ({ bootId: "boot", monotonicMs: 11, wallMs: 201 }),
    );
  return { h, exec, accept, grantId, generation };
}

describe("prepared label owns its accepted scan and print budget", () => {
  it("sends both actual native channels and repairs the validation receipt before exact queue ACK", async () => {
    const { h, exec, accept, grantId, generation } = await fixture();
    await accept();
    let interrupt = true;
    const interrupted = {
      ...exec,
      async atomic(statements: Parameters<typeof exec.atomic>[0]) {
        if (
          interrupt &&
          statements.some((statement) => statement.sql.startsWith("DELETE FROM outbox"))
        ) {
          interrupt = false;
          throw new Error("ACK response lost");
        }
        return exec.atomic(statements);
      },
    };
    const post = vi.fn().mockImplementation(async (path: string, value: unknown) => {
      if (path !== "/station/grants/v1/evidence/scans") return {};
      const body = grantEvidenceEnvelopeSchema.parse(value);
      return {
        protocol: "offline-grants-v1",
        batchId: body.batchId,
        outcome: "accepted",
        reason: null,
        receiptId: "22222222-2222-4222-8222-222222222222",
        reconciliation: {
          status: "applied",
          statusCode: 201,
          result: {
            applied: 1,
            alreadyApplied: false,
            productLabelReceipt: {
              protocol: PRODUCT_LABEL_PROTOCOL,
              acceptedEventIds: [h.input.preparedEvent.eventId],
              quarantined: [],
            },
            validationOccurrences: [
              {
                shiftId: h.input.shiftId,
                codeHash: h.input.codeHash,
                scannedAt: h.input.acceptedAt,
                outcome: "first_accepted",
              },
            ],
          },
        },
      };
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = createSyncEngine({
      exec: interrupted,
      client: { post },
      machineId: h.input.deviceId,
      credentialGeneration: generation,
      onState() {},
    });
    first.nudge();
    await first.idle();
    first.stop();
    expect(post.mock.calls[0]?.[0]).toBe("/station/grants/v1/evidence/scans");
    const envelope = grantEvidenceEnvelopeSchema.parse(post.mock.calls[0]?.[1]);
    expect(envelope.eventGrants).toEqual({
      "/items/0#shift.scan.v1": grantId,
      "/productLabelEvents/0#shift.label.prepare.v1": grantId,
    });
    expect(envelope.payload).toMatchObject({
      items: [{ raw: h.input.raw }],
      productLabelEvents: [h.input.preparedEvent],
    });
    expect(await exec.all("SELECT receipt_outcome FROM validation_occurrences")).toEqual([
      { receipt_outcome: "first_accepted" },
    ]);
    expect(await exec.all("SELECT id FROM outbox")).toHaveLength(1);
    await exec.run("DELETE FROM offline_grant_grants");
    const recovered = createSyncEngine({
      exec,
      client: { post },
      machineId: h.input.deviceId,
      credentialGeneration: generation,
      onState() {},
    });
    recovered.nudge();
    await recovered.idle();
    recovered.stop();
    expect(
      post.mock.calls.filter((call) => call[0] === "/station/grants/v1/evidence/scans"),
    ).toHaveLength(1);
    expect(await exec.all("SELECT id FROM outbox")).toEqual([]);
    expect(await exec.all("SELECT id FROM product_label_outbox")).toEqual([]);
    errors.mockRestore();
    warnings.mockRestore();
  });

  it.each(["scan", "label"] as const)(
    "rolls back all productive facts when %s budget is exhausted",
    async (line) => {
      const { exec, accept } = await fixture(line);
      await expect(accept()).rejects.toThrow(/budget/);
      for (const table of [
        "outbox",
        "product_label_jobs",
        "product_label_events",
        "validation_occurrences",
      ])
        expect(await exec.all(`SELECT * FROM ${table}`), table).toEqual([]);
      expect(await exec.all("SELECT consumed FROM offline_grant_consumption")).toEqual([
        { consumed: 1 },
      ]);
    },
  );
  it("commits both decisions once and associates the original compact with the exact scan outbox", async () => {
    const { h, exec, accept, grantId } = await fixture();
    expect(await accept()).toEqual({ status: "accepted", jobId: h.input.jobId });
    expect(await accept()).toEqual({ status: "accepted", jobId: h.input.jobId });
    expect(await exec.all("SELECT consumed FROM offline_grant_consumption")).toEqual(
      Array.from({ length: 4 }, () => ({ consumed: 1 })),
    );
    await exec.run("DELETE FROM offline_grant_grants");
    expect(await readStationChannelEvidence(exec, "items", 1, 0)).toEqual({
      negotiated: true,
      links: [{ pointer: "/items/0#shift.scan.v1", grantId, compact: "original.compact.bytes" }],
    });
  });
});
