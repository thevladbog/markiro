import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createVerifiedImagesEvidence,
  parseVerifiedImagesEvidence,
  resolvePublishedDigest,
  sha256RegularFile,
  validatePlatformCiEvidence,
} from "../release-evidence.mjs";
import { createPlatformManifest, parsePlatformManifest } from "../release-manifest.mjs";
import { parseReleaseManifest } from "../../production/release-manifest.mjs";

const sourceSha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const apiRepository = "ghcr.io/thevladbog/markiro-api";
const edgeRepository = "ghcr.io/thevladbog/markiro-platform-edge";
const expectedCi = { repository: "thevladbog/markiro", sourceSha, runId: "123" };
const expectedImages = {
  sourceSha,
  toolingSha: sourceSha,
  workflowRunId: "456",
  workflowRunAttempt: "2",
  ciRunId: "123",
  ciRunAttempt: "3",
};
const run = () => ({
  id: 123,
  run_attempt: 3,
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "push",
  head_branch: "main",
  head_sha: sourceSha,
  status: "completed",
  conclusion: "success",
  repository: { full_name: "thevladbog/markiro" },
  head_repository: { full_name: "thevladbog/markiro" },
});
const jobs = () => ({
  total_count: 2,
  jobs: ["production-bundle", "ci-required"].map((name, index) => ({
    id: 1000 + index,
    name,
    run_id: 123,
    run_attempt: 3,
    head_sha: sourceSha,
    status: "completed",
    conclusion: "success",
  })),
});
const evidence = () => ({
  version: 1,
  serverProfile: "platform-only",
  uiProfile: "platform-only",
  ...expectedImages,
  archiveSha256: "c".repeat(64),
  images: {
    api: { tag: `${apiRepository}:platform-${sourceSha}-456-2`, id: digest },
    edge: { tag: `${edgeRepository}:platform-${sourceSha}-456-2`, id: digest },
  },
});

test("CI requires the exact successful main push and returns canonical identities", () => {
  assert.deepEqual(validatePlatformCiEvidence(run(), jobs(), expectedCi), {
    ciRunId: "123",
    ciRunAttempt: "3",
  });
  const value = run();
  value.path += "@refs/heads/main";
  assert.doesNotThrow(() => validatePlatformCiEvidence(value, jobs(), expectedCi));
});

test("CI rejects wrong or missing provenance and unsafe GitHub IDs", () => {
  for (const patch of [
    { id: 124 },
    { id: "123" },
    { id: 0 },
    { id: -1 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { run_attempt: 0 },
    { run_attempt: 1.5 },
    { run_attempt: "3" },
    { run_attempt: Number.MAX_SAFE_INTEGER + 1 },
    { name: "Other" },
    { path: ".github/workflows/other.yml" },
    { path: ".github/workflows/ci.yml@refs/heads/other" },
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { head_branch: "feature" },
    { head_sha: "b".repeat(40) },
    { status: "in_progress" },
    { conclusion: "failure" },
    { repository: { full_name: "fork/markiro" } },
    { head_repository: { full_name: "fork/markiro" } },
  ])
    assert.throws(() => validatePlatformCiEvidence({ ...run(), ...patch }, jobs(), expectedCi));
  for (const key of Object.keys(run())) {
    const value = run();
    delete value[key];
    assert.throws(() => validatePlatformCiEvidence(value, jobs(), expectedCi), undefined, key);
  }
  for (const patch of [
    { runId: "0123" },
    { runId: 123 },
    { runId: "0" },
    { repository: "thevladbog/markiro/" },
    { sourceSha: "main" },
    { sourceSha: `${sourceSha}\n` },
  ])
    assert.throws(() => validatePlatformCiEvidence(run(), jobs(), { ...expectedCi, ...patch }));
});

test("CI rejects missing, duplicate, skipped, unsuccessful or mixed-attempt required jobs", () => {
  for (const name of ["production-bundle", "ci-required"]) {
    for (const patch of [
      { status: "queued" },
      { conclusion: "skipped" },
      { conclusion: "failure" },
      { run_id: 124 },
      { head_sha: "d".repeat(40) },
      { head_sha: undefined },
      { run_attempt: 2 },
      { run_attempt: undefined },
      { run_id: "123" },
      { id: 0 },
      { id: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const value = jobs();
      Object.assign(
        value.jobs.find((job) => job.name === name),
        patch,
      );
      assert.throws(() => validatePlatformCiEvidence(run(), value, expectedCi));
    }
    const missing = jobs();
    missing.jobs = missing.jobs.filter((job) => job.name !== name);
    missing.total_count = missing.jobs.length;
    assert.throws(() => validatePlatformCiEvidence(run(), missing, expectedCi));
    const duplicate = jobs();
    duplicate.jobs.push({ ...duplicate.jobs.find((job) => job.name === name), id: 5000 });
    duplicate.total_count++;
    assert.throws(() => validatePlatformCiEvidence(run(), duplicate, expectedCi));
  }
});

test("CI requires a complete nonduplicated job inventory for the selected attempt", () => {
  for (const total_count of [3, 1, 0, "2", 2.5, undefined])
    assert.throws(() => validatePlatformCiEvidence(run(), { ...jobs(), total_count }, expectedCi));
  const duplicateId = jobs();
  duplicateId.jobs[1].id = duplicateId.jobs[0].id;
  assert.throws(() => validatePlatformCiEvidence(run(), duplicateId, expectedCi));
  const mixed = jobs();
  mixed.jobs.push({ ...mixed.jobs[0], id: 5000, name: "other", run_attempt: 2 });
  mixed.total_count++;
  assert.throws(() => validatePlatformCiEvidence(run(), mixed, expectedCi));
  for (const value of [null, [], {}, { total_count: 2, jobs: null }])
    assert.throws(() => validatePlatformCiEvidence(run(), value, expectedCi));
});

test("verified images roundtrip binds CI and produces the unchanged platform manifest", () => {
  const value = createVerifiedImagesEvidence(evidence());
  assert.deepEqual(value, evidence());
  assert.deepEqual(parseVerifiedImagesEvidence(JSON.stringify(value), expectedImages), evidence());
  const manifest = createPlatformManifest({
    sourceSha: value.sourceSha,
    toolingSha: value.toolingSha,
    workflowRunId: value.workflowRunId,
    apiDigest: digest,
    edgeDigest: digest,
    createdAt: "2026-10-18T00:00:00.000Z",
  });
  assert.deepEqual(parsePlatformManifest(JSON.stringify(manifest), "456"), manifest);
  assert.throws(() => parseReleaseManifest(JSON.stringify(manifest), "456"));
});

test("verified images reject every mismatched expected identity and malformed identity", () => {
  for (const key of Object.keys(expectedImages)) {
    const changed = key.endsWith("Sha") ? "d".repeat(40) : "999";
    assert.throws(() =>
      parseVerifiedImagesEvidence(
        JSON.stringify({ ...evidence(), [key]: changed }),
        expectedImages,
      ),
    );
    assert.throws(() =>
      parseVerifiedImagesEvidence(JSON.stringify(evidence()), {
        ...expectedImages,
        [key]: changed,
      }),
    );
    for (const invalid of key.endsWith("Sha")
      ? ["main", "A".repeat(40), `${sourceSha}\n`, 123]
      : ["0", "01", "-1", "1.0", "1e3", 123, " 123", "123\n"])
      assert.throws(() => createVerifiedImagesEvidence({ ...evidence(), [key]: invalid }));
  }
});

test("verified images enforce exact record keys, profiles and archive hash", () => {
  for (const patch of [
    { version: 2 },
    { version: "1" },
    { serverProfile: "legacy" },
    { uiProfile: "legacy" },
    { archiveSha256: "C".repeat(64) },
    { archiveSha256: digest },
    { archiveSha256: "c".repeat(63) },
    { archiveSha256: 1 },
    { archiveSha256: `${"c".repeat(64)}\n` },
    { extra: true },
  ])
    assert.throws(() => createVerifiedImagesEvidence({ ...evidence(), ...patch }));
  for (const key of Object.keys(evidence())) {
    const value = evidence();
    delete value[key];
    assert.throws(() => createVerifiedImagesEvidence(value), undefined, key);
  }
  for (const text of ["bad-json", "null", "[]", "123"])
    assert.throws(() => parseVerifiedImagesEvidence(text, expectedImages));
  for (const expected of [null, {}, { ...expectedImages, extra: true }])
    assert.throws(() => parseVerifiedImagesEvidence(JSON.stringify(evidence()), expected));
});

test("verified images reject wrong repositories, tag identities, Docker IDs and nested keys", () => {
  for (const key of ["api", "edge"]) {
    const original = evidence().images[key];
    for (const patch of [
      { tag: original.tag.replace("456-2", "457-2") },
      { tag: original.tag.replace("456-2", "456-1") },
      { tag: original.tag.replace(sourceSha, "d".repeat(40)) },
      { tag: original.tag.replace(":platform-", ":") },
      { tag: `${key === "api" ? edgeRepository : apiRepository}:platform-${sourceSha}-456-2` },
      {
        tag: original.tag
          .replace("markiro-platform-edge", "markiro-edge")
          .replace("markiro-api", "other"),
      },
      { tag: `${apiRepository}:latest` },
      { tag: `${original.tag}\n` },
      { id: "b".repeat(64) },
      { id: `sha256:${"B".repeat(64)}` },
      { id: `sha256:${"b".repeat(63)}` },
      { id: 1 },
      { id: `${digest}\n` },
      { extra: true },
    ]) {
      const value = evidence();
      Object.assign(value.images[key], patch);
      assert.throws(() => createVerifiedImagesEvidence(value));
    }
    for (const field of ["tag", "id"]) {
      const value = evidence();
      delete value.images[key][field];
      assert.throws(() => createVerifiedImagesEvidence(value));
    }
    const value = evidence();
    delete value.images[key];
    assert.throws(() => createVerifiedImagesEvidence(value));
  }
  const value = evidence();
  value.images.extra = value.images.api;
  assert.throws(() => createVerifiedImagesEvidence(value));
});

test("published digest resolution requires exactly one well-formed exact repository match", () => {
  assert.equal(
    resolvePublishedDigest(
      [`unrelated/image@${digest}`, `${apiRepository}@${digest}`],
      apiRepository,
    ),
    digest,
  );
  assert.equal(resolvePublishedDigest([`${edgeRepository}@${digest}`], edgeRepository), digest);
  for (const value of [
    [],
    [`${apiRepository}-other@${digest}`],
    [`${apiRepository}@bad`],
    [`${apiRepository}@${digest}`, `${apiRepository}@${digest}`],
    [`${apiRepository}@${digest}`, `${apiRepository}@sha256:${"d".repeat(64)}`],
    [`${apiRepository}@${digest}`, `${apiRepository}@invalid`],
    [`${apiRepository}@sha256:${"B".repeat(64)}`],
    [`${apiRepository}@${digest}\n`],
    [null],
    null,
    digest,
  ])
    assert.throws(() => resolvePublishedDigest(value, apiRepository));
  for (const repository of [
    "ghcr.io/thevladbog/markiro-edge",
    `${apiRepository}:tag`,
    "other",
    null,
  ])
    assert.throws(() => resolvePublishedDigest([`${repository}@${digest}`], repository));
});

async function temporary(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), "markiro-evidence-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("archive hashing streams regular files and rejects directories, symlinks and hardlinks", async (t) => {
  const directory = await temporary(t);
  const file = join(directory, "archive");
  await fs.writeFile(file, "abc");
  assert.equal(
    await sha256RegularFile(file),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  await fs.symlink(file, join(directory, "link"));
  await assert.rejects(sha256RegularFile(join(directory, "link")));
  await assert.rejects(sha256RegularFile(directory));
  await fs.link(file, join(directory, "hardlink"));
  await assert.rejects(sha256RegularFile(file));
  await assert.rejects(
    sha256RegularFile(join(directory, "missing-secret-path")),
    (error) => !error.message.includes(directory) && !error.message.includes("missing-secret-path"),
  );
});

test("archive hashing rejects in-place edits and path substitution during the stream", async (t) => {
  const directory = await temporary(t);
  const bytes = Buffer.alloc(512 * 1024, 1);
  for (const mutation of ["edit", "replace", "symlink"]) {
    const file = join(directory, mutation);
    await fs.writeFile(file, bytes);
    const realOpen = fs.open;
    const mocked = t.mock.method(fs, "open", async (...args) => {
      const handle = await realOpen(...args);
      const stream = handle.createReadStream.bind(handle);
      handle.createReadStream = (...streamArgs) => {
        const result = stream(...streamArgs);
        result.once("data", () => {
          if (mutation === "edit") writeFileSync(file, bytes);
          else {
            renameSync(file, `${file}.old`);
            if (mutation === "replace") writeFileSync(file, bytes);
            else symlinkSync(`${file}.old`, file);
          }
        });
        return result;
      };
      return handle;
    });
    try {
      await assert.rejects(sha256RegularFile(file));
    } finally {
      mocked.mock.restore();
    }
  }
});
