import assert from "node:assert/strict";
import test from "node:test";
import { buildHistoryPlan, isReservedHistoryVersion } from "../import-history.mjs";
const sha = "a".repeat(64),
  scope = { product: "station", channel: "beta" };
function evidence() {
  return {
    schema: 1,
    scope,
    anchors: [{ kind: "preserved-backup", sha256: sha }],
    coverage: { kind: "unknown" },
    releases: [
      {
        version: "2.3.0-beta.1",
        names: ["latest.json", "installer.exe"],
        evidenceSha256: sha,
        publication: null,
        objects: [],
      },
    ],
  };
}
test("missing historical bytes reserve version and paths but produce no readable import", () => {
  const p = buildHistoryPlan(evidence());
  assert.equal(p.imports.length, 0);
  assert.ok(p.reservations.some((r) => r.kind === "version" && r.version === "2.3.0-beta.1"));
  assert.ok(
    p.reservations.some((r) => r.kind === "path" && r.publicPath.endsWith("/installer.exe")),
  );
  assert.equal(p.writersMayEnable, false);
  assert.equal(p.historyComplete, false);
  assert.ok(p.reservations.some((r) => r.kind === "closed"));
});
test("current mirror listing or rollback head cannot prove all issued history", () => {
  const e = evidence();
  e.anchors = [{ kind: "github-current-listing", sha256: sha }];
  const p = buildHistoryPlan(e);
  assert.equal(p.historyComplete, false);
  e.coverage = { kind: "upper-bound", evidenceSha256: sha, upperBound: "2.3.0-beta.1" };
  assert.throws(() => buildHistoryPlan(e), /history/);
});
test("trusted issued upper bound reserves every old base including prereleases on that base", () => {
  const e = evidence();
  e.coverage = { kind: "upper-bound", evidenceSha256: sha, upperBound: "2.3.0-beta.9" };
  const p = buildHistoryPlan(e);
  assert.equal(p.historyComplete, false);
  assert.equal(
    p.reservations.some((r) => r.kind === "closed"),
    false,
  );
  const r = p.reservations.find((r) => r.kind === "range");
  assert.ok(r);
  assert.equal(isReservedHistoryVersion("2.3.0-beta.99", r.upperBound), true);
  assert.equal(isReservedHistoryVersion("2.4.0-beta.1", r.upperBound), false);
});
test("a bound below a known issued version is refused rather than inferred from a rollback head", () => {
  const e = evidence();
  e.coverage = { kind: "upper-bound", evidenceSha256: sha, upperBound: "2.2.0-beta.1" };
  assert.throws(() => buildHistoryPlan(e), /history/);
});
test("complete issued-history anchor remains review-bound and is not activation authority", () => {
  const e = evidence();
  e.coverage = { kind: "complete", evidenceSha256: sha };
  const p = buildHistoryPlan(e);
  assert.equal(p.historyComplete, true);
  assert.equal(p.writersMayEnable, false);
  assert.equal(
    p.reservations.some((r) => r.kind === "closed"),
    false,
  );
  assert.match(p.evidenceSha256, /^[a-f0-9]{64}$/);
});
test("duplicate identity, arbitrary path, malformed and unanchored evidence fail closed", () => {
  for (const mutate of [
    (e) => e.releases.push(e.releases[0]),
    (e) => e.releases[0].names.push("../secret"),
    (e) => (e.extra = true),
    (e) => (e.releases[0].evidenceSha256 = "b".repeat(64)),
  ]) {
    const e = evidence();
    mutate(e);
    assert.throws(() => buildHistoryPlan(e));
  }
});
