import { randomUUID } from "node:crypto";
import {
  applyProductLabelEvent,
  buildDuplicateLabelTemplate,
  duplicatePayloadDigest,
  kmHash,
  parseDuplicateKm,
  productLabelBytesDigest,
  productLabelValueDigest,
  type LabelField,
  type VerificationPolicy,
} from "@markiro/domain";
import type { PreparedProductLabelAcceptance } from "../../src/lib/product-labels/types.js";
import type { SqlExecutor } from "../../src/lib/mirror.js";

export function productLabelAcceptanceFixture(
  options: {
    serial?: string;
    verification?: VerificationPolicy;
    ownership?: string;
  } = {},
): PreparedProductLabelAcceptance {
  const raw = `]d2010460000000001521${options.serial ?? "SERIAL-42"}\u001d91Key1\u001d92Crypto(93)^FNC1"tail`;
  const km = parseDuplicateKm(raw);
  const template = {
    id: randomUUID(),
    name: "Дубликат 58×40",
    spec: buildDuplicateLabelTemplate(),
  };
  const jobId = randomUUID();
  const shiftId = randomUUID();
  const operatorId = randomUUID();
  const acceptedAt = "2026-09-08T10:00:00.000Z";
  const policyRevision = randomUUID();
  const fields: Record<LabelField, string> = {
    "product.name": "Кега",
    "product.printName": "Кега",
    "product.gtin": km.gtin14,
    "product.egais": "",
    "km.code": km.raw,
    sscc: "",
    "shift.no": "SEP26-001",
    date: "08.09.2026",
    expiry: "",
    qty: "1",
    // A unit label carries no box count.
    "qty.boxes": "",
    operator: "Оператор",
    "counterparty.name": "",
  };
  const bytes = new TextEncoder().encode("PRINT 1\n");
  const templateDigest = productLabelValueDigest(template);
  return {
    jobId,
    shiftId,
    deviceId: randomUUID(),
    terminalId: "terminal-local",
    operatorId,
    credentialOwnership: options.ownership ?? "credential-generation-a",
    raw,
    canonicalRaw: km.raw,
    codeHash: kmHash(km),
    gtin14: km.gtin14,
    serial: km.serial,
    acceptedAt,
    policy: {
      mode: "duplicate_dm",
      verification: options.verification ?? "required",
      templateId: template.id,
      snapshot: { ...template, digest: templateDigest },
      policyRevision,
    },
    fields,
    bytesBase64: Buffer.from(bytes).toString("base64"),
    preparedEvent: {
      eventId: randomUUID(),
      jobId,
      attemptId: randomUUID(),
      sequence: 1,
      kind: "prepared",
      shiftId,
      codeHash: kmHash(km),
      acceptedAt,
      policyRevision,
      templateDigest,
      payloadDigest: duplicatePayloadDigest(km.raw),
      operatorId,
      occurredAt: acceptedAt,
      attemptNo: 1,
      reason: null,
      language: "zpl",
      dpi: 203,
      bytesDigest: productLabelBytesDigest(bytes),
    },
  };
}

/** Fixture for a transport-complete job; production transitions are implemented in task 9. */
export async function markFixtureSent(
  exec: SqlExecutor,
  input: PreparedProductLabelAcceptance,
): Promise<void> {
  const first = input.preparedEvent;
  const base = {
    jobId: first.jobId,
    attemptId: first.attemptId,
    shiftId: first.shiftId,
    codeHash: first.codeHash,
    acceptedAt: first.acceptedAt,
    policyRevision: first.policyRevision,
    templateDigest: first.templateDigest,
    payloadDigest: first.payloadDigest,
    operatorId: first.operatorId,
    occurredAt: first.occurredAt,
  };
  let projection = applyProductLabelEvent(null, input.preparedEvent, input.policy.verification);
  for (const [index, kind] of (["sending", "sent"] as const).entries()) {
    const event = { ...base, eventId: randomUUID(), kind, sequence: index + 2 };
    projection = applyProductLabelEvent(projection, event, input.policy.verification);
    await exec.run(
      "INSERT INTO product_label_events(credential_ownership,job_id,event_id,sequence,event_json) VALUES(?,?,?,?,?)",
      [
        input.credentialOwnership,
        input.jobId,
        event.eventId,
        event.sequence,
        JSON.stringify(event),
      ],
    );
  }
  await exec.run(
    "UPDATE product_label_jobs SET projection_json=?,status=? WHERE credential_ownership=? AND job_id=?",
    [JSON.stringify(projection), projection.status, input.credentialOwnership, input.jobId],
  );
  await exec.run(
    "UPDATE product_label_attempts SET state='sent' WHERE credential_ownership=? AND job_id=?",
    [input.credentialOwnership, input.jobId],
  );
}

/** Supplies the active, snapshotted shift required by floor acceptance tests. */
export async function seedProductLabelShift(
  exec: SqlExecutor,
  input: PreparedProductLabelAcceptance,
): Promise<void> {
  await exec.run(
    `INSERT INTO shift_mirror(id,product_id,status,mode,validation_print_context) SELECT ?,?,'active','validation',? WHERE NOT EXISTS (SELECT 1 FROM shift_mirror WHERE id=?) ON CONFLICT(id) DO NOTHING`,
    [
      input.shiftId,
      randomUUID(),
      JSON.stringify({
        policy: input.policy,
        labelContext: {
          productName: "Кега",
          productPrintName: null,
          gtin14: input.gtin14,
          egaisCode: null,
          shelfLifeDays: null,
          counterpartyName: null,
          productionDate: "2026-09-08",
          shiftNumber: null,
        },
      }),
      input.shiftId,
    ],
  );
}
