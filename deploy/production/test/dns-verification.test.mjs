import assert from "node:assert/strict";
import test from "node:test";

import { dnsOptionsFromEnvironment, verifyDnsConvergence, verifyDnsOnce } from "../verify-dns.mjs";

const domain = "app.markiro.example";

function digOutput({
  status = "NOERROR",
  flags = ["qr", "aa"],
  answers = [],
  authorityCount = 0,
} = {}) {
  return [
    `;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: 1234`,
    `;; flags: ${flags.join(" ")}; QUERY: 1, ANSWER: ${answers.length}, AUTHORITY: ${authorityCount}, ADDITIONAL: 0`,
    ...answers.map(({ type, value, owner = `${domain}.` }) => `${owner} 60 IN ${type} ${value}`),
    "",
  ].join("\n");
}

test("rejects an extra stale authoritative address instead of accepting set membership", async () => {
  const outputs = [
    digOutput({
      answers: [
        { type: "A", value: "203.0.113.10" },
        { type: "A", value: "203.0.113.99" },
      ],
    }),
  ];

  await assert.rejects(
    verifyDnsOnce(
      {
        domain,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
      },
      { runDig: async () => ({ code: 0, stdout: outputs.shift() }) },
    ),
    /authoritative A answer set differs from the approved set/,
  );
});

test("rejects a recursive cached response at the authoritative gate when AA is absent", async () => {
  const recursiveResponse = digOutput({
    flags: ["qr", "rd", "ra"],
    answers: [{ type: "A", value: "203.0.113.10" }],
  });

  await assert.rejects(
    verifyDnsOnce(
      {
        domain,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
      },
      { runDig: async () => ({ code: 0, stdout: recursiveResponse }) },
    ),
    /authoritative A response does not have the AA flag/,
  );
});

test("requires the exact order-insensitive A and AAAA sets from authoritative and public DNS", async () => {
  const outputs = [
    digOutput({
      answers: [
        { type: "A", value: "203.0.113.11" },
        { type: "A", value: "203.0.113.10" },
      ],
    }),
    digOutput({ answers: [{ type: "AAAA", value: "2001:db8::10" }] }),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [
        { type: "A", value: "203.0.113.10" },
        { type: "A", value: "203.0.113.11" },
      ],
    }),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "AAAA", value: "2001:0db8:0:0:0:0:0:10" }],
    }),
  ];
  const calls = [];

  await verifyDnsOnce(
    {
      domain,
      authoritativeServer: "ns1.example.test",
      publicResolvers: ["resolver.example.test"],
      approvedA: ["203.0.113.10", "203.0.113.11"],
      approvedAaaa: ["2001:db8::10"],
    },
    {
      runDig: async (args) => {
        calls.push(args);
        return { code: 0, stdout: outputs.shift() };
      },
    },
  );

  assert.deepEqual(calls, [
    ["@ns1.example.test", "+norecurse", "+noall", "+comments", "+answer", domain, "A"],
    ["@ns1.example.test", "+norecurse", "+noall", "+comments", "+answer", domain, "AAAA"],
    ["@resolver.example.test", "+recurse", "+noall", "+comments", "+answer", domain, "A"],
    ["@resolver.example.test", "+recurse", "+noall", "+comments", "+answer", domain, "AAAA"],
  ]);
});

test("rejects SERVFAIL even when an injected response contains an approved-looking answer", async () => {
  const servfail = digOutput({
    status: "SERVFAIL",
    answers: [{ type: "A", value: "203.0.113.10" }],
  });

  await assert.rejects(
    verifyDnsOnce(
      {
        domain,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
      },
      { runDig: async () => ({ code: 0, stdout: servfail }) },
    ),
    /authoritative A status is SERVFAIL, expected NOERROR/,
  );
});

test("rejects CNAME answer shapes instead of silently validating only their address members", async () => {
  const cnameAndAddress = digOutput({
    answers: [
      { type: "CNAME", value: "protected-ingress.example.test." },
      { type: "A", value: "203.0.113.10" },
    ],
  });

  await assert.rejects(
    verifyDnsOnce(
      {
        domain,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
      },
      { runDig: async () => ({ code: 0, stdout: cnameAndAddress }) },
    ),
    /authoritative A response contains unsupported CNAME data/,
  );
});

test("rejects a stale extra address from a public recursive resolver", async () => {
  const outputs = [
    digOutput({ answers: [{ type: "A", value: "203.0.113.10" }] }),
    digOutput(),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [
        { type: "A", value: "203.0.113.10" },
        { type: "A", value: "203.0.113.99" },
      ],
    }),
  ];

  await assert.rejects(
    verifyDnsOnce(
      {
        domain,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
      },
      { runDig: async () => ({ code: 0, stdout: outputs.shift() }) },
    ),
    /public resolver resolver\.example\.test A answer set differs from the approved set/,
  );
});

test("requires every explicitly approved public resolver to converge", async () => {
  const outputs = [
    digOutput({ answers: [{ type: "A", value: "203.0.113.10" }] }),
    digOutput(),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "A", value: "203.0.113.10" }],
    }),
    digOutput({ flags: ["qr", "rd", "ra"] }),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "A", value: "203.0.113.99" }],
    }),
  ];

  await assert.rejects(
    verifyDnsOnce(
      {
        domain,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver-one.example.test", "resolver-two.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
      },
      { runDig: async () => ({ code: 0, stdout: outputs.shift() }) },
    ),
    /public resolver resolver-two\.example\.test A answer set differs from the approved set/,
  );
});

test("rejects a non-recursive public referral for an approved empty AAAA set", async () => {
  const outputs = [
    digOutput({ answers: [{ type: "A", value: "203.0.113.10" }] }),
    digOutput(),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "A", value: "203.0.113.10" }],
    }),
    digOutput({ flags: ["qr", "rd"], authorityCount: 1 }),
  ];

  await assert.rejects(
    verifyDnsOnce(
      {
        domain,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
      },
      { runDig: async () => ({ code: 0, stdout: outputs.shift() }) },
    ),
    /public resolver resolver\.example\.test AAAA response does not have the RA flag/,
  );
});

test("rejects an approved address attached to an unrelated RR owner", async () => {
  const outputs = [
    digOutput({
      answers: [{ type: "A", value: "203.0.113.10", owner: "unrelated.example.test." }],
    }),
    digOutput(),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "A", value: "203.0.113.10" }],
    }),
    digOutput({ flags: ["qr", "rd", "ra"] }),
  ];

  await assert.rejects(
    verifyDnsOnce(
      {
        domain,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
      },
      { runDig: async () => ({ code: 0, stdout: outputs.shift() }) },
    ),
    /authoritative A answer owner does not match the requested domain/,
  );
});

test("accepts the requested RR owner case-insensitively with or without a trailing dot", async () => {
  const outputs = [
    digOutput({
      answers: [{ type: "A", value: "203.0.113.10", owner: "APP.MARKIRO.EXAMPLE" }],
    }),
    digOutput(),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "A", value: "203.0.113.10", owner: "App.Markiro.Example." }],
    }),
    digOutput({ flags: ["qr", "rd", "ra"] }),
  ];

  await verifyDnsOnce(
    {
      domain,
      authoritativeServer: "ns1.example.test",
      publicResolvers: ["resolver.example.test"],
      approvedA: ["203.0.113.10"],
      approvedAaaa: [],
    },
    { runDig: async () => ({ code: 0, stdout: outputs.shift() }) },
  );
});

test("rejects duplicate approved addresses instead of hiding operator input mistakes", async () => {
  await assert.rejects(
    verifyDnsOnce(
      {
        domain,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver.example.test"],
        approvedA: ["203.0.113.10", "203.0.113.10"],
        approvedAaaa: [],
      },
      { runDig: async () => ({ code: 0, stdout: digOutput() }) },
    ),
    /approved A set contains a duplicate address/,
  );
});

test("retries the complete verification within a bounded convergence budget", async () => {
  const outputs = [
    digOutput({
      answers: [
        { type: "A", value: "203.0.113.10" },
        { type: "A", value: "203.0.113.99" },
      ],
    }),
    digOutput({ answers: [{ type: "A", value: "203.0.113.10" }] }),
    digOutput(),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "A", value: "203.0.113.10" }],
    }),
    digOutput({ flags: ["qr", "rd", "ra"] }),
  ];
  const sleeps = [];

  await verifyDnsConvergence(
    {
      domain,
      authoritativeServer: "ns1.example.test",
      publicResolvers: ["resolver.example.test"],
      approvedA: ["203.0.113.10"],
      approvedAaaa: [],
      verificationAttempts: 2,
      verificationIntervalMs: 7,
    },
    {
      runDig: async () => ({ code: 0, stdout: outputs.shift() }),
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    },
  );

  assert.deepEqual(sleeps, [7]);
});

test("parses explicit A, AAAA, authoritative, and public-resolver operator inputs", () => {
  assert.deepEqual(
    dnsOptionsFromEnvironment({
      MARKIRO_DOMAIN: domain,
      MARKIRO_AUTHORITATIVE_DNS_SERVER: "ns1.example.test",
      MARKIRO_PUBLIC_DNS_RESOLVERS: "resolver-one.example.test,resolver-two.example.test",
      MARKIRO_APPROVED_DNS_A: "203.0.113.10,203.0.113.11",
      MARKIRO_APPROVED_DNS_AAAA: "none",
    }),
    {
      domain,
      authoritativeServer: "ns1.example.test",
      publicResolvers: ["resolver-one.example.test", "resolver-two.example.test"],
      approvedA: ["203.0.113.10", "203.0.113.11"],
      approvedAaaa: [],
    },
  );
});

test("fails closed on missing resolvers, empty address sets, and unsafe server tokens", () => {
  const baseline = {
    MARKIRO_DOMAIN: domain,
    MARKIRO_AUTHORITATIVE_DNS_SERVER: "ns1.example.test",
    MARKIRO_PUBLIC_DNS_RESOLVERS: "resolver.example.test",
    MARKIRO_APPROVED_DNS_A: "203.0.113.10",
    MARKIRO_APPROVED_DNS_AAAA: "none",
  };

  assert.throws(
    () => dnsOptionsFromEnvironment({ ...baseline, MARKIRO_PUBLIC_DNS_RESOLVERS: "none" }),
    /MARKIRO_PUBLIC_DNS_RESOLVERS is invalid/,
  );
  assert.throws(
    () =>
      dnsOptionsFromEnvironment({
        ...baseline,
        MARKIRO_APPROVED_DNS_A: "none",
        MARKIRO_APPROVED_DNS_AAAA: "none",
      }),
    /at least one approved A or AAAA address is required/,
  );
  assert.throws(
    () =>
      dnsOptionsFromEnvironment({
        ...baseline,
        MARKIRO_AUTHORITATIVE_DNS_SERVER: "ns1.example.test +recurse",
      }),
    /MARKIRO_AUTHORITATIVE_DNS_SERVER is invalid/,
  );
  assert.throws(
    () => dnsOptionsFromEnvironment({ ...baseline, MARKIRO_DOMAIN: "https://example.test" }),
    /MARKIRO_DOMAIN is invalid/,
  );
});

test("reports the sanitized last cause when the bounded convergence budget is exhausted", async () => {
  const stale = digOutput({
    answers: [
      { type: "A", value: "203.0.113.10" },
      { type: "A", value: "203.0.113.99" },
    ],
  });

  await assert.rejects(
    verifyDnsConvergence(
      {
        domain,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
        verificationAttempts: 2,
        verificationIntervalMs: 1,
      },
      {
        runDig: async () => ({ code: 0, stdout: stale }),
        sleep: async () => undefined,
      },
    ),
    (error) =>
      error.message ===
      "DNS verification failed after 2 attempts (last cause: authoritative A answer set differs from the approved set)",
  );
});
