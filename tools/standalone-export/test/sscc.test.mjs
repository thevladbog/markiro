import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  BOX_WINDOW,
  PALLET_WINDOW,
  SERIAL_CAPACITY,
  START_STEP,
  cloudReseedTo,
  firstSerial,
  issuedMax,
  planShiftNumberCounters,
  planSsccCounters,
  standaloneStart,
  windowOf,
} from "../sscc.mjs";

const none = { counterNext: null, blockMax: null, printedMax: null };

test("boxes start at serial 1 and pallets at 0", () => {
  assert.equal(firstSerial(0), 1);
  assert.equal(firstSerial(1), 0);
});

test("the highest issued serial is the largest of counter − 1, a block's end and a printed serial", () => {
  assert.equal(issuedMax({ extension: 0, ...none, counterNext: 18_500 }), 18_499);
  assert.equal(issuedMax({ extension: 0, ...none, counterNext: 18_500, blockMax: 19_999 }), 19_999);
  assert.equal(
    issuedMax({ extension: 0, counterNext: 18_500, blockMax: 19_999, printedMax: 21_003 }),
    21_003,
  );
  assert.equal(issuedMax({ extension: 0, ...none, blockMax: 7 }), 7);
  assert.equal(issuedMax({ extension: 0, ...none, printedMax: 3 }), 3);
});

test("a counter at its extension's first serial handed out nothing", () => {
  assert.equal(issuedMax({ extension: 0, ...none, counterNext: 1 }), null);
  assert.equal(issuedMax({ extension: 0, ...none, counterNext: 2 }), 1);
  assert.equal(issuedMax({ extension: 1, ...none, counterNext: 0 }), null);
  assert.equal(issuedMax({ extension: 1, ...none, counterNext: 1 }), 0);
  assert.equal(issuedMax({ extension: 0, ...none }), null);
});

test("the start is one above the issued serial, rounded up to the next 10 000", () => {
  assert.equal(standaloneStart(0, null), 1);
  assert.equal(standaloneStart(1, null), 0);
  assert.equal(standaloneStart(1, 0), 10_000);
  assert.equal(standaloneStart(0, 9_998), 10_000);
  assert.equal(standaloneStart(0, 9_999), 10_000);
  assert.equal(standaloneStart(0, 10_000), 20_000);
  assert.equal(standaloneStart(0, 21_003), 30_000);
  assert.equal(standaloneStart(0, 9_989_999), 9_990_000);
});

test("the cloud moves past the window, or nowhere when the window leaves the prefix", () => {
  assert.equal(cloudReseedTo(30_000, 0), 30_000 + BOX_WINDOW);
  assert.equal(cloudReseedTo(10_000, 1), 10_000 + PALLET_WINDOW);
  assert.equal(cloudReseedTo(SERIAL_CAPACITY - BOX_WINDOW - 1, 0), SERIAL_CAPACITY - 1);
  assert.equal(cloudReseedTo(SERIAL_CAPACITY - BOX_WINDOW, 0), null);
  assert.equal(cloudReseedTo(30_000, 0, { box: 5_000, pallet: 50 }), 35_000);
  assert.equal(cloudReseedTo(30_000, 1, { box: 5_000, pallet: 50 }), 30_050);
});

test("every prefix and extension of the counters, blocks and printed codes gets a row", () => {
  const owners = (prefix) =>
    prefix === "460068200" ? { kind: "organization" } : { kind: "unknown" };
  const rows = planSsccCounters(
    {
      organizationPrefix: null,
      counters: [
        { issuerPrefix: "460068200", extension: 1, nextSerial: 301 },
        { issuerPrefix: "460068200", extension: 0, nextSerial: 18_500 },
      ],
      blocks: [
        {
          issuerPrefix: "460068200",
          extension: 0,
          maxToSerial: 19_999,
          maxConsumedThrough: 18_750,
        },
        { issuerPrefix: "460068200", extension: 1, maxToSerial: 400, maxConsumedThrough: 250 },
      ],
      printed: [
        { issuerPrefix: "460068200", extension: 0, maxSerial: 21_003 },
        { issuerPrefix: "460000001", extension: 0, maxSerial: 5 },
      ],
    },
    owners,
  );
  assert.deepEqual(rows, [
    {
      issuerPrefix: "460000001",
      extension: 0,
      owner: { kind: "unknown" },
      issuedMax: 5,
      printedMax: 5,
      standaloneStart: 10_000,
      cloudReseedTo: 1_010_000,
    },
    {
      issuerPrefix: "460068200",
      extension: 0,
      owner: { kind: "organization" },
      issuedMax: 21_003,
      printedMax: 21_003,
      standaloneStart: 30_000,
      cloudReseedTo: 1_030_000,
    },
    {
      issuerPrefix: "460068200",
      extension: 1,
      owner: { kind: "organization" },
      issuedMax: 400,
      printedMax: 250,
      standaloneStart: 10_000,
      cloudReseedTo: 110_000,
    },
  ]);
});

test("a prefix the cloud used up stops the export", () => {
  assert.throws(
    () =>
      planSsccCounters(
        {
          organizationPrefix: null,
          counters: [{ issuerPrefix: "460068200", extension: 0, nextSerial: SERIAL_CAPACITY }],
          blocks: [],
          printed: [],
        },
        () => ({ kind: "organization" }),
      ),
    /every serial of prefix 460068200, extension 0/u,
  );
});

test("the organization's prefix gets both extensions, even one the cloud never issued under", () => {
  const owners = (prefix) =>
    prefix === "460068200" ? { kind: "organization" } : { kind: "unknown" };
  // Pallets came late: the cloud has a box counter and a box block, nothing for pallets.
  const rows = planSsccCounters(
    {
      organizationPrefix: "460068200",
      counters: [{ issuerPrefix: "460068200", extension: 0, nextSerial: 18_500 }],
      blocks: [
        { issuerPrefix: "460068200", extension: 0, maxToSerial: 19_999, maxConsumedThrough: 3 },
      ],
      printed: [],
    },
    owners,
  );
  assert.deepEqual(rows, [
    {
      issuerPrefix: "460068200",
      extension: 0,
      owner: { kind: "organization" },
      issuedMax: 19_999,
      printedMax: 3,
      standaloneStart: 20_000,
      cloudReseedTo: 1_020_000,
    },
    {
      issuerPrefix: "460068200",
      extension: 1,
      owner: { kind: "organization" },
      issuedMax: null,
      printedMax: null,
      standaloneStart: 0,
      cloudReseedTo: PALLET_WINDOW,
    },
  ]);
  // Boxes too: a cloud that issued nothing at all still gets both rows.
  assert.deepEqual(
    planSsccCounters(
      { organizationPrefix: "460068200", counters: [], blocks: [], printed: [] },
      owners,
    ).map((each) => [each.extension, each.issuedMax, each.standaloneStart, each.cloudReseedTo]),
    [
      [0, null, 1, 1 + BOX_WINDOW],
      [1, null, 0, PALLET_WINDOW],
    ],
  );
  // Another prefix's rows stay as they were; the organization's are not repeated.
  assert.deepEqual(
    planSsccCounters(
      {
        organizationPrefix: "460068200",
        counters: [
          { issuerPrefix: "460068200", extension: 1, nextSerial: 5 },
          { issuerPrefix: "460123400", extension: 0, nextSerial: 1 },
        ],
        blocks: [],
        printed: [],
      },
      owners,
    ).map((each) => `${each.issuerPrefix}/${each.extension}`),
    ["460068200/0", "460068200/1", "460123400/0"],
  );
});

test("the organization's prefix is required, checked like any prefix, and null means none", () => {
  assert.throws(
    () => planSsccCounters({ counters: [], blocks: [], printed: [] }, () => ({ kind: "unknown" })),
    /organizationPrefix is required/u,
  );
  assert.throws(
    () =>
      planSsccCounters(
        { organizationPrefix: "46006820", counters: [], blocks: [], printed: [] },
        () => ({ kind: "organization" }),
      ),
    /issuer prefix "46006820" is not 9 digits/u,
  );
  assert.deepEqual(
    planSsccCounters({ organizationPrefix: null, counters: [], blocks: [], printed: [] }, () => ({
      kind: "organization",
    })),
    [],
  );
});

test("shift-number counters keep every month that drew a number, by month key", () => {
  assert.deepEqual(
    planShiftNumberCounters([
      { monthKey: "OCT26", lastSeq: 7 },
      { monthKey: "NOV26", lastSeq: 0 },
      { monthKey: "SEP26", lastSeq: 41 },
      { monthKey: "Sep26", lastSeq: 3 },
      { monthKey: "SEP2026", lastSeq: 3 },
    ]),
    [
      { monthKey: "OCT26", lastSeq: 7 },
      { monthKey: "SEP26", lastSeq: 41 },
    ],
  );
  assert.deepEqual(planShiftNumberCounters([{ monthKey: "JAN27", lastSeq: 1 }]), [
    { monthKey: "JAN27", lastSeq: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// Beyond the brief: every boundary that keeps a serial from being issued twice.
// ---------------------------------------------------------------------------

const organization = () => ({ kind: "organization" });
const PREFIX = "460068200";
const plan = (input, windows) =>
  planSsccCounters(
    { organizationPrefix: null, counters: [], blocks: [], printed: [], ...input },
    organization,
    windows,
  );

/** Independent GS1 mod-10 check digit, so the fixture is checked without the domain package. */
function checkDigit(body) {
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    const weight = (body.length - index) % 2 === 1 ? 3 : 1;
    sum += Number(body[index]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

test("the window constants and the serial space are the owner's figures", () => {
  assert.equal(SERIAL_CAPACITY, 10_000_000);
  assert.equal(START_STEP, 10_000);
  assert.equal(BOX_WINDOW, 1_000_000);
  assert.equal(PALLET_WINDOW, 100_000);
  assert.equal(windowOf(0), 1_000_000);
  assert.equal(windowOf(1), 100_000);
  assert.equal(windowOf(0, { box: 7, pallet: 9 }), 7);
  assert.equal(windowOf(1, { box: 7, pallet: 9 }), 9);
});

test("the serial space is the 7 digits a 9-digit prefix leaves, as the shared SSCC fixture shows", () => {
  assert.equal(SERIAL_CAPACITY, 10 ** (16 - 9));
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../apps/standalone/proto/fixtures/sscc-serials.json", import.meta.url),
      "utf8",
    ),
  );
  const nineDigit = fixture.cases.filter((each) => each.issuerPrefix.length === 9);
  assert.ok(nineDigit.length >= 4);
  for (const each of nineDigit) {
    const body = String(each.extension) + each.issuerPrefix + String(each.serial).padStart(7, "0");
    assert.equal(body + String(checkDigit(body)), each.sscc);
    assert.ok(each.serial < SERIAL_CAPACITY);
  }
  // The largest serial of the fixture is the last one the space holds.
  assert.equal(Math.max(...nineDigit.map((each) => each.serial)), SERIAL_CAPACITY - 1);
});

test("every start and the last serial of the space build a valid SSCC with the domain's buildSscc", async (context) => {
  let domain;
  try {
    domain = await import("../../../packages/domain/dist/gs1/sscc.js");
  } catch (error) {
    // Only a domain that is not built is a skip; a broken one must fail the test.
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    context.skip("packages/domain is not built (pnpm turbo run build --filter=@markiro/domain)");
    return;
  }
  const { buildSscc, isValidSscc, ssccSerialCapacity } = domain;
  assert.equal(ssccSerialCapacity(PREFIX), SERIAL_CAPACITY);
  assert.throws(() => buildSscc(0, PREFIX, SERIAL_CAPACITY), /outside 0\.\.9999999/u);
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../apps/standalone/proto/fixtures/sscc-serials.json", import.meta.url),
      "utf8",
    ),
  );
  for (const each of fixture.cases) {
    assert.equal(buildSscc(each.extension, each.issuerPrefix, each.serial), each.sscc);
  }
  const rows = plan({
    counters: [
      { issuerPrefix: PREFIX, extension: 0, nextSerial: 18_500 },
      { issuerPrefix: PREFIX, extension: 1, nextSerial: 0 },
      { issuerPrefix: "460000001", extension: 1, nextSerial: 9_989_999 },
    ],
  });
  assert.equal(rows.length, 3);
  for (const row of rows) {
    for (const serial of [row.standaloneStart, SERIAL_CAPACITY - 1]) {
      assert.ok(isValidSscc(buildSscc(row.extension, row.issuerPrefix, serial)));
    }
    if (row.cloudReseedTo !== null) {
      assert.ok(isValidSscc(buildSscc(row.extension, row.issuerPrefix, row.cloudReseedTo)));
    }
  }
});

test("the start stays on the 10 000 grid and is always above everything issued", () => {
  for (const extension of [0, 1]) {
    for (let issued = 0; issued < 30_500; issued += 7) {
      const start = standaloneStart(extension, issued);
      assert.ok(start > issued, `${extension}:${issued} -> ${start}`);
      assert.equal(start % START_STEP, 0);
      assert.ok(start - issued <= START_STEP, `${extension}:${issued} -> ${start}`);
    }
  }
});

test("the serial space ends at 9 999 999: the last start fits, a start that would leave it stops the export", () => {
  const counterRow = (nextSerial) => ({ issuerPrefix: PREFIX, extension: 0, nextSerial });
  const last = plan({ counters: [counterRow(9_990_000)] });
  assert.equal(last.length, 1);
  assert.equal(last[0]?.issuedMax, 9_989_999);
  assert.equal(last[0]?.standaloneStart, 9_990_000);
  assert.equal(last[0]?.cloudReseedTo, null);
  // 9 990 000 is issued: the next multiple of 10 000 is the capacity itself.
  assert.throws(
    () => plan({ counters: [counterRow(9_990_001)] }),
    /every serial of prefix 460068200, extension 0/u,
  );
  // Serial 9 999 999 is issued: one above is not a serial of the prefix.
  assert.throws(() => plan({ counters: [counterRow(SERIAL_CAPACITY)] }), /extension 0/u);
  assert.throws(
    () =>
      plan({
        blocks: [
          { issuerPrefix: PREFIX, extension: 1, maxToSerial: 9_999_999, maxConsumedThrough: null },
        ],
      }),
    /every serial of prefix 460068200, extension 1/u,
  );
  assert.throws(
    () => plan({ printed: [{ issuerPrefix: PREFIX, extension: 0, maxSerial: 9_995_000 }] }),
    /every serial of prefix 460068200, extension 0/u,
  );
});

test("a start exactly on the capacity is refused, not rounded down", () => {
  assert.throws(
    () => plan({ printed: [{ issuerPrefix: PREFIX, extension: 0, maxSerial: 9_999_999 }] }),
    /every serial of prefix/u,
  );
  assert.throws(
    () => plan({ printed: [{ issuerPrefix: PREFIX, extension: 0, maxSerial: 9_990_000 }] }),
    /every serial of prefix/u,
  );
  assert.equal(
    plan({ printed: [{ issuerPrefix: PREFIX, extension: 0, maxSerial: 9_989_999 }] })[0]
      ?.standaloneStart,
    9_990_000,
  );
});

test("an empty tenant has no counters to plan", () => {
  assert.deepEqual(plan({}), []);
  assert.deepEqual(planShiftNumberCounters([]), []);
});

test("a prefix with only pallets gets a pallet row from serial 0 and no box row", () => {
  const rows = plan({ counters: [{ issuerPrefix: "460000002", extension: 1, nextSerial: 0 }] });
  assert.deepEqual(rows, [
    {
      issuerPrefix: "460000002",
      extension: 1,
      owner: { kind: "organization" },
      issuedMax: null,
      printedMax: null,
      standaloneStart: 0,
      cloudReseedTo: PALLET_WINDOW,
    },
  ]);
  const printedOnly = plan({
    printed: [{ issuerPrefix: "460000002", extension: 1, maxSerial: 0 }],
  });
  assert.equal(printedOnly.length, 1);
  assert.equal(printedOnly[0]?.issuedMax, 0);
  assert.equal(printedOnly[0]?.standaloneStart, 10_000);
});

test("a prefix with only boxes gets no pallet row, and one without an issued serial starts at serial 1", () => {
  const rows = plan({ counters: [{ issuerPrefix: "460000003", extension: 0, nextSerial: 1 }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.extension, 0);
  assert.equal(rows[0]?.issuedMax, null);
  assert.equal(rows[0]?.standaloneStart, 1);
  assert.equal(rows[0]?.cloudReseedTo, 1 + BOX_WINDOW);
});

test("several prefixes are planned apart and listed by prefix, then extension", () => {
  const rows = plan({
    counters: [
      { issuerPrefix: "460000003", extension: 1, nextSerial: 5 },
      { issuerPrefix: "460000001", extension: 1, nextSerial: 10_001 },
      { issuerPrefix: "460000002", extension: 0, nextSerial: 3 },
    ],
    blocks: [
      { issuerPrefix: "460000003", extension: 0, maxToSerial: 15_000, maxConsumedThrough: null },
    ],
  });
  assert.deepEqual(
    rows.map((each) => [each.issuerPrefix, each.extension, each.issuedMax, each.standaloneStart]),
    [
      ["460000001", 1, 10_000, 20_000],
      ["460000002", 0, 2, 10_000],
      ["460000003", 0, 15_000, 20_000],
      ["460000003", 1, 4, 10_000],
    ],
  );
});

test("a block cut to an offline station counts although the cloud's counter moved back below it", () => {
  // The cloud reseeded the counter down to 5 000 after revoking a block that ended at 25 000.
  const [row] = plan({
    counters: [{ issuerPrefix: PREFIX, extension: 0, nextSerial: 5_000 }],
    blocks: [
      { issuerPrefix: PREFIX, extension: 0, maxToSerial: 25_000, maxConsumedThrough: 22_000 },
    ],
  });
  assert.equal(row?.issuedMax, 25_000);
  assert.equal(row?.printedMax, 22_000);
  assert.equal(row?.standaloneStart, 30_000);
});

test("boxes printed before blocks existed count although no block or counter names them", () => {
  const [row] = plan({
    counters: [{ issuerPrefix: PREFIX, extension: 0, nextSerial: 1 }],
    printed: [{ issuerPrefix: PREFIX, extension: 0, maxSerial: 10_000 }],
  });
  assert.equal(row?.issuedMax, 10_000);
  assert.equal(row?.standaloneStart, 20_000);
});

test("a consumed serial above its block's end still counts as issued", () => {
  const [row] = plan({
    blocks: [
      { issuerPrefix: PREFIX, extension: 0, maxToSerial: 8_000, maxConsumedThrough: 12_000 },
    ],
  });
  assert.equal(row?.issuedMax, 12_000);
  assert.equal(row?.printedMax, 12_000);
  assert.equal(row?.standaloneStart, 20_000);
});

test("several block rows of one key keep the largest, in either order", () => {
  const small = { issuerPrefix: PREFIX, extension: 0, maxToSerial: 2_000, maxConsumedThrough: 100 };
  const large = {
    issuerPrefix: PREFIX,
    extension: 0,
    maxToSerial: 14_000,
    maxConsumedThrough: 900,
  };
  for (const blocks of [
    [small, large],
    [large, small],
  ]) {
    const [row] = plan({ blocks });
    assert.equal(row?.issuedMax, 14_000);
    assert.equal(row?.printedMax, 900);
  }
  for (const counters of [
    [
      { issuerPrefix: PREFIX, extension: 0, nextSerial: 900 },
      { issuerPrefix: PREFIX, extension: 0, nextSerial: 14_001 },
    ],
    [
      { issuerPrefix: PREFIX, extension: 0, nextSerial: 14_001 },
      { issuerPrefix: PREFIX, extension: 0, nextSerial: 900 },
    ],
  ]) {
    assert.equal(plan({ counters })[0]?.issuedMax, 14_000);
  }
  for (const printed of [
    [
      { issuerPrefix: PREFIX, extension: 0, maxSerial: 40 },
      { issuerPrefix: PREFIX, extension: 0, maxSerial: 41 },
    ],
    [
      { issuerPrefix: PREFIX, extension: 0, maxSerial: 41 },
      { issuerPrefix: PREFIX, extension: 0, maxSerial: 40 },
    ],
  ]) {
    assert.equal(plan({ printed })[0]?.issuedMax, 41);
  }
});

test("boxes and pallets of one prefix are counted apart", () => {
  const rows = plan({
    counters: [{ issuerPrefix: PREFIX, extension: 1, nextSerial: 400 }],
    printed: [{ issuerPrefix: PREFIX, extension: 0, maxSerial: 70_000 }],
  });
  assert.deepEqual(
    rows.map((each) => [each.extension, each.issuedMax, each.standaloneStart]),
    [
      [0, 70_000, 80_000],
      [1, 399, 10_000],
    ],
  );
});

test("the plan's own windows reach the cloud's reseed target", () => {
  const rows = plan(
    {
      counters: [
        { issuerPrefix: PREFIX, extension: 0, nextSerial: 18_500 },
        { issuerPrefix: PREFIX, extension: 1, nextSerial: 18_500 },
      ],
    },
    { box: 5_000, pallet: 50 },
  );
  assert.deepEqual(
    rows.map((each) => each.cloudReseedTo),
    [25_000, 20_050],
  );
});

test("a window that leaves the prefix gives no reseed target in the plan", () => {
  const [row] = plan({ counters: [{ issuerPrefix: PREFIX, extension: 0, nextSerial: 9_500_001 }] });
  assert.equal(row?.issuedMax, 9_500_000);
  assert.equal(row?.standaloneStart, 9_510_000);
  assert.equal(row?.cloudReseedTo, null);
});

test("each row names its own owner", () => {
  const seen = [];
  const rows = planSsccCounters(
    {
      organizationPrefix: null,
      counters: [
        { issuerPrefix: "460000001", extension: 0, nextSerial: 2 },
        { issuerPrefix: "460000001", extension: 1, nextSerial: 2 },
        { issuerPrefix: "460000002", extension: 0, nextSerial: 2 },
      ],
      blocks: [],
      printed: [],
    },
    (prefix) => {
      seen.push(prefix);
      return { kind: "counterparty", prefix };
    },
  );
  assert.deepEqual(
    rows.map((each) => each.owner),
    [
      { kind: "counterparty", prefix: "460000001" },
      { kind: "counterparty", prefix: "460000001" },
      { kind: "counterparty", prefix: "460000002" },
    ],
  );
  assert.ok(seen.length >= 3);
});

test("a prefix that is not 9 digits stops the export: its serial space is not 7 digits wide", () => {
  for (const issuerPrefix of [
    "46006820",
    "4600682000",
    "46006820X",
    "",
    " 460068200",
    "4600682001\n",
  ]) {
    assert.throws(
      () => plan({ counters: [{ issuerPrefix, extension: 0, nextSerial: 5 }] }),
      /issuer prefix .* is not 9 digits/u,
      JSON.stringify(issuerPrefix),
    );
    assert.throws(
      () =>
        plan({
          blocks: [{ issuerPrefix, extension: 0, maxToSerial: 5, maxConsumedThrough: null }],
        }),
      /not 9 digits/u,
    );
    assert.throws(
      () => plan({ printed: [{ issuerPrefix, extension: 0, maxSerial: 5 }] }),
      /not 9 digits/u,
    );
  }
  assert.throws(
    () => plan({ counters: [{ issuerPrefix: 460068200, extension: 0, nextSerial: 5 }] }),
    /not 9 digits/u,
  );
});

test("an extension digit other than 0 (boxes) and 1 (pallets) stops the export", () => {
  for (const extension of [2, 9, -1, 0.5, "0", null, undefined]) {
    assert.throws(
      () => plan({ counters: [{ issuerPrefix: PREFIX, extension, nextSerial: 5 }] }),
      /prefix 460068200, extension .*: extension digit .* is neither 0 \(boxes\) nor 1 \(pallets\)/u,
      String(extension),
    );
  }
  assert.throws(() => standaloneStart(2, null), /neither 0/u);
  assert.throws(() => firstSerial(2), /neither 0/u);
  assert.throws(() => windowOf(2), /neither 0/u);
  assert.throws(() => cloudReseedTo(10_000, 2), /neither 0/u);
  assert.throws(() => issuedMax({ extension: 2, ...none }), /neither 0/u);
});

test("a serial that is no whole number in range stops the export instead of poisoning the maximum", () => {
  const bad = [NaN, Infinity, -1, 1.5, "18500", undefined, 10_000_001];
  for (const value of bad) {
    assert.throws(
      () => issuedMax({ extension: 0, ...none, counterNext: value }),
      /counterNext/u,
      `counterNext ${String(value)}`,
    );
  }
  for (const value of [NaN, -1, 1.5, "7", undefined, SERIAL_CAPACITY]) {
    assert.throws(() => issuedMax({ extension: 0, ...none, blockMax: value }), /blockMax/u);
    assert.throws(() => issuedMax({ extension: 0, ...none, printedMax: value }), /printedMax/u);
  }
  assert.throws(
    () =>
      plan({
        blocks: [{ issuerPrefix: PREFIX, extension: 0, maxToSerial: 5, maxConsumedThrough: "7" }],
      }),
    /prefix 460068200, extension 0: maxConsumedThrough/u,
  );
  assert.throws(
    () =>
      plan({
        blocks: [
          {
            issuerPrefix: PREFIX,
            extension: 0,
            maxToSerial: 5,
            maxConsumedThrough: SERIAL_CAPACITY,
          },
        ],
      }),
    /maxConsumedThrough/u,
  );
  assert.throws(
    () => plan({ counters: [{ issuerPrefix: PREFIX, extension: 1, nextSerial: -4 }] }),
    /prefix 460068200, extension 1: counterNext/u,
  );
  assert.equal(
    issuedMax({ extension: 0, ...none, counterNext: SERIAL_CAPACITY }),
    SERIAL_CAPACITY - 1,
  );
});

test("a bad number in a block or a printed row names its prefix and extension", () => {
  assert.throws(
    () =>
      plan({
        blocks: [{ issuerPrefix: PREFIX, extension: 0, maxToSerial: -1, maxConsumedThrough: null }],
      }),
    /prefix 460068200, extension 0: blockMax -1/u,
  );
  assert.throws(
    () => plan({ printed: [{ issuerPrefix: PREFIX, extension: 1, maxSerial: NaN }] }),
    /prefix 460068200, extension 1: printedMax NaN/u,
  );
  assert.throws(
    () => plan({ printed: [{ issuerPrefix: PREFIX, extension: 1, maxSerial: SERIAL_CAPACITY }] }),
    /prefix 460068200, extension 1: printedMax/u,
  );
});

test("a bad number is refused even when a larger row of the same key would hide it", () => {
  assert.throws(
    () =>
      plan({
        counters: [
          { issuerPrefix: PREFIX, extension: 0, nextSerial: 5_000 },
          { issuerPrefix: PREFIX, extension: 0, nextSerial: -3 },
        ],
      }),
    /prefix 460068200, extension 0: counterNext -3/u,
  );
  assert.throws(
    () =>
      plan({
        blocks: [
          { issuerPrefix: PREFIX, extension: 1, maxToSerial: 5_000, maxConsumedThrough: null },
          { issuerPrefix: PREFIX, extension: 1, maxToSerial: -3, maxConsumedThrough: null },
        ],
      }),
    /prefix 460068200, extension 1: blockMax -3/u,
  );
  assert.throws(
    () =>
      plan({
        printed: [
          { issuerPrefix: PREFIX, extension: 0, maxSerial: 5_000 },
          { issuerPrefix: PREFIX, extension: 0, maxSerial: -3 },
        ],
      }),
    /prefix 460068200, extension 0: printedMax -3/u,
  );
});

test("the start of an issued serial that is no serial is refused", () => {
  for (const issued of [-1, NaN, 1.5, "5", undefined, SERIAL_CAPACITY]) {
    assert.throws(() => standaloneStart(0, issued), /issued/u, String(issued));
  }
  assert.throws(() => standaloneStart(2, 5), /neither 0/u);
});

test("the plan reads the input without changing it", () => {
  const input = {
    organizationPrefix: PREFIX,
    counters: [{ issuerPrefix: PREFIX, extension: 0, nextSerial: 18_500 }],
    blocks: [{ issuerPrefix: PREFIX, extension: 0, maxToSerial: 19_999, maxConsumedThrough: 3 }],
    printed: [{ issuerPrefix: PREFIX, extension: 0, maxSerial: 21_003 }],
  };
  const copy = structuredClone(input);
  planSsccCounters(input, organization);
  assert.deepEqual(input, copy);
});

test("shift numbers: only MONYY keys of the twelve months, anchored at both ends", () => {
  const months = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];
  const kept = planShiftNumberCounters(
    months.map((month) => ({ monthKey: `${month}26`, lastSeq: 2 })),
  );
  assert.equal(kept.length, 12);
  const dropped = planShiftNumberCounters(
    [
      "ABC26",
      "XSEP26",
      "SEP26X",
      "SEP2",
      "SEP",
      "26SEP",
      "SEP 26",
      " SEP26",
      "SEP26\n",
      "sep26",
      "",
      "SEP-26",
      "ЯНВ26",
    ].map((monthKey) => ({ monthKey, lastSeq: 5 })),
  );
  assert.deepEqual(dropped, []);
});

test("shift numbers: a counter that never drew a number, or holds no whole number, is left out", () => {
  assert.deepEqual(
    planShiftNumberCounters([
      { monthKey: "JAN26", lastSeq: 0 },
      { monthKey: "FEB26", lastSeq: -3 },
      { monthKey: "MAR26", lastSeq: 1.5 },
      { monthKey: "APR26", lastSeq: NaN },
      { monthKey: "MAY26", lastSeq: "4" },
      { monthKey: "JUN26", lastSeq: null },
      { monthKey: "JUL26", lastSeq: 1 },
    ]),
    [{ monthKey: "JUL26", lastSeq: 1 }],
  );
});

test("shift numbers: a month named twice continues from the larger counter, never the smaller", () => {
  for (const counters of [
    [
      { monthKey: "SEP26", lastSeq: 41 },
      { monthKey: "SEP26", lastSeq: 9 },
    ],
    [
      { monthKey: "SEP26", lastSeq: 9 },
      { monthKey: "SEP26", lastSeq: 41 },
    ],
  ]) {
    assert.deepEqual(planShiftNumberCounters(counters), [{ monthKey: "SEP26", lastSeq: 41 }]);
  }
});

test("shift numbers: the list is by month key and carries nothing but the key and the sequence", () => {
  const out = planShiftNumberCounters([
    { monthKey: "SEP26", lastSeq: 2, tenantId: "t" },
    { monthKey: "AUG26", lastSeq: 3, extra: 1 },
    { monthKey: "DEC25", lastSeq: 4 },
  ]);
  assert.deepEqual(out, [
    { monthKey: "AUG26", lastSeq: 3 },
    { monthKey: "DEC25", lastSeq: 4 },
    { monthKey: "SEP26", lastSeq: 2 },
  ]);
});

test("a rollback window that is no positive whole number stops the export", () => {
  for (const bad of [
    0,
    -5_000,
    1.5,
    Number.NaN,
    "50",
    null,
    undefined,
    Number.MAX_SAFE_INTEGER + 2,
  ]) {
    assert.throws(
      () => windowOf(0, { box: bad, pallet: 100_000 }),
      (error) => error instanceof RangeError && /rollback window/u.test(error.message),
      `box window ${String(bad)}`,
    );
    assert.throws(
      () => cloudReseedTo(30_000, 1, { box: 1_000_000, pallet: bad }),
      (error) => error instanceof RangeError && /rollback window/u.test(error.message),
      `pallet window ${String(bad)}`,
    );
  }
  assert.equal(windowOf(0, { box: 1, pallet: 1 }), 1);
  assert.equal(windowOf(1, { box: 1, pallet: 2 }), 2);
  assert.equal(cloudReseedTo(30_000, 0, { box: 1, pallet: 1 }), 30_001);
  // The window of the other extension is not looked at.
  assert.equal(windowOf(0, { box: 5, pallet: "x" }), 5);
});
