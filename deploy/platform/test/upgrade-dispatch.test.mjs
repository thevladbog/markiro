import test from "node:test";
import assert from "node:assert/strict";
import { verifyUpgradeDispatch } from "../upgrade-dispatch.mjs";
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
    path: ".github/workflows/upgrade-platform.yml",
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
test("upgrade dispatch binds first attempt, actor and distinct protected environment approval and rechecks live run", async () => {
  const f = fixture();
  const proof = await verifyUpgradeDispatch(dispatch, "private-token", {
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
  test(`upgrade dispatch rejects ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(
      verifyUpgradeDispatch(dispatch, "private-token", {
        actorLogin: "publisher",
        request: f.request,
      }),
    );
  });
test("new run required for another approval: approval history cannot bind a rerun attempt", async () => {
  const f = fixture();
  f.run.run_attempt = 2;
  await assert.rejects(
    verifyUpgradeDispatch({ ...dispatch, runAttempt: "2" }, "private-token", {
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
    verifyUpgradeDispatch(dispatch, "private-token", { actorLogin: "publisher", request }),
    (e) => e.message === "Protected upgrade dispatch rejected.",
  );
});
test("network failure is sanitized and never retried", async () => {
  let calls = 0;
  await assert.rejects(
    verifyUpgradeDispatch(dispatch, "private-token", {
      actorLogin: "publisher",
      request: async () => {
        calls++;
        throw new Error("private-token");
      },
    }),
    (e) => e.message === "Protected upgrade dispatch rejected.",
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
