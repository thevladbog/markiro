import test from "node:test";
import assert from "node:assert/strict";
import { verifyCatalogBootstrapDispatch } from "../upgrade-dispatch.mjs";
const dispatch = { toolingSha: "a".repeat(40), runId: "123", runAttempt: "1" };
const repository = { full_name: "thevladbog/markiro" };
const actor = { id: 11, login: "publisher", type: "User" };
const reviewer = { id: 12, login: "reviewer", type: "User" };
function fixture() {
  const run = {
    id: 123,
    run_attempt: 1,
    head_sha: dispatch.toolingSha,
    head_branch: "main",
    event: "workflow_dispatch",
    path: ".github/workflows/bootstrap-release-catalog.yml",
    repository,
    head_repository: repository,
    status: "in_progress",
    conclusion: null,
    actor,
    triggering_actor: actor,
  };
  const approvals = [
    { state: "approved", user: reviewer, environments: [{ id: 44, name: "production-deploy" }] },
  ];
  const calls = [];
  return {
    run,
    approvals,
    calls,
    request: async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer private-token");
      assert.ok(options.signal instanceof AbortSignal);
      return {
        ok: true,
        json: async () => structuredClone(url.endsWith("/approvals") ? approvals : run),
      };
    },
  };
}
test("catalog bootstrap dispatch binds first attempt, actor and distinct protected environment approval and rechecks live run", async () => {
  const f = fixture();
  const proof = await verifyCatalogBootstrapDispatch(dispatch, "private-token", {
    actorLogin: "publisher",
    request: f.request,
  });
  assert.deepEqual(proof, {
    actorId: "11",
    actorLogin: "publisher",
    reviewerId: "12",
    reviewerLogin: "reviewer",
    environmentId: "44",
  });
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[0], f.calls.at(-1));
  assert.ok(f.calls[1].endsWith("/attempts/1"));
  assert.ok(f.calls[2].endsWith("/approvals"));
});
test("catalog bootstrap accepts the exact SHA-named release tag without consulting moving main", async () => {
  const f = fixture();
  f.run.head_branch = `catalog-bootstrap-${dispatch.toolingSha}`;
  const proof = await verifyCatalogBootstrapDispatch(dispatch, "private-token", {
    actorLogin: "publisher",
    request: f.request,
  });
  assert.equal(proof.reviewerId, "12");
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every((url) => url.includes("/actions/runs/123")));
});
for (const [name, mutate] of [
  ["tag names another SHA", (f) => (f.run.head_branch = `catalog-bootstrap-${"b".repeat(40)}`)],
  [
    "tag has an extra suffix",
    (f) => (f.run.head_branch = `catalog-bootstrap-${dispatch.toolingSha}-other`),
  ],
  ["tag points at another SHA", (f) => (f.run.head_sha = "b".repeat(40))],
  ["tag has no approval", (f) => f.approvals.splice(0)],
  ["tag has self approval", (f) => (f.approvals[0].user = actor)],
  [
    "tag changes during authorization",
    (f) => {
      const request = f.request;
      f.request = async (url, options) => {
        if (f.calls.length === 3) f.run.head_branch = "main-unreviewed";
        return request(url, options);
      };
    },
  ],
])
  test(`catalog bootstrap rejects ${name}`, async () => {
    const f = fixture();
    f.run.head_branch = `catalog-bootstrap-${dispatch.toolingSha}`;
    mutate(f);
    await assert.rejects(
      verifyCatalogBootstrapDispatch(dispatch, "private-token", {
        actorLogin: "publisher",
        request: f.request,
      }),
    );
  });
test("catalog tag does not authorize a platform upgrade", async () => {
  const { verifyUpgradeDispatch } = await import("../upgrade-dispatch.mjs");
  const f = fixture();
  f.run.path = ".github/workflows/upgrade-platform.yml";
  f.run.head_branch = `catalog-bootstrap-${dispatch.toolingSha}`;
  await assert.rejects(
    verifyUpgradeDispatch(dispatch, "private-token", {
      actorLogin: "publisher",
      request: f.request,
    }),
  );
});
for (const [name, mutate] of [
  ["different run", (f) => f.run.id++],
  ["reused attempt", (f) => f.run.run_attempt++],
  ["wrong SHA", (f) => (f.run.head_sha = "b".repeat(40))],
  ["wrong branch", (f) => (f.run.head_branch = "feature")],
  ["wrong workflow", (f) => (f.run.path = ".github/workflows/recover-platform.yml")],
  ["push", (f) => (f.run.event = "push")],
  ["fork", (f) => (f.run.head_repository = { full_name: "foreign/markiro" })],
  ["different actor", (f) => (f.run.actor = { ...actor, login: "other" })],
  ["different triggering actor", (f) => (f.run.triggering_actor = reviewer)],
  ["completed run", (f) => (f.run.status = "completed")],
  ["failed run", (f) => (f.run.conclusion = "failure")],
  ["no approval", (f) => f.approvals.splice(0)],
  ["rejected approval", (f) => (f.approvals[0].state = "rejected")],
  ["other environment", (f) => (f.approvals[0].environments[0].name = "staging")],
  ["self approval ID", (f) => (f.approvals[0].user = { ...reviewer, id: actor.id })],
  ["self approval login", (f) => (f.approvals[0].user = { ...reviewer, login: actor.login })],
  ["bot approval", (f) => (f.approvals[0].user.type = "Bot")],
  ["ambiguous approval", (f) => f.approvals.push(structuredClone(f.approvals[0]))],
  [
    "unsafe actor ID",
    (f) => (f.run.actor = f.run.triggering_actor = { ...actor, id: Number.MAX_SAFE_INTEGER + 1 }),
  ],
])
  test(`catalog bootstrap dispatch rejects ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(
      verifyCatalogBootstrapDispatch(dispatch, "private-token", {
        actorLogin: "publisher",
        request: f.request,
      }),
    );
  });
test("new run required for another approval: approval history cannot bind a rerun attempt", async () => {
  const f = fixture();
  f.run.run_attempt = 2;
  await assert.rejects(
    verifyCatalogBootstrapDispatch({ ...dispatch, runAttempt: "2" }, "private-token", {
      actorLogin: "publisher",
      request: f.request,
    }),
  );
  assert.equal(f.calls.length, 0);
});
test("run changes after approval are refused without exposing response or token", async () => {
  const f = fixture();
  const request = async (url, options) => {
    if (f.calls.length === 3) f.run.status = "completed";
    return f.request(url, options);
  };
  await assert.rejects(
    verifyCatalogBootstrapDispatch(dispatch, "private-token", { actorLogin: "publisher", request }),
    (e) => e.message === "Protected catalog bootstrap dispatch rejected.",
  );
});
test("network failure is sanitized and never retried", async () => {
  let calls = 0;
  await assert.rejects(
    verifyCatalogBootstrapDispatch(dispatch, "private-token", {
      actorLogin: "publisher",
      request: async () => {
        calls++;
        throw new Error("private-token");
      },
    }),
    (e) => e.message === "Protected catalog bootstrap dispatch rejected.",
  );
  assert.equal(calls, 1);
});
import { upgradePhase } from "../upgrade-dispatch.mjs";
test("phase registry rejects forged or inherited names and never maps forward phases to legacy operations", () => {
  for (const phase of [
    "__proto__",
    "toString",
    "constructor",
    "resume",
    "post-migration-return-old",
    null,
    {},
    "activate;id",
  ])
    assert.throws(() => upgradePhase(phase));
  for (const [phase, status] of [
    ["post-migration-prepare", "backup-verified"],
    ["post-migration-activate", "healthy"],
  ]) {
    const spec = upgradePhase(phase);
    assert.ok(Object.isFrozen(spec));
    assert.equal(spec.status, status);
    assert.equal(spec.kind, "platform-forward-recovery-host-operation");
  }
  assert.equal(upgradePhase("return-old").kind, "platform-upgrade-host-operation");
});

test("catalog physical fencing also requires absence of other active production or publisher workflows", async () => {
  const { assertNoCatalogPeers } = await import("../upgrade-dispatch.mjs");
  const response = (rows) => async () => ({
    ok: true,
    json: async () => ({ total_count: rows.length, workflow_runs: rows }),
  });
  const self = {
    id: 123,
    path: ".github/workflows/bootstrap-release-catalog.yml",
    status: "in_progress",
  };
  await assertNoCatalogPeers(
    dispatch,
    "private-token",
    response([self, { id: 124, path: ".github/workflows/ci.yml", status: "in_progress" }]),
  );
  for (const path of [
    "upgrade-platform.yml",
    "station-stable-release.yml",
    "handheld-release.yml",
    "release-platform-images.yml",
    "signer-stable-release.yml",
    "station-release-reseed.yml",
    "signer-download-repair.yml",
  ])
    await assert.rejects(
      assertNoCatalogPeers(
        dispatch,
        "private-token",
        response([self, { id: 124, path: `.github/workflows/${path}`, status: "in_progress" }]),
      ),
    );
});

test("writer fence covers every actual release/deployment workflow in the current repository", async () => {
  const { readdir } = await import("node:fs/promises");
  const { assertNoCatalogPeers } = await import("../upgrade-dispatch.mjs");
  const names = (await readdir(new URL("../../../.github/workflows/", import.meta.url))).filter(
    (name) => /(?:release|deploy|recover|upgrade|signer-download-repair).*\.yml$/u.test(name),
  );
  for (const name of names) {
    const request = async () => ({
      ok: true,
      json: async () => ({
        total_count: 2,
        workflow_runs: [
          {
            id: 123,
            status: "in_progress",
            path: ".github/workflows/bootstrap-release-catalog.yml",
          },
          { id: 124, status: "in_progress", path: `.github/workflows/${name}` },
        ],
      }),
    });
    await assert.rejects(assertNoCatalogPeers(dispatch, "private-token", request), name);
  }
});
