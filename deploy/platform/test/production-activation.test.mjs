import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePreparedTarget } from "../host/prepared-target.mjs";
import { digest } from "../backup/schemas.mjs";
import { productionFixture } from "./production-activation-fixture.mjs";
test("explicit first production acceptance preserves backup/TLS/role/fence validation without fake isolation", async (t) => {
  const f = await productionFixture(t);
  const v = await validatePreparedTarget(f.record, f.expected);
  assert.equal(v.record.observations.egress.value.retention, "authorized");
  assert.equal(v.record.version, 2);
});
for (const [name, mutate] of Object.entries({
  "legacy version never accepts production authorization": (f) => {
    f.record.version = 1;
  },
  "missing mode fails closed": (f) => {
    delete f.record.observations.egress.value.mode;
  },
  "unknown mode fails closed": (f) => {
    f.record.observations.egress.value.mode = "anything";
  },
  "different backup rejects": (f) => {
    f.record.observations.egress.value.review.archiveSha256 = "a".repeat(64);
  },
  "different operation review rejects": (f) => {
    f.record.observations.egress.value.review.operationId = "other";
  },
  "changed review digest rejects": (f) => {
    f.record.observations.egress.value.reviewSha256 = "a".repeat(64);
  },
  "source is explicitly operator-attested": (f) => {
    f.record.observations.egress.value.sourceHold.kind = "measured";
  },
  "released source rejects": (f) => {
    f.record.observations.egress.value.sourceHold.held = false;
  },
  "expired approval rejects": (f) => {
    f.record.observations.egress.value.expiresAt = new Date(Date.now() - 1).toISOString();
  },
  "legacy workers remain disabled": (f) => {
    f.record.observations.egress.value.legacyQueues = "authorized";
  },
  "pre-backup queue review rejects": (f) => {
    f.record.observations.egress.value.review.observedAt = "2020-01-01T00:00:00Z";
  },
  "source hold cannot expire before authorization": (f) => {
    f.record.observations.egress.value.sourceHold.expiresAt = new Date(
      Date.now() + 1000,
    ).toISOString();
  },
})) {
  test(name, async (t) => {
    const f = await productionFixture(t);
    mutate(f);
    const a = f.record.observations.egress.value;
    if (name !== "changed review digest rejects") a.reviewSha256 = digest(a.review);
    await assert.rejects(validatePreparedTarget(f.record, f.expected));
  });
}
test("production authorization expiry crossed inside async observation rejects", async (t) => {
  const f = await productionFixture(t),
    start = Date.now();
  let now = start;
  t.mock.method(Date, "now", () => now);
  f.record.observations.egress.value.expiresAt = new Date(start + 1000).toISOString();
  const observe = f.expected.writerFence.observe;
  f.expected.writerFence.observe = async (request) => {
    const result = await observe(request);
    now = start + 2000;
    return result;
  };
  await assert.rejects(validatePreparedTarget(f.record, f.expected));
});

test("native review query uses one readonly snapshot and fixed asOf; optional queue tables are not blindly selected", async () => {
  const { activationProjectionSql } = await import("../host/command.mjs");
  const sql = activationProjectionSql("2026-10-19T12:00:00.000Z");
  assert.match(sql, /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  assert.match(sql, /\\if :has_platform/);
  assert.match(sql, /\\if :has_legacy/);
  assert.match(sql, /2024-10-19T12:00:00.000Z/);
  assert.doesNotMatch(sql, /now\(\)/);
  assert.throws(() => activationProjectionSql("'; DELETE FROM email_deliveries; --"));
});
