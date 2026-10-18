import assert from "node:assert/strict";
import test from "node:test";
import { validatePublishedPlatformRelease } from "../release-admission.mjs";
import { expected, release, sourceSha } from "./admission-fixtures.mjs";
function validate(value = release(), selection = expected) {
  return validatePublishedPlatformRelease({
    manifestText: JSON.stringify(value.manifest),
    evidenceText: JSON.stringify(value.evidence),
    expected: selection,
  });
}
test("complete publication returns only validated manifest and verified image evidence", () => {
  const value = release();
  assert.deepEqual(validate(value), {
    manifest: value.manifest,
    verified: value.evidence.verified,
  });
});
test("strict publication shape rejects missing, extra, null and wrong-type keys at every boundary", () => {
  for (const path of [
    [],
    ["published"],
    ["published", "api"],
    ["published", "edge"],
    ["verified"],
    ["verified", "images"],
    ["verified", "images", "api"],
  ]) {
    for (const mutation of ["missing", "extra", "null", "array"]) {
      const value = release();
      let cursor = value.evidence;
      for (const key of path) cursor = cursor[key];
      if (mutation === "missing") delete cursor[Object.keys(cursor)[0]];
      if (mutation === "extra") cursor.extra = true;
      if (mutation === "null" || mutation === "array") {
        const replacement = mutation === "null" ? null : [];
        let parent = value;
        let key = "evidence";
        for (const part of path) {
          parent = parent[key];
          key = part;
        }
        parent[key] = replacement;
      }
      assert.throws(() => validate(value), undefined, `${path} ${mutation}`);
    }
  }
});
test("all identities require canonical safe strings and exact selected source/run/attempt", () => {
  for (const key of [
    "sourceSha",
    "toolingSha",
    "workflowRunId",
    "workflowRunAttempt",
    "ciRunId",
    "ciRunAttempt",
  ]) {
    for (const invalid of [null, 123, "", "01", "1\n", "9007199254740992", `${sourceSha}\n`]) {
      const value = release();
      value.evidence.verified[key] = invalid;
      assert.throws(() => validate(value), undefined, key);
    }
  }
  for (const key of Object.keys(expected)) {
    for (const invalid of [
      null,
      123,
      "01",
      "1\n",
      "9007199254740992",
      key === "sourceSha" ? "f".repeat(40) : "999",
    ])
      assert.throws(() => validate(release(), { ...expected, [key]: invalid }));
  }
  for (const selection of [null, [], {}, { ...expected, extra: true }])
    assert.throws(() => validate(release(), selection));
});
test("complete publication binds both image tags, IDs, repository digests, profiles and timestamps", () => {
  for (const name of ["api", "edge"]) {
    for (const [key, bad] of [
      ["tag", "other"],
      ["id", `sha256:${"f".repeat(64)}`],
      ["pushCompleted", false],
      ["pushCompleted", "true"],
      ["digest", `sha256:${"f".repeat(64)}`],
      ["digest", `${release().evidence.published[name].digest}\n`],
    ]) {
      const value = release();
      value.evidence.published[name][key] = bad;
      assert.throws(() => validate(value));
    }
  }
  for (const [section, key, bad] of [
    ["evidence", "status", "incomplete"],
    ["evidence", "createdAt", "2026-10-18T01:00:00.000Z"],
    ["manifest", "createdAt", "2026-02-30T00:00:00.000Z"],
    ["manifest", "toolingSha", "b".repeat(40)],
    ["manifest", "sourceSha", `${sourceSha}\n`],
    ["manifest", "serverProfile", "legacy"],
    ["manifest", "uiProfile", "legacy"],
    ["manifest", "api", `${release().manifest.api}\n`],
  ]) {
    const value = release();
    value[section][key] = bad;
    assert.throws(() => validate(value));
  }
});
