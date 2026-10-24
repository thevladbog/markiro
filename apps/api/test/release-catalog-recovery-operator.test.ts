import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  validateRecoveryEvidence,
  recoveryEvidenceDigest,
  validateOperatorAdmission,
} from "../src/modules/release-catalog/catalog-operator";
import { receiptBytes, digest } from "../src/modules/release-catalog/catalog-receipts";
import { fakeLedgerStore } from "./support/catalog-ledger";
const actor = { actorPlatformUserId: null, actorRole: null, requestId: null };
async function fixture() {
  const f = fakeLedgerStore(),
    epoch = randomUUID(),
    id = randomUUID(),
    operation = {
      schema: 1,
      id,
      kind: "reservation",
      epoch,
      identity: { product: "handheld", channel: "stable" },
      evidenceSha256: "a".repeat(64),
      entries: [{ kind: "closed" }],
    };
  const bytes = receiptBytes(operation);
  await f.store.writeReceipt(id, bytes);
  const evidence = {
    schema: 1,
    bucket: "markiro-releases",
    independentInventoryComplete: true,
    independentReceipts: [{ id, sha256: digest(bytes), base64: bytes.toString("base64") }],
    technicalKeys: [],
    limits: { maxPages: 10, maxRecords: 100, maxBytes: 1048576, timeoutMs: 1000 },
  };
  const now = Date.now(),
    admission = {
      schema: 1,
      action: "recover",
      operationId: randomUUID(),
      executorSha: "b".repeat(40),
      runId: "123",
      runAttempt: "1",
      epoch,
      evidenceSha256: recoveryEvidenceDigest(evidence),
      expiresAt: new Date(now + 60000).toISOString(),
    };
  return { ...f, evidence, admission, now };
}
it("exact approved bounded evidence delegates all-version scan and never enables writers", async () => {
  const f = await fixture();
  let checked = 0;
  const options = {
    admission: f.admission,
    now: () => f.now,
    authorize: async () => {
      checked++;
    },
    assertFenced: async () => {
      checked++;
    },
  };
  const plan = await validateRecoveryEvidence(f.evidence, f.store, options);
  expect(plan.reservations).toHaveLength(1);
  expect(plan.writersMayEnable).toBe(false);
  expect(checked).toBe(4);
  for (const change of [
    (a: typeof f.admission) => {
      a.evidenceSha256 = "c".repeat(64);
    },
    (a: typeof f.admission) => {
      a.expiresAt = new Date(f.now).toISOString();
    },
    (a: typeof f.admission) => {
      a.action = "history";
    },
    (a: typeof f.admission) => {
      a.runAttempt = "0";
    },
  ]) {
    const admission = structuredClone(f.admission);
    change(admission);
    await expect(
      validateRecoveryEvidence(f.evidence, f.store, { ...options, admission }),
    ).rejects.toThrow();
  }
  await expect(
    validateRecoveryEvidence(f.evidence, f.store, {
      ...options,
      authorize: async () => {
        throw Error("protected review absent");
      },
    }),
  ).rejects.toThrow();
  await expect(
    validateRecoveryEvidence(f.evidence, f.store, {
      ...options,
      assertFenced: async () => {
        throw Error("old executor running");
      },
    }),
  ).rejects.toThrow();
});
it("deleted remote receipt, missing independent anchor, or a changed fence blocks completion", async () => {
  const f = await fixture(),
    options = {
      admission: f.admission,
      now: () => f.now,
      authorize: async () => {},
      assertFenced: async () => {},
    };
  const bad = { ...f.evidence, independentReceipts: [] };
  await expect(
    validateRecoveryEvidence(bad, f.store, {
      ...options,
      admission: { ...f.admission, evidenceSha256: recoveryEvidenceDigest(bad) },
    }),
  ).rejects.toThrow();
  let checks = 0;
  await expect(
    validateRecoveryEvidence(f.evidence, f.store, {
      ...options,
      assertFenced: async () => {
        if (++checks > 1) throw Error("fence changed");
      },
    }),
  ).rejects.toThrow();
  f.versions.clear();
  await expect(validateRecoveryEvidence(f.evidence, f.store, options)).rejects.toThrow();
});
it("operator admission never accepts fabricated action, digest, authority or overlong lifetime", async () => {
  const f = await fixture();
  expect(() =>
    validateOperatorAdmission(f.admission, "recover", f.admission.evidenceSha256, f.now),
  ).not.toThrow();
  expect(() =>
    validateOperatorAdmission(
      { ...f.admission, expiresAt: new Date(f.now + 3600001).toISOString() },
      "recover",
      f.admission.evidenceSha256,
      f.now,
    ),
  ).toThrow();
  expect(() =>
    validateOperatorAdmission(
      { ...f.admission, actor },
      "recover",
      f.admission.evidenceSha256,
      f.now,
    ),
  ).toThrow();
});
