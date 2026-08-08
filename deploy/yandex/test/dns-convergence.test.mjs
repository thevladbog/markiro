import assert from "node:assert/strict";
import test from "node:test";

import { runDnsConvergence } from "../dns-convergence.mjs";

const RELEASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const DNS_APPLY_DIGEST = `sha256:${"c".repeat(64)}`;
const ADMIN_DOMAIN = "admin.markiro.example";
const KIOSK_DOMAIN = "kiosk.markiro.example";
const ANSWERS = {
  [ADMIN_DOMAIN]: ["203.0.113.10"],
  [KIOSK_DOMAIN]: ["203.0.113.10"],
};
const DNS_APPLY_VALUE = {
  adminDomain: ADMIN_DOMAIN,
  answers: ANSWERS,
  appliedAt: "2026-08-05T12:30:00.000Z",
  dnsApplyRunId: "234567891",
  kioskDomain: KIOSK_DOMAIN,
  publicDnsEnabled: true,
  releaseSha: RELEASE_SHA,
};

function fixture() {
  const calls = [];
  const dnsApply = structuredClone(DNS_APPLY_VALUE);
  const environment = {
    MARKIRO_DOMAIN: ADMIN_DOMAIN,
    MARKIRO_KIOSK_DOMAIN: KIOSK_DOMAIN,
    MARKIRO_AUTHORITATIVE_DNS_SERVER: "ns1.example.test",
    MARKIRO_PUBLIC_DNS_RESOLVERS: "resolver-one.example.test,resolver-two.example.test",
    MARKIRO_APPROVED_DNS_A: "203.0.113.10",
    MARKIRO_APPROVED_DNS_AAAA: "none",
    RELEASE_SHA,
    DNS_APPLY_RUN_ID: "234567891",
    DNS_APPLY_ARTIFACT_DIGEST: DNS_APPLY_DIGEST,
    DNS_APPLY_RECEIPT_PATH: "/runner/public-dns-apply.json",
    DNS_CONVERGENCE_RECEIPT_PATH: "/runner/dns-convergence.json",
    GITHUB_RUN_ID: "345678912",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: RELEASE_SHA,
  };
  const dependencies = {
    readFile: async () => JSON.stringify(dnsApply),
    verifyDns: async (options) => {
      calls.push(["verify DNS", options]);
      return { answers: structuredClone(ANSWERS), attempt: 3 };
    },
    now: () => new Date("2026-08-05T13:00:00.000Z"),
    writeFile: async (path, contents, options) => {
      calls.push(["write receipt", path, JSON.parse(contents), options]);
    },
  };
  return { calls, dependencies, dnsApply, environment };
}

test("DNS convergence records authenticated DNS-apply provenance and exact verified answer sets", async () => {
  const { calls, dependencies, environment } = fixture();

  const receipt = await runDnsConvergence(environment, dependencies);

  assert.deepEqual(calls, [
    [
      "verify DNS",
      {
        adminDomain: ADMIN_DOMAIN,
        kioskDomain: KIOSK_DOMAIN,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver-one.example.test", "resolver-two.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
      },
    ],
    [
      "write receipt",
      "/runner/dns-convergence.json",
      {
        adminDomain: ADMIN_DOMAIN,
        answers: ANSWERS,
        appliedAt: "2026-08-05T12:30:00.000Z",
        authoritativeServer: "ns1.example.test",
        dnsApplyArtifactDigest: DNS_APPLY_DIGEST,
        dnsApplyRunId: "234567891",
        kioskDomain: KIOSK_DOMAIN,
        publicResolvers: ["resolver-one.example.test", "resolver-two.example.test"],
        releaseSha: RELEASE_SHA,
        verificationAttempt: 3,
        verifiedAt: "2026-08-05T13:00:00.000Z",
        verifierRunAttempt: "2",
        verifierRunId: "345678912",
      },
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    ],
  ]);
  assert.equal(receipt.verifiedAt, "2026-08-05T13:00:00.000Z");
});

test("DNS convergence rejects an alternate workflow ref before querying DNS", async () => {
  const { calls, dependencies, environment } = fixture();
  environment.GITHUB_REF = "refs/heads/review-copy";

  await assert.rejects(runDnsConvergence(environment, dependencies), /DNS convergence evidence/);

  assert.deepEqual(calls, []);
});

test("DNS convergence rejects a receipt timestamp that does not follow the DNS apply", async () => {
  const { calls, dependencies, environment } = fixture();
  dependencies.now = () => new Date("2026-08-05T12:30:00.000Z");

  await assert.rejects(runDnsConvergence(environment, dependencies), /DNS convergence evidence/);

  assert.deepEqual(calls, [
    [
      "verify DNS",
      {
        adminDomain: ADMIN_DOMAIN,
        kioskDomain: KIOSK_DOMAIN,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver-one.example.test", "resolver-two.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
      },
    ],
  ]);
});

test("DNS convergence rejects malformed, split, duplicate, or swapped dual-domain apply evidence before querying DNS", async () => {
  const mutations = [
    (receipt) => delete receipt.answers[KIOSK_DOMAIN],
    (receipt) => (receipt.answers["extra.markiro.example"] = ["203.0.113.10"]),
    (receipt) => (receipt.answers[KIOSK_DOMAIN] = []),
    (receipt) => (receipt.answers[KIOSK_DOMAIN] = ["203.0.113.11", "203.0.113.10"]),
    (receipt) => (receipt.answers[KIOSK_DOMAIN] = ["203.0.113.10", "203.0.113.10"]),
    (receipt) => (receipt.answers[KIOSK_DOMAIN] = ["203.0.113.11"]),
    (receipt) => (receipt.kioskDomain = receipt.adminDomain),
    (receipt) => {
      [receipt.adminDomain, receipt.kioskDomain] = [receipt.kioskDomain, receipt.adminDomain];
    },
  ];

  for (const mutate of mutations) {
    const { calls, dependencies, dnsApply, environment } = fixture();
    mutate(dnsApply);

    await assert.rejects(runDnsConvergence(environment, dependencies), /DNS convergence evidence/);
    assert.deepEqual(calls, []);
  }
});
