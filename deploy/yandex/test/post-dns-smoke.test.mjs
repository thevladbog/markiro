import assert from "node:assert/strict";
import test from "node:test";

import { runPostDnsSmoke } from "../post-dns-smoke.mjs";

const RELEASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "f".repeat(40);
const DNS_APPLY_DIGEST = `sha256:${"c".repeat(64)}`;
const CONVERGENCE_DIGEST = `sha256:${"d".repeat(64)}`;
const FINALIZED_VALUE = {
  deploymentPhase: "first",
  deploymentRunId: "123456789",
  finalizedAt: "2026-08-05T12:00:00.000Z",
  releaseRunId: "987654321",
  releaseSha: RELEASE_SHA,
};
const DNS_APPLY_VALUE = {
  appliedAt: "2026-08-05T12:30:00.000Z",
  dnsApplyRunId: "234567891",
  publicDnsEnabled: true,
  releaseSha: RELEASE_SHA,
};
const CONVERGENCE_VALUE = {
  appliedAt: DNS_APPLY_VALUE.appliedAt,
  approvedA: ["203.0.113.10"],
  approvedAaaa: [],
  authoritativeServer: "ns1.example.test",
  dnsApplyArtifactDigest: DNS_APPLY_DIGEST,
  dnsApplyRunId: "234567891",
  domain: "markiro.example",
  publicResolvers: ["resolver-one.example.test", "resolver-two.example.test"],
  releaseSha: RELEASE_SHA,
  verificationAttempt: 3,
  verifiedAt: "2026-08-05T13:00:00.000Z",
  verifierRunAttempt: "2",
  verifierRunId: "345678912",
};

function fixture() {
  const calls = [];
  const values = {
    finalized: { ...FINALIZED_VALUE },
    dnsApply: { ...DNS_APPLY_VALUE },
    convergence: { ...CONVERGENCE_VALUE },
  };
  const times = [new Date("2026-08-05T13:30:00.000Z"), new Date("2026-08-05T13:31:00.000Z")];
  const mainShas = [RELEASE_SHA, RELEASE_SHA];
  const dependencies = {
    async readFile(path) {
      if (path.includes("finalized")) return JSON.stringify(values.finalized);
      if (path.includes("dns-apply")) return JSON.stringify(values.dnsApply);
      return JSON.stringify(values.convergence);
    },
    async currentMainSha() {
      const sha = mainShas.shift();
      calls.push(["current main", sha]);
      return sha;
    },
    async smoke(options) {
      calls.push(["public smoke", options]);
    },
    now: () => times.shift(),
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
    DNS_APPLY_ARTIFACT_DIGEST: DNS_APPLY_DIGEST,
    DNS_VERIFIER_RUN_ID: "345678912",
    DNS_CONVERGENCE_ARTIFACT_DIGEST: CONVERGENCE_DIGEST,
    FINALIZED_RELEASE_PATH: "/runner/finalized-release.json",
    DNS_APPLY_RECEIPT_PATH: "/runner/dns-apply.json",
    DNS_CONVERGENCE_RECEIPT_PATH: "/runner/dns-convergence.json",
    SMOKE_RECEIPT_PATH: "/runner/post-dns-smoke.json",
    GITHUB_RUN_ID: "456789123",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: RELEASE_SHA,
    GITHUB_REPOSITORY: "thevladbog/markiro",
    GITHUB_TOKEN: "test-token",
  };
  return { calls, dependencies, environment, mainShas, times, values };
}

test("post-DNS mode binds the exact ordered evidence chain to current main and the live release", async () => {
  const { calls, dependencies, environment } = fixture();

  const receipt = await runPostDnsSmoke(environment, dependencies);

  assert.deepEqual(calls, [
    ["current main", RELEASE_SHA],
    ["public smoke", { baseUrl: "https://markiro.example", expectedReleaseSha: RELEASE_SHA }],
    ["current main", RELEASE_SHA],
    [
      "write receipt",
      "/runner/post-dns-smoke.json",
      {
        appliedAt: "2026-08-05T12:30:00.000Z",
        deploymentRunId: "123456789",
        dnsApplyArtifactDigest: DNS_APPLY_DIGEST,
        dnsApplyRunId: "234567891",
        dnsConvergenceArtifactDigest: CONVERGENCE_DIGEST,
        dnsVerifierRunId: "345678912",
        finalizedAt: "2026-08-05T12:00:00.000Z",
        releaseRunId: "987654321",
        releaseSha: RELEASE_SHA,
        smokeAt: "2026-08-05T13:31:00.000Z",
        smokeRunId: "456789123",
        verifiedAt: "2026-08-05T13:00:00.000Z",
      },
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    ],
  ]);
  assert.equal(receipt.releaseSha, RELEASE_SHA);
});

test("post-DNS mode rejects alternate dispatch refs and SHAs before public requests", async () => {
  for (const mutate of [
    (environment) => (environment.GITHUB_REF = "refs/heads/review-copy"),
    (environment) => (environment.GITHUB_SHA = OTHER_SHA),
  ]) {
    const { calls, dependencies, environment } = fixture();
    mutate(environment);

    await assert.rejects(runPostDnsSmoke(environment, dependencies), /post-DNS smoke evidence/);

    assert.deepEqual(calls, []);
  }
});

test("post-DNS mode rejects every out-of-order lifecycle timestamp before public requests", async () => {
  for (const mutate of [
    (values) => (values.finalized.finalizedAt = values.dnsApply.appliedAt),
    (values) => (values.convergence.verifiedAt = values.dnsApply.appliedAt),
    (_values, times) => (times[0] = new Date(CONVERGENCE_VALUE.verifiedAt)),
  ]) {
    const { calls, dependencies, environment, times, values } = fixture();
    mutate(values, times);

    await assert.rejects(runPostDnsSmoke(environment, dependencies), /post-DNS smoke evidence/);

    assert.deepEqual(calls, []);
  }
});

test("post-DNS mode rejects an advancing main after smoke and never writes a receipt", async () => {
  const { calls, dependencies, environment, mainShas } = fixture();
  mainShas[1] = OTHER_SHA;

  await assert.rejects(runPostDnsSmoke(environment, dependencies), /post-DNS smoke evidence/);

  assert.deepEqual(calls, [
    ["current main", RELEASE_SHA],
    ["public smoke", { baseUrl: "https://markiro.example", expectedReleaseSha: RELEASE_SHA }],
    ["current main", OTHER_SHA],
  ]);
});

test("post-DNS mode rejects mismatched authenticated convergence provenance before public requests", async () => {
  const { calls, dependencies, environment, values } = fixture();
  values.convergence.dnsApplyArtifactDigest = `sha256:${"e".repeat(64)}`;

  await assert.rejects(runPostDnsSmoke(environment, dependencies), /post-DNS smoke evidence/);

  assert.deepEqual(calls, []);
});
