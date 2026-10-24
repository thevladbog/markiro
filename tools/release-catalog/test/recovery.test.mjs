import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import {
  validateRecoveryEvidence,
  recoveryEvidenceDigest,
  recoveryPlanDigest,
} from "../recover.mjs";
const require = createRequire(import.meta.url);
const {
  receiptBytes,
} = require("../../../apps/api/dist/modules/release-catalog/catalog-receipts.js");
test("operator facade executes canonical compiled scanner, requires review and keeps writers closed", async () => {
  const id = randomUUID(),
    epoch = randomUUID(),
    bytes = receiptBytes({
      schema: 1,
      id,
      kind: "reservation",
      epoch,
      identity: { product: "station", channel: "beta" },
      evidenceSha256: "a".repeat(64),
      entries: [{ kind: "closed" }],
    }),
    sha256 = createHash("sha256").update(bytes).digest("hex"),
    key = `_publication-ledger/${id}.json`;
  const evidence = {
    schema: 1,
    bucket: "markiro-releases",
    independentInventoryComplete: true,
    independentReceipts: [{ id, sha256, base64: bytes.toString("base64") }],
    technicalKeys: [],
    limits: { maxPages: 10, maxRecords: 100, maxBytes: 1048576, timeoutMs: 1000 },
  };
  let puts = 0,
    gets = 0;
  const store = {
    readVersion: async (request) => {
      assert.equal(request.key, key);
      assert.equal(request.versionId, "original");
      gets++;
      return Readable.from([bytes]);
    },
    writeReceipt: async () => {
      puts++;
      throw Error("unexpected write");
    },
    listReceiptVersions: async () => ({
      versions: [{ key, versionId: "original", deleted: false }],
      nextCursor: undefined,
    }),
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
  const options = {
    admission,
    now: () => now,
    authorize: async (a) => {
      assert.deepEqual(a, admission);
    },
    assertFenced: async () => {},
  };
  const plan = await validateRecoveryEvidence(evidence, store, options);
  assert.equal(plan.writersMayEnable, false);
  assert.equal(plan.reservations.length, 1);
  assert.equal(puts, 0);
  assert.equal(gets, 1);
  assert.match(recoveryPlanDigest(plan), /^[a-f0-9]{64}$/);
  await assert.rejects(
    validateRecoveryEvidence(evidence, store, {
      ...options,
      authorize: async () => {
        throw Error("approval absent");
      },
    }),
  );
});
