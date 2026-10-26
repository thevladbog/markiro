import test from "node:test";
import assert from "node:assert/strict";
import { githubTransport } from "../admission-github.mjs";
import { admissionReadFailure, withAdmissionReadStage } from "../admission-read-failure.mjs";
import { noteHostProcessFailure, sanitizeHostFailure } from "../host/failure-diagnostic.mjs";
import { observationError } from "../host/observe.mjs";

const secret = "PRIVATE-ADMISSION-SENTINEL";
const context = {
  operationId: "2439125a-654f-439c-8f90-7db8afda5246",
  phase: "admitted",
  boundary: "verifyAdmission",
  commandCategory: "validation",
};
async function failed(action) {
  let error;
  try {
    await action();
  } catch (value) {
    error = value;
  }
  assert.ok(error, "the admission read must still fail closed");
  return error;
}

test("failed publisher HTTP read records status without retrying or retaining its body", async () => {
  let requests = 0;
  const transport = githubTransport(secret, async () => {
    requests++;
    return new Response(secret, { status: 503 });
  });
  const error = await failed(() => transport.json("/runs/1"));
  assert.equal(requests, 1);
  assert.deepEqual(admissionReadFailure(error), {
    stage: "publisher",
    reason: "http",
    status: 503,
    bytesSeen: null,
    limitBytes: null,
    redirectCount: null,
  });
  const record = sanitizeHostFailure(observationError(error), context);
  assert.equal(record.admissionRead.status, 503);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
});

test("nested CI transport retains the product versus executor stage", async () => {
  for (const stage of ["product-ci", "executor-ci"]) {
    const transport = githubTransport(secret, async () => new Response(secret, { status: 502 }));
    const error = await failed(() =>
      withAdmissionReadStage(stage, () =>
        transport.ciRequest("https://api.github.com/repos/thevladbog/markiro/actions/runs/1"),
      ),
    );
    assert.equal(admissionReadFailure(error).stage, stage);
    assert.equal(admissionReadFailure(error).status, 502);
  }
});

test("artifact signed-download refusal keeps only a bounded hop and status", async () => {
  let requests = 0;
  const transport = githubTransport(secret, async () => {
    requests++;
    return requests === 1
      ? new Response(null, {
          status: 302,
          headers: { location: `https://example.invalid/archive?signature=${secret}` },
        })
      : new Response(secret, { status: 403 });
  });
  const error = await failed(() => transport.download("1"));
  assert.equal(requests, 2);
  assert.equal(admissionReadFailure(error).stage, "artifact-download");
  assert.equal(admissionReadFailure(error).reason, "http");
  assert.equal(admissionReadFailure(error).status, 403);
  assert.equal(admissionReadFailure(error).redirectCount, 1);
  assert.doesNotMatch(JSON.stringify(sanitizeHostFailure(error, context)), new RegExp(secret));
});

test("JSON body overflow keeps the existing two MiB denial and reports the bound", async () => {
  const transport = githubTransport(secret, async () => new Response(new Uint8Array(2097153)));
  const error = await failed(() => transport.json("/runs/1"));
  assert.equal(admissionReadFailure(error).reason, "body-limit");
  assert.equal(admissionReadFailure(error).limitBytes, 2097152);
  assert.equal(admissionReadFailure(error).bytesSeen, 2097153);
});

test("declared oversize JSON is denied before reading a private body", async () => {
  const transport = githubTransport(
    secret,
    async () => new Response(secret, { headers: { "content-length": "2097153" } }),
  );
  const error = await failed(() => transport.json("/runs/1"));
  assert.equal(admissionReadFailure(error).reason, "body-limit");
  assert.equal(admissionReadFailure(error).limitBytes, 2097152);
  assert.doesNotMatch(JSON.stringify(admissionReadFailure(error)), new RegExp(secret));
});

test("artifact overflow still fails at one MiB", async () => {
  let requests = 0;
  const transport = githubTransport(secret, async () =>
    ++requests === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "https://example.invalid/archive" },
        })
      : new Response(new Uint8Array(1048577)),
  );
  const error = await failed(() => transport.download("1"));
  assert.equal(requests, 2);
  assert.equal(admissionReadFailure(error).reason, "body-limit");
  assert.equal(admissionReadFailure(error).limitBytes, 1048576);
});

test("redirect exhaustion stops at the existing four signed hops", async () => {
  let requests = 0;
  const transport = githubTransport(secret, async () => {
    requests++;
    return new Response(null, {
      status: 302,
      headers: { location: `https://example.invalid/${requests}?private=${secret}` },
    });
  });
  const error = await failed(() => transport.download("1"));
  assert.equal(requests, 5);
  assert.equal(admissionReadFailure(error).reason, "redirect");
  assert.equal(admissionReadFailure(error).redirectCount, 4);
  assert.doesNotMatch(JSON.stringify(admissionReadFailure(error)), new RegExp(secret));
});

test("native timeout is identified without copying its private message", async () => {
  const transport = githubTransport(secret, async () => {
    throw new DOMException(secret, "TimeoutError");
  });
  const error = await failed(() => transport.json("/runs/1"));
  assert.equal(admissionReadFailure(error).reason, "timeout");
  assert.doesNotMatch(JSON.stringify(sanitizeHostFailure(error, context)), new RegExp(secret));
});

test("later wrappers cannot replace the first admission read failure", async () => {
  const transport = githubTransport(secret, async () => new Response(secret, { status: 503 }));
  const first = observationError(await failed(() => transport.json("/runs/1")));
  const final = await failed(() =>
    withAdmissionReadStage("publisher-recheck", () => {
      throw first;
    }),
  );
  const record = sanitizeHostFailure(final, context);
  assert.equal(record.admissionRead.stage, "publisher");
  assert.equal(record.admissionRead.status, 503);
});

test("admission stage preserves trusted child exit metadata", async () => {
  const child = noteHostProcessFailure(new Error(secret), "/usr/bin/python3", 23);
  const error = await failed(() =>
    withAdmissionReadStage("artifact-archive", () => {
      throw child;
    }),
  );
  const record = sanitizeHostFailure(observationError(error), context);
  assert.equal(record.executable, "python3");
  assert.equal(record.exitStatus, 23);
  assert.equal(record.admissionRead.stage, "artifact-archive");
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
});

test("caller-supplied diagnostic properties and getters are never trusted", async () => {
  let reads = 0;
  const error = {};
  for (const key of ["admissionRead", "message", "stack", "cause", "name", "code", "status"])
    Object.defineProperty(error, key, {
      get() {
        reads++;
        throw new Error(secret);
      },
    });
  assert.equal(admissionReadFailure(error), undefined);
  const wrapped = await failed(() =>
    withAdmissionReadStage("product-ci", () => {
      throw error;
    }),
  );
  const record = sanitizeHostFailure(observationError(wrapped), context);
  assert.equal(reads, 0);
  assert.equal(record.admissionRead.stage, "product-ci");
  assert.equal(record.admissionRead.reason, "validation");
  assert.equal(record.admissionRead.status, null);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
});

test("invalid stages and unknown thrown strings never become diagnostic payload", async () => {
  const invalid = await failed(() => withAdmissionReadStage(secret, () => undefined));
  assert.equal(admissionReadFailure(invalid), undefined);
  const error = await failed(() =>
    withAdmissionReadStage("publisher", () => {
      throw secret;
    }),
  );
  assert.equal(admissionReadFailure(error).stage, "publisher");
  assert.doesNotMatch(JSON.stringify(sanitizeHostFailure(error, context)), new RegExp(secret));
});

for (const [stage, id] of [
  ["product-ci", "123"],
  ["executor-ci", "124"],
])
  test(`host admission distinguishes ${stage} refusal after actual archive validation`, async (t) => {
    const { commandIntegrationFixture, integrationOptions } =
      await import("./host-command-integration-fixture.mjs");
    const { verifyAdmission } = await import("../host/command.mjs");
    const f = await commandIntegrationFixture(t);
    const options = await integrationOptions(f.root);
    const request = (url, init) =>
      new URL(url).pathname.includes(`/runs/${id}`)
        ? Promise.resolve(new Response(secret, { status: 502 }))
        : options.request(url, init);
    const error = await failed(() =>
      verifyAdmission(
        { record: f.record, receipt: f.receipt, operationDirectory: f.root },
        options.runProcess,
        request,
      ),
    );
    assert.equal(admissionReadFailure(error)?.stage, stage);
    assert.equal(admissionReadFailure(error)?.status, 502);
    assert.doesNotMatch(JSON.stringify(sanitizeHostFailure(error, context)), new RegExp(secret));
  });
