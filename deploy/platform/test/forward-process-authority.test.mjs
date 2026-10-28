import assert from "node:assert/strict";
import test from "node:test";
import * as authority from "../host/operation-authority.mjs";
const files = [
  "/installed/deploy/platform/compose.yml",
  "/installed/deploy/platform/compose.compact.yml",
];
function fixture(service = "api") {
  const trace = [];
  const request = {
    executable: "/usr/bin/docker",
    args: [
      "--host",
      "unix:///var/run/docker.sock",
      "compose",
      "--project-name",
      "markiro-platform",
      ...files.flatMap((p) => ["--file", p]),
      "up",
      "-d",
      ...(service === "api" ? ["--wait"] : []),
      "--no-deps",
      service,
    ],
  };
  const options = {
    decision: { version: 2, authority: "protected-dispatch-once" },
    composeFiles: files,
    allowRecreate: false,
    verify: async () => {
      trace.push("sources");
    },
    authorize: async () => {
      trace.push("github");
    },
    recheck: () => {
      trace.push("freshness");
    },
    run: async (_r, recheck) => {
      recheck();
      trace.push("spawn");
      return "result";
    },
  };
  return { request, options, trace };
}
for (const service of ["api", "edge"])
  test(`exact ${service} spawn rechecks live approval after source verification`, async () => {
    const f = fixture(service);
    assert.equal(await authority.runWithForwardAuthority(f.request, f.options), "result");
    assert.deepEqual(f.trace, ["sources", "github", "freshness", "freshness", "spawn"]);
  });
test("revoked or cancelled dispatch cannot spawn after otherwise valid physical checks", async () => {
  const f = fixture();
  f.options.authorize = async () => {
    f.trace.push("github-denied");
    throw Error("cancelled run");
  };
  await assert.rejects(authority.runWithForwardAuthority(f.request, f.options));
  assert.deepEqual(f.trace, ["sources", "github-denied"]);
});
test("changed source prevents even the late authority check and application spawn", async () => {
  const f = fixture();
  f.options.verify = async () => {
    throw Error("changed source");
  };
  await assert.rejects(authority.runWithForwardAuthority(f.request, f.options));
  assert.deepEqual(f.trace, []);
});
for (const fault of [
  "foreign files",
  "postgres",
  "missing wait",
  "unapproved recreation",
  "extra argument",
])
  test(`dispatch-bound runner rejects ${fault} before spawn`, async () => {
    const f = fixture();
    if (fault === "foreign files") f.request.args[6] = "/foreign/compose.yml";
    if (fault === "postgres") f.request.args[f.request.args.length - 1] = "postgres";
    if (fault === "missing wait") f.request.args = f.request.args.filter((x) => x !== "--wait");
    if (fault === "unapproved recreation") f.request.args.splice(-1, 0, "--force-recreate");
    if (fault === "extra argument") f.request.args.splice(-1, 0, "--remove-orphans");
    await assert.rejects(authority.runWithForwardAuthority(f.request, f.options));
    assert.deepEqual(f.trace, ["sources"]);
  });
test("only the reviewed mixed-source continuation can explicitly recreate stopped source applications", async () => {
  const f = fixture();
  f.options.allowRecreate = true;
  f.request.args.splice(-1, 0, "--force-recreate");
  await authority.runWithForwardAuthority(f.request, f.options);
  assert.equal(f.trace.at(-1), "spawn");
});
