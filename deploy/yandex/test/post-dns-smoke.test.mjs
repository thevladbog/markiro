import assert from "node:assert/strict";
import test from "node:test";

import { runPostDnsSmoke } from "../post-dns-smoke.mjs";

const RELEASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const FINALIZED = JSON.stringify({
  deploymentPhase: "first",
  deploymentRunId: "123456789",
  finalizedAt: "2026-08-05T12:00:00.000Z",
  releaseRunId: "987654321",
  releaseSha: RELEASE_SHA,
});
const DNS_APPLY = JSON.stringify({
  appliedAt: "2026-08-05T12:30:00.000Z",
  dnsApplyRunId: "234567891",
  publicDnsEnabled: true,
  releaseSha: RELEASE_SHA,
});

function fixture() {
  const calls = [];
  const dependencies = {
    async readFile(path) {
      return path.includes("dns-apply") ? DNS_APPLY : FINALIZED;
    },
    async smoke(options) {
      calls.push(["public smoke", options]);
    },
    now: () => new Date("2026-08-05T13:00:00.000Z"),
    async writeFile(path, contents, options) {
      calls.push(["write receipt", path, JSON.parse(contents), options]);
    },
  };
  const environment = {
    MARKIRO_DOMAIN: "markiro.example",
    RELEASE_SHA,
    RELEASE_RUN_ID: "987654321",
    DEPLOYMENT_RUN_ID: "123456789",
    DNS_APPLY_RUN_ID: "234567891",
    DNS_CONVERGENCE_EVIDENCE_ID: "change-2026-08-05/dns-convergence-17",
    FINALIZED_RELEASE_PATH: "/runner/finalized-release.json",
    DNS_APPLY_RECEIPT_PATH: "/runner/dns-apply.json",
    SMOKE_RECEIPT_PATH: "/runner/post-dns-smoke.json",
    GITHUB_RUN_ID: "345678912",
  };
  return { calls, dependencies, environment };
}

test("post-DNS mode runs one full public route smoke for the exact finalized first release", async () => {
  const { calls, dependencies, environment } = fixture();

  const receipt = await runPostDnsSmoke(environment, dependencies);

  assert.deepEqual(calls, [
    ["public smoke", { baseUrl: "https://markiro.example" }],
    [
      "write receipt",
      "/runner/post-dns-smoke.json",
      {
        deploymentRunId: "123456789",
        dnsApplyRunId: "234567891",
        dnsConvergenceEvidenceId: "change-2026-08-05/dns-convergence-17",
        releaseSha: RELEASE_SHA,
        smokeRunId: "345678912",
        verifiedAt: "2026-08-05T13:00:00.000Z",
      },
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    ],
  ]);
  assert.equal(receipt.releaseSha, RELEASE_SHA);
});

test("post-DNS mode rejects mismatched finalization evidence without public requests", async () => {
  const { calls, dependencies, environment } = fixture();
  environment.RELEASE_SHA = "f".repeat(40);

  await assert.rejects(runPostDnsSmoke(environment, dependencies), /post-DNS smoke evidence/);

  assert.deepEqual(calls, []);
});

test("post-DNS mode rejects DNS apply evidence for a different release without public requests", async () => {
  const { calls, dependencies, environment } = fixture();
  dependencies.readFile = async (path) =>
    path.includes("dns-apply")
      ? JSON.stringify({ ...JSON.parse(DNS_APPLY), releaseSha: "f".repeat(40) })
      : FINALIZED;

  await assert.rejects(runPostDnsSmoke(environment, dependencies), /post-DNS smoke evidence/);

  assert.deepEqual(calls, []);
});
