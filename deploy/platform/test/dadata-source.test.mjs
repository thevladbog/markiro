import test from "node:test";
import assert from "node:assert/strict";
import * as source from "../configuration-source.mjs";
const C = "a".repeat(40),
  M = "b".repeat(40);
const ref = `refs/tags/configuration-dadata-${C}`;
function fixture() {
  const f = {
    main: { ref: "refs/heads/main", object: { type: "commit", sha: M } },
    tag: { ref, object: { type: "commit", sha: C } },
    compare: {
      base_commit: { sha: C },
      merge_base_commit: { sha: C },
      status: "ahead",
      ahead_by: 1,
      behind_by: 0,
      total_commits: 1,
      commits: [{ sha: M }],
    },
    collision: false,
    calls: [],
  };
  f.request = async (url, options) => {
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    f.calls.push(url);
    if (url.endsWith(`/git/ref/heads/configuration-dadata-${C}`))
      return new Response(
        JSON.stringify(f.collision ? { ref: `refs/heads/configuration-dadata-${C}` } : {}),
        { status: f.collision ? 200 : 404 },
      );
    let data;
    if (url.endsWith("/git/ref/heads/main")) data = f.main;
    else if (url.endsWith(`/git/ref/tags/configuration-dadata-${C}`)) data = f.tag;
    else if (url.endsWith(`/compare/${C}...${M}?per_page=1`)) data = f.compare;
    else throw new Error(`Unexpected request: ${url}`);
    return new Response(JSON.stringify(data));
  };
  return f;
}
test("exact lightweight reviewed configuration tag survives unrelated main advance", async () => {
  const f = fixture();
  assert.equal(typeof source.verifyConfigurationSource, "function");
  const proof = await source.verifyConfigurationSource(
    { sourceSha: C, sourceRef: ref },
    "fixture-token",
    { request: f.request },
  );
  assert.deepEqual(proof, { sourceSha: C, sourceRef: ref, mainSha: M });
  assert.ok(Object.isFrozen(proof));
});
for (const [name, change] of [
  ["moved tag", (f) => (f.tag.object.sha = M)],
  ["annotated tag", (f) => (f.tag.object.type = "tag")],
  ["different tag ref", (f) => (f.tag.ref = `refs/tags/other-${C}`)],
  ["same-named branch", (f) => (f.collision = true)],
  ["nonancestor", (f) => (f.compare.merge_base_commit.sha = M)],
  ["wrong comparison base", (f) => (f.compare.base_commit.sha = M)],
  ["divergence", (f) => (f.compare.behind_by = 1)],
  ["wrong comparison status", (f) => (f.compare.status = "diverged")],
  ["wrong comparison head", (f) => (f.compare.commits[0].sha = C)],
  ["unsafe proof bounds", (f) => (f.compare.total_commits = Number.MAX_SAFE_INTEGER + 1)],
  ["wrong main ref", (f) => (f.main.ref = "refs/heads/other")],
  ["noncommit main", (f) => (f.main.object.type = "tag")],
])
  test(`configuration source rejects ${name}`, async () => {
    const f = fixture();
    change(f);
    assert.equal(typeof source.verifyConfigurationSource, "function");
    await assert.rejects(
      source.verifyConfigurationSource({ sourceSha: C, sourceRef: ref }, "fixture-token", {
        request: f.request,
      }),
    );
  });
for (const sourceRef of [
  "main",
  "refs/heads/feature",
  `refs/heads/configuration-dadata-${C}`,
  `refs/tags/configuration-dadata-${M}`,
  `refs/tags/configuration-dadata-${C}-other`,
  "refs/tags/configuration-dadata-*",
])
  test(`configuration source rejects arbitrary ref ${sourceRef}`, async () => {
    const f = fixture();
    assert.equal(typeof source.verifyConfigurationSource, "function");
    await assert.rejects(
      source.verifyConfigurationSource({ sourceSha: C, sourceRef }, "fixture-token", {
        request: f.request,
      }),
    );
    assert.equal(f.calls.length, 0);
  });
test("existing main source still requires the exact current tip", async () => {
  const f = fixture();
  assert.equal(typeof source.verifyConfigurationSource, "function");
  await assert.rejects(
    source.verifyConfigurationSource({ sourceSha: C }, "fixture-token", { request: f.request }),
  );
  f.main.object.sha = C;
  assert.deepEqual(
    await source.verifyConfigurationSource({ sourceSha: C }, "fixture-token", {
      request: f.request,
    }),
    { sourceSha: C, sourceRef: "refs/heads/main", mainSha: C },
  );
});

test("comparison binds the captured main head beyond its first commit page", async () => {
  const f = fixture();
  f.compare.total_commits = 2;
  f.compare.ahead_by = 2;
  f.compare.commits = [{ sha: "c".repeat(40) }];
  const request = f.request;
  f.request = async (url, options) =>
    url.endsWith("&page=2")
      ? new Response(JSON.stringify({ ...f.compare, commits: [{ sha: M }] }))
      : request(url, options);
  assert.equal(
    (
      await source.verifyConfigurationSource({ sourceSha: C, sourceRef: ref }, "fixture-token", {
        request: f.request,
      })
    ).mainSha,
    M,
  );
  f.request = async (url, options) =>
    url.endsWith("&page=2")
      ? new Response(JSON.stringify({ ...f.compare, commits: [{ sha: C }] }))
      : request(url, options);
  await assert.rejects(
    source.verifyConfigurationSource({ sourceSha: C, sourceRef: ref }, "fixture-token", {
      request: f.request,
    }),
  );
});
test("tag at main still proves exact identical ancestry", async () => {
  const f = fixture();
  f.main.object.sha = C;
  f.compare = {
    base_commit: { sha: C },
    merge_base_commit: { sha: C },
    status: "identical",
    ahead_by: 0,
    behind_by: 0,
    total_commits: 0,
    commits: [],
  };
  const request = f.request;
  f.request = (url, options) => request(url.replace(`${C}...${C}`, `${C}...${M}`), options);
  assert.equal(
    (
      await source.verifyConfigurationSource({ sourceSha: C, sourceRef: ref }, "fixture-token", {
        request: f.request,
      })
    ).mainSha,
    C,
  );
});
for (const change of ["tag", "main", "collision"])
  test(`source recheck rejects live ${change} drift`, async () => {
    const f = fixture(),
      request = f.request;
    f.request = async (url, options) => {
      if (f.calls.some((call) => call.includes("/compare/"))) {
        if (change === "tag") f.tag.object.sha = M;
        if (change === "main") f.main.object.sha = "c".repeat(40);
        if (change === "collision") f.collision = true;
      }
      return request(url, options);
    };
    await assert.rejects(
      source.verifyConfigurationSource({ sourceSha: C, sourceRef: ref }, "fixture-token", {
        request: f.request,
      }),
    );
  });
test("network errors are sanitized and never retry", async () => {
  let calls = 0;
  await assert.rejects(
    source.verifyConfigurationSource({ sourceSha: C, sourceRef: ref }, "fixture-token", {
      request: async () => {
        calls++;
        throw Error("fixture-token");
      },
    }),
    (e) => e.message === "Configuration source provenance rejected.",
  );
  assert.equal(calls, 1);
});

const dispatch = { toolingSha: C, runId: "123", runAttempt: "1" };
function dispatchFixture() {
  const run = {
    id: 123,
    run_attempt: 1,
    head_sha: C,
    head_branch: `configuration-dadata-${C}`,
    event: "workflow_dispatch",
    path: ".github/workflows/configure-platform-dadata.yml",
    repository: { full_name: "thevladbog/markiro" },
    head_repository: { full_name: "thevladbog/markiro" },
    status: "in_progress",
    conclusion: null,
    actor: { type: "User", id: 1, login: "operator" },
    triggering_actor: { type: "User", id: 1, login: "operator" },
  };
  const approvals = [
    {
      state: "approved",
      user: { type: "User", id: 2, login: "reviewer" },
      environments: [{ name: "production-deploy", id: 3 }],
    },
  ];
  return {
    run,
    approvals,
    request: async (url) => ({
      ok: true,
      json: async () => structuredClone(url.endsWith("/approvals") ? approvals : run),
    }),
  };
}
for (const [name, change] of [
  ["rerun", (f) => (f.run.run_attempt = 2)],
  ["wrong SHA", (f) => (f.run.head_sha = M)],
  ["arbitrary tag", (f) => (f.run.head_branch = `configuration-dadata-${M}`)],
  ["suffix tag", (f) => (f.run.head_branch += "-other")],
  ["self approval", (f) => (f.approvals[0].user = f.run.actor)],
  ["wrong workflow", (f) => (f.run.path = ".github/workflows/upgrade-platform.yml")],
  ["wrong repository", (f) => (f.run.repository.full_name = "foreign/markiro")],
  ["changed actor", (f) => (f.run.triggering_actor.id = 3)],
  ["other environment", (f) => (f.approvals[0].environments[0].name = "staging")],
])
  test(`pinned configuration native dispatch rejects ${name}`, async () => {
    const { verifyConfigurationDispatch } = await import("../upgrade-dispatch.mjs");
    const f = dispatchFixture();
    change(f);
    await assert.rejects(
      verifyConfigurationDispatch(dispatch, "fixture-token", {
        actorLogin: "operator",
        request: f.request,
      }),
    );
  });
test("pinned native dispatch rejects a branch change between reads and never authorizes generic upgrade", async () => {
  const { verifyConfigurationDispatch, verifyUpgradeDispatch } =
    await import("../upgrade-dispatch.mjs");
  const f = dispatchFixture(),
    request = f.request;
  let reads = 0;
  f.request = async (url, options) => {
    if (++reads === 4) f.run.head_branch = "main";
    return request(url, options);
  };
  await assert.rejects(
    verifyConfigurationDispatch(dispatch, "fixture-token", {
      actorLogin: "operator",
      request: f.request,
    }),
  );
  const upgrade = dispatchFixture();
  upgrade.run.path = ".github/workflows/upgrade-platform.yml";
  await assert.rejects(
    verifyUpgradeDispatch(dispatch, "fixture-token", {
      actorLogin: "operator",
      request: upgrade.request,
    }),
  );
});
