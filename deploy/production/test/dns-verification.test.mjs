import assert from "node:assert/strict";
import test from "node:test";

import { dnsOptionsFromEnvironment, verifyDnsConvergence, verifyDnsOnce } from "../verify-dns.mjs";

const domain = "app.markiro.example";

function digOutput({
  status = "NOERROR",
  flags = ["qr", "aa"],
  answers = [],
  authority = [],
  queryCount = 1,
  answerCount = answers.length,
  authorityCount = authority.length,
} = {}) {
  return [
    `;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: 1234`,
    `;; flags: ${flags.join(" ")}; QUERY: ${queryCount}, ANSWER: ${answerCount}, AUTHORITY: ${authorityCount}, ADDITIONAL: 0`,
    ...answers.map(({ type, value, owner = `${domain}.` }) => `${owner} 60 IN ${type} ${value}`),
    ...authority.map(({ type, value, owner = `${domain}.` }) => `${owner} 60 IN ${type} ${value}`),
    "",
  ].join("\n");
}

const soa = {
  type: "SOA",
  owner: "markiro.example.",
  value: "ns1.markiro.example. hostmaster.markiro.example. 1 3600 600 86400 60",
};

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

test("rejects authoritative and recursive responses when the QR response flag is absent", async () => {
  await assert.rejects(
    verifyDnsOnce(
      {
        domain,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
      },
      {
        runDig: async () => ({
          code: 0,
          stdout: digOutput({
            flags: ["aa"],
            answers: [{ type: "A", value: "203.0.113.10" }],
          }),
        }),
      },
    ),
    /authoritative A response does not have the QR flag/,
  );

  const outputs = [
    digOutput({ answers: [{ type: "A", value: "203.0.113.10" }] }),
    digOutput({ authority: [soa] }),
    digOutput({ flags: ["rd", "ra"], answers: [{ type: "A", value: "203.0.113.10" }] }),
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
    /public resolver resolver\.example\.test A response does not have the QR flag/,
  );
});

test("rejects dig parser warnings even when the response otherwise looks approved", async () => {
  const warned = digOutput({
    answers: [{ type: "A", value: "203.0.113.10" }],
  }).replace(";; flags:", ";; Warning: query response not set\n;; flags:");

  await assert.rejects(
    verifyDnsOnce(
      {
        domain,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
      },
      { runDig: async () => ({ code: 0, stdout: warned }) },
    ),
    /authoritative A dig output contains a parser warning/,
  );
});

test("requires the exact order-insensitive A and AAAA sets from authoritative and public DNS", async () => {
  const outputs = [
    digOutput({
      answers: [
        { type: "A", value: "203.0.113.11" },
        { type: "A", value: "203.0.113.10" },
      ],
      authority: [soa],
    }),
    digOutput({ answers: [{ type: "AAAA", value: "2001:db8::10" }] }),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [
        { type: "A", value: "203.0.113.10" },
        { type: "A", value: "203.0.113.11" },
      ],
      authority: [soa],
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
    [
      "@ns1.example.test",
      "+norecurse",
      "+noall",
      "+comments",
      "+answer",
      "+authority",
      domain,
      "A",
    ],
    [
      "@ns1.example.test",
      "+norecurse",
      "+noall",
      "+comments",
      "+answer",
      "+authority",
      domain,
      "AAAA",
    ],
    [
      "@resolver.example.test",
      "+recurse",
      "+noall",
      "+comments",
      "+answer",
      "+authority",
      domain,
      "A",
    ],
    [
      "@resolver.example.test",
      "+recurse",
      "+noall",
      "+comments",
      "+answer",
      "+authority",
      domain,
      "AAAA",
    ],
  ]);
});

test("accepts an empty approved family only when authoritative and recursive DNS prove NODATA with SOA", async () => {
  const outputs = [
    digOutput({ answers: [{ type: "A", value: "203.0.113.10" }] }),
    digOutput({ authority: [soa] }),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "A", value: "203.0.113.10" }],
    }),
    digOutput({ flags: ["qr", "rd", "ra"], authority: [soa] }),
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
    digOutput({ authority: [soa] }),
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
    digOutput({ authority: [soa] }),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "A", value: "203.0.113.10" }],
    }),
    digOutput({ flags: ["qr", "rd", "ra"], authority: [soa] }),
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
    digOutput({ authority: [soa] }),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "A", value: "203.0.113.10" }],
    }),
    digOutput({
      flags: ["qr", "rd"],
      authority: [{ type: "NS", value: "ns1.markiro.example." }],
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
    /public resolver resolver\.example\.test AAAA response does not have the RA flag/,
  );
});

test("rejects a recursive public referral for an approved empty AAAA set", async () => {
  const outputs = [
    digOutput({ answers: [{ type: "A", value: "203.0.113.10" }] }),
    digOutput({ authority: [soa] }),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "A", value: "203.0.113.10" }],
    }),
    digOutput({
      flags: ["qr", "rd", "ra"],
      authority: [{ type: "NS", value: "ns1.markiro.example." }],
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
    /public resolver resolver\.example\.test AAAA NODATA response does not contain an SOA record/,
  );
});

test("rejects unrelated and suffix-confusion SOA owners as NODATA proof", async () => {
  for (const owner of ["unrelated.example.test.", "iro.example."]) {
    const outputs = [
      digOutput({ answers: [{ type: "A", value: "203.0.113.10" }] }),
      digOutput({ authority: [{ ...soa, owner }] }),
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
      /authoritative AAAA NODATA SOA owner is not the requested domain or its ancestor/,
    );
  }
});

test("rejects DNS output whose section counts do not match the emitted records", async () => {
  const outputs = [
    digOutput({ answers: [{ type: "A", value: "203.0.113.10" }] }),
    digOutput({ authority: [soa], authorityCount: 2 }),
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
    /authoritative AAAA DNS section counts do not match the emitted records/,
  );
});

test("rejects a DNS header whose query count is inconsistent with the verifier request", async () => {
  await assert.rejects(
    verifyDnsOnce(
      {
        domain,
        authoritativeServer: "ns1.example.test",
        publicResolvers: ["resolver.example.test"],
        approvedA: ["203.0.113.10"],
        approvedAaaa: [],
      },
      {
        runDig: async () => ({
          code: 0,
          stdout: digOutput({
            queryCount: 0,
            answers: [{ type: "A", value: "203.0.113.10" }],
          }),
        }),
      },
    ),
    /authoritative A response has malformed DNS section counts/,
  );
});

test("rejects malformed SOA authority data instead of treating it as NODATA proof", async () => {
  const outputs = [
    digOutput({ answers: [{ type: "A", value: "203.0.113.10" }] }),
    digOutput({
      authority: [{ ...soa, value: "ns1.markiro.example. hostmaster.markiro.example." }],
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
    /authoritative AAAA NODATA response contains malformed SOA data/,
  );
});

test("rejects an approved address attached to an unrelated RR owner", async () => {
  const outputs = [
    digOutput({
      answers: [{ type: "A", value: "203.0.113.10", owner: "unrelated.example.test." }],
    }),
    digOutput({ authority: [soa] }),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "A", value: "203.0.113.10" }],
    }),
    digOutput({ flags: ["qr", "rd", "ra"], authority: [soa] }),
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
    digOutput({ authority: [soa] }),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "A", value: "203.0.113.10", owner: "App.Markiro.Example." }],
    }),
    digOutput({ flags: ["qr", "rd", "ra"], authority: [soa] }),
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
    digOutput({ authority: [soa] }),
    digOutput({
      flags: ["qr", "rd", "ra"],
      answers: [{ type: "A", value: "203.0.113.10" }],
    }),
    digOutput({ flags: ["qr", "rd", "ra"], authority: [soa] }),
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
