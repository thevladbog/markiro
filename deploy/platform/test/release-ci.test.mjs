import assert from "node:assert/strict";
import test from "node:test";
import { fetchPlatformCi } from "../release-ci.mjs";
const expected = { repository: "thevladbog/markiro", sourceSha: "a".repeat(40), runId: "123" };
const run = {
  id: 123,
  run_attempt: 3,
  name: "CI",
  path: ".github/workflows/ci.yml",
  event: "push",
  head_branch: "main",
  head_sha: expected.sourceSha,
  status: "completed",
  conclusion: "success",
  repository: { full_name: expected.repository },
  head_repository: { full_name: expected.repository },
};
const jobs = Array.from({ length: 101 }, (_, index) => ({
  id: index + 1,
  run_id: 123,
  run_attempt: 3,
  head_sha: expected.sourceSha,
  name: ["production-bundle", "ci-required"][index] ?? `job-${index}`,
  status: "completed",
  conclusion: "success",
}));
function transport(patch = (value) => value) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, options });
      const page = new URL(url).searchParams.get("page");
      return {
        ok: true,
        json: async () =>
          patch(
            page
              ? {
                  total_count: jobs.length,
                  jobs: page === "1" ? jobs.slice(0, 100) : jobs.slice(100),
                }
              : structuredClone(run),
            url,
          ),
      };
    },
  };
}
test("fetches exact successful attempt and all job pages over authenticated HTTPS", async () => {
  const f = transport();
  const result = await fetchPlatformCi(expected, "masked-token", f.fetch);
  assert.deepEqual(result.identity, { ciRunId: "123", ciRunAttempt: "3" });
  assert.equal(result.jobs.jobs.length, 101);
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls[1].url.endsWith("/attempts/3"));
  for (const { url, options } of f.calls) {
    assert.ok(url.startsWith("https://api.github.com/repos/thevladbog/markiro/actions/runs/123"));
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer masked-token");
    if (url.includes("jobs")) assert.ok(url.includes("/attempts/3/jobs?per_page=100&page="));
  }
});
test("rejects unsafe IDs before transport and truncated or changing page inventories", async () => {
  const f = transport();
  await assert.rejects(fetchPlatformCi({ ...expected, runId: "123/evil" }, "token", f.fetch));
  assert.equal(f.calls.length, 0);
  for (const patch of [
    (v) => (v.jobs ? { ...v, jobs: v.jobs.slice(0, 1) } : v),
    (v, url) => (url.endsWith("page=2") ? { ...v, total_count: 102 } : v),
    (v) => (v.jobs ? { ...v, jobs: v.jobs.map((j) => ({ ...j, run_attempt: 2 })) } : v),
    (v) => (v.jobs ? v : { ...v, conclusion: "failure" }),
  ])
    await assert.rejects(fetchPlatformCi(expected, "token", transport(patch).fetch));
});
test("transport errors never echo response bodies or token", async () => {
  await assert.rejects(
    fetchPlatformCi(expected, "secret-token", async () => {
      throw new Error("secret-token raw body");
    }),
    (error) => !error.message.includes("secret-token"),
  );
});

test("malformed identity types and trailing newlines make no HTTP requests", async () => {
  for (const patch of [
    { runId: 123 },
    { runId: "123\n" },
    { sourceSha: `${expected.sourceSha}\n` },
    { repository: `${expected.repository}\n` },
  ]) {
    const f = transport();
    await assert.rejects(fetchPlatformCi({ ...expected, ...patch }, "token", f.fetch));
    assert.equal(f.calls.length, 0);
  }
});
