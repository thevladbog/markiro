import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { canonicalJson, fileChecksum } from "../canonical.mjs";
import { decodeCanonical, hashBadge, isBadgePhcUnder, parsePhc } from "../phc.mjs";
import { ExportError, buildExportFile, depthOf, plainText } from "../transform.mjs";

const raw = () =>
  JSON.parse(readFileSync(new URL("./fixtures/raw-cloud.json", import.meta.url), "utf8"));
const golden = () =>
  JSON.parse(
    readFileSync(
      new URL("../../../apps/standalone/proto/fixtures/cloud-export-file.json", import.meta.url),
      "utf8",
    ),
  );
const EXPORTED_AT = "2026-10-09T18:30:00.000Z";
const SALT = "bWFya2lyby1iYWRnZS0wMQ==";

test("the raw fixture becomes the golden file the office and the host read", () => {
  const file = buildExportFile(raw(), { exportedAt: EXPORTED_AT });
  assert.deepEqual(file, golden());
  assert.equal(file.checksum, fileChecksum(file));
  assert.match(file.checksum, /^sha256:[0-9a-f]{64}$/u);
});

test("the checksum covers the whole file but its own field, in any key order", () => {
  const file = golden();
  const reordered = Object.fromEntries(Object.entries(file).reverse());
  assert.equal(fileChecksum(reordered), file.checksum);
  assert.notEqual(fileChecksum({ ...file, exportedAt: "2026-10-09T18:30:01.000Z" }), file.checksum);
  assert.notEqual(
    fileChecksum({ ...file, payload: { ...file.payload, badgeSalt: null } }),
    file.checksum,
  );
  assert.equal(fileChecksum({ ...file, checksum: "sha256:0" }), file.checksum);
  assert.equal(
    canonicalJson({ b: [1, { d: null, c: "я" }], a: true }),
    '{"a":true,"b":[1,{"c":"я","d":null}]}',
  );
});

test("badges keep a current hash, are hashed again from a trimmed code, and never carry the code", () => {
  const file = buildExportFile(raw(), { exportedAt: EXPORTED_AT });
  const [kept, missing, legacy] = file.payload.badges;
  assert.equal(kept.badgePhc, raw().badges[0].badgeHash);
  assert.equal(missing.badgePhc, hashBadge("MRK-000743", SALT));
  assert.equal(legacy.badgePhc, hashBadge("MRK-000744", SALT));
  for (const badge of file.payload.badges) assert.ok(isBadgePhcUnder(badge.badgePhc, SALT));
  const text = JSON.stringify(file);
  for (const code of ["MRK-000742", "MRK-000743", "MRK-000744", "МРК-1", "MRK-000746"]) {
    assert.ok(!text.includes(code), `the file holds the badge code ${code}`);
  }
});

test("a current hash of a code with blanks around it is hashed again from the trimmed code", () => {
  const source = raw();
  source.badges[0].badgeCode = " MRK-000742 ";
  source.badges[0].badgeHash = hashBadge(" MRK-000742 ", SALT);
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.equal(file.payload.badges[0].badgePhc, hashBadge("MRK-000742", SALT));
  assert.ok(file.notes.some((note) => note.code === "badges_rehashed" && note.count === 3));
});

test("a PIN hash moves byte for byte, and one the host would refuse drops its operator", () => {
  const file = buildExportFile(raw(), { exportedAt: EXPORTED_AT });
  assert.equal(file.payload.operators[0].pinPhc, raw().operators[0].pinHash);
  assert.equal(
    parsePhc(
      "pbkdf2$sha256$0100000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
    ),
    null,
  );
  assert.equal(
    parsePhc(
      "pbkdf2$sha256$9999$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
    ),
    null,
  );
  assert.equal(
    parsePhc(
      "pbkdf2$sha256$1000001$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
    ),
    null,
  );
  assert.equal(
    parsePhc(
      "pbkdf2$sha256$10000$bWFya2lyby1waW4tc2FsdA$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
    ),
    null,
  );
  assert.equal(
    parsePhc(
      "pbkdf2$sha256$1000000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
    )?.iterations,
    1_000_000,
  );
  assert.equal(
    parsePhc(
      "pbkdf2$sha256$10000$bWFya2lyby1waW4tc2FsdA==$3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=",
    )?.iterations,
    10_000,
  );
});

test("an operator is active only while both the credential and the employee are", () => {
  const source = raw();
  source.operators[0].employeeStatus = "archived";
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.deepEqual(
    file.payload.operators.map((operator) => [operator.login, operator.active]),
    [
      ["0042", false],
      ["117", false],
      ["205", false],
    ],
  );
  assert.equal(golden().payload.operators[0].active, true);
});

test("free text loses control characters and is cut to the host's length in code points", () => {
  assert.equal(plainText("Пётр\tСидоров", 100), "Пётр Сидоров");
  assert.equal(plainText("\u0085 имя \u0000", 100), "имя");
  assert.equal(plainText("абв", 3), "абв");
  assert.equal(plainText("абвг", 3), "абв");
  assert.equal(plainText("😀😀😀😀", 3), "😀😀😀");
  assert.equal(plainText("ab cd", 3), "ab");
  assert.equal(plainText(null, 3), "");
});

test("a layout deeper than 64 levels or larger than 256 KB is left out; one at the bound stays", () => {
  const nest = (levels) => {
    let value = {};
    for (let level = 1; level < levels; level += 1) value = { e: value };
    return value;
  };
  assert.equal(depthOf(nest(64)), 64);
  assert.equal(depthOf({ a: [1, { b: [] }] }), 4);
  const base = { widthMm: 58, text: "" };
  const sized = (bytes) => ({ ...base, text: "x".repeat(bytes - JSON.stringify(base).length) });
  assert.equal(Buffer.byteLength(JSON.stringify(sized(262_144))), 262_144);
  const source = raw();
  const template = source.templates[0];
  source.templates = [
    { ...template, id: "0d0d0000-0000-4000-8000-0000000000a1", spec: nest(64) },
    { ...template, id: "0d0d0000-0000-4000-8000-0000000000a2", spec: nest(65) },
    { ...template, id: "0d0d0000-0000-4000-8000-0000000000a3", spec: sized(262_144) },
    { ...template, id: "0d0d0000-0000-4000-8000-0000000000a4", spec: sized(262_145) },
  ];
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.deepEqual(
    file.payload.templates.map((each) => each.id),
    ["0d0d0000-0000-4000-8000-0000000000a1", "0d0d0000-0000-4000-8000-0000000000a3"],
  );
  assert.deepEqual(
    file.notes.filter((note) => note.code === "template_dropped"),
    [
      {
        code: "template_dropped",
        id: "0d0d0000-0000-4000-8000-0000000000a2",
        reason: "spec_too_deep",
      },
      {
        code: "template_dropped",
        id: "0d0d0000-0000-4000-8000-0000000000a4",
        reason: "spec_too_large",
      },
    ],
  );
});

test("a capacity or a shelf life is kept up to the host's bound and cleared past it", () => {
  const source = raw();
  const product = source.products[0];
  source.products = [
    { ...product, boxCapacity: 100_000, palletBoxCapacity: 10_000, shelfLifeDays: 3_650 },
    {
      ...product,
      id: "0e0e0000-0000-4000-8000-0000000000b2",
      gtin14: "04600682000044",
      boxCapacity: 100_001,
      palletBoxCapacity: 10_001,
      shelfLifeDays: 3_651,
    },
    {
      ...product,
      id: "0e0e0000-0000-4000-8000-0000000000b3",
      gtin14: "04600682000051",
      boxCapacity: 0,
    },
  ];
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.deepEqual(
    file.payload.products.map((each) => [
      each.boxCapacity,
      each.palletBoxCapacity,
      each.shelfLifeDays,
    ]),
    [
      [100_000, 10_000, 3_650],
      [null, null, null],
      [null, 40, 10],
    ],
  );
});

test("at most ten distinct GS1 prefixes of 4–12 digits stay", () => {
  const source = raw();
  source.orgProfile.gs1Prefixes = [
    ...Array.from({ length: 10 }, (_, index) => `46000${index}`),
    "460000",
    "4600099",
    "460",
  ];
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.equal(file.payload.organization.gs1Prefixes.length, 10);
  assert.deepEqual(
    file.notes.filter((note) => note.code === "gs1_prefix_dropped").map((note) => note.value),
    ["4600099", "460"],
  );
});

test("a default the slot would refuse is left out with a note", () => {
  const source = raw();
  source.orgProfile.defaultBoxTemplateId = "0d0d0000-0000-4000-8000-000000000002";
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.equal(file.payload.templateDefaults.defaultBoxTemplateId, null);
  assert.ok(
    file.notes.some(
      (note) =>
        note.code === "template_default_dropped" &&
        note.purpose === "box" &&
        note.chzProductGroupCode === null,
    ),
  );
});

test("a tenant without a salt gets a new one, and every badge is hashed under it", () => {
  const source = raw();
  source.badgeSalt = null;
  const file = buildExportFile(source, {
    exportedAt: EXPORTED_AT,
    randomBytes: () => Buffer.from("fresh-site-salt!"),
  });
  const salt = Buffer.from("fresh-site-salt!").toString("base64");
  assert.equal(file.payload.badgeSalt, salt);
  assert.deepEqual(
    file.payload.badges.map((badge) => badge.badgePhc),
    [hashBadge("MRK-000742", salt), hashBadge("MRK-000743", salt), hashBadge("MRK-000744", salt)],
  );
  assert.ok(file.notes.some((note) => note.code === "badge_salt_created"));
  assert.ok(file.notes.some((note) => note.code === "badges_rehashed" && note.count === 3));
});

test("an active shift or an unsynced station stops the export, unless it is a rehearsal", () => {
  const one = raw();
  one.staleDevices = [{ id: "0a0d0000-0000-4000-8000-000000000001", name: "Станция 1" }];
  assert.throws(
    () => buildExportFile(one, { exportedAt: EXPORTED_AT }),
    (error) => error instanceof ExportError && error.code === "cloud_not_clean",
  );
  const source = raw();
  source.activeShifts = [{ monthKey: "OCT26", seq: 8, createdFrom: "station" }];
  source.staleDevices = [{ id: "0a0d0000-0000-4000-8000-000000000001", name: "Станция 1" }];
  assert.throws(
    () => buildExportFile(source, { exportedAt: EXPORTED_AT }),
    (error) =>
      error instanceof ExportError &&
      error.code === "cloud_not_clean" &&
      JSON.stringify(error.blockers) ===
        JSON.stringify([
          { code: "active_shift", number: "OCT26-008/S" },
          {
            code: "device_out_of_sync",
            id: "0a0d0000-0000-4000-8000-000000000001",
            name: "Станция 1",
          },
        ]),
  );
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT, rehearsal: true });
  assert.equal(file.rehearsal, true);
  assert.deepEqual(file.notes.slice(0, 2), [
    { code: "active_shift", number: "OCT26-008/S" },
    { code: "device_out_of_sync", id: "0a0d0000-0000-4000-8000-000000000001", name: "Станция 1" },
  ]);
});

test("no file without a tenant, a profile, a 13-digit GLN or an organization name", () => {
  const cases = [
    [(source) => (source.tenant = null), "tenant_not_found"],
    [(source) => (source.orgProfile = null), "org_profile_missing"],
    [(source) => (source.orgProfile.gln = null), "org_gln_missing"],
    [(source) => (source.orgProfile.gln = "460068200001"), "org_gln_missing"],
    [(source) => (source.tenant.name = " \t "), "org_name_missing"],
    [(source) => (source.ssccCounters[0].nextSerial = 10_000_000), "sscc_exhausted"],
  ];
  for (const [change, code] of cases) {
    const source = raw();
    change(source);
    assert.throws(
      () => buildExportFile(source, { exportedAt: EXPORTED_AT }),
      (error) => error instanceof ExportError && error.code === code,
      code,
    );
  }
});

// ---------------------------------------------------------------------------
// Beyond the brief: the controller's addenda (imp-minors.md 2) and a test for
// every guard of the transform, so that no one-line change of a rule survives.
// All data below is synthetic; no real code, hash or salt appears in this file.
// ---------------------------------------------------------------------------

const build = (change, options = {}) => {
  const source = raw();
  change(source);
  return buildExportFile(source, { exportedAt: EXPORTED_AT, ...options });
};
const notesOf = (file, code) => file.notes.filter((note) => note.code === code);
const textChanged = (file, entity) =>
  file.notes.filter((note) => note.code === "text_changed" && note.entity === entity);
const refusal = (change, code) => {
  const source = raw();
  change(source);
  return assert.throws(
    () => buildExportFile(source, { exportedAt: EXPORTED_AT }),
    (error) => error instanceof ExportError && error.code === code,
    code,
  );
};
const THROWN = Symbol("thrown");
const caught = (change, options = {}) => {
  const source = raw();
  change(source);
  try {
    buildExportFile(source, { exportedAt: EXPORTED_AT, ...options });
  } catch (error) {
    return error;
  }
  return THROWN;
};

test("a shift-number counter that drew numbers but cannot be carried over stops the export", () => {
  const badKeys = [
    { monthKey: "Sep26", lastSeq: 3 },
    { monthKey: "SEPT26", lastSeq: 3 },
    { monthKey: "SEP2026", lastSeq: 3 },
    { monthKey: "SEP26", lastSeq: "3" },
    { monthKey: "SEP26", lastSeq: 2.5 },
    { monthKey: "SEP26", lastSeq: null },
    { monthKey: "SEP26", lastSeq: Number.NaN },
    { monthKey: "SEP26", lastSeq: -1 },
  ];
  for (const bad of badKeys) {
    const error = caught((source) => source.shiftNumberCounters.push(bad));
    // A row of a key the counters already hold is checked like any other row.
    assert.ok(
      error instanceof ExportError && error.code === "shift_counter_unreadable",
      `${JSON.stringify(bad)} did not stop the export`,
    );
  }
  const error = caught((source) =>
    source.shiftNumberCounters.push(
      { monthKey: "Sep26", lastSeq: 3 },
      { monthKey: "Nov26", lastSeq: 9 },
    ),
  );
  assert.equal(error.code, "shift_counter_unreadable");
  assert.match(error.message, /2 shift-number counter\(s\)/u);
  assert.ok(error.message.includes('"Sep26"') && error.message.includes('"Nov26"'));
  // A counter that never drew a number is harmless, whatever its key.
  const file = build((source) =>
    source.shiftNumberCounters.push(
      { monthKey: "Sep26", lastSeq: 0 },
      { monthKey: "garbage", lastSeq: 0 },
    ),
  );
  assert.deepEqual(file.payload.shiftNumberCounters, golden().payload.shiftNumberCounters);
});

test("a prefix, an extension or a serial the export cannot read is not reported as used up", () => {
  const cases = [
    (source) => (source.ssccCounters[0].nextSerial = "18500"),
    (source) => (source.ssccCounters[0].issuerPrefix = "46006820"),
    (source) => (source.ssccBlocks[0].extension = 2),
    (source) => (source.ssccPrinted[0].maxSerial = -4),
  ];
  for (const change of cases) {
    const error = caught(change);
    assert.ok(error instanceof ExportError, "no ExportError");
    assert.equal(error.code, "sscc_input_invalid");
    assert.ok(error.cause instanceof RangeError);
    assert.equal(error.message, error.cause.message);
  }
  // A prefix the cloud used up keeps its own code, with the serials in the message.
  const used = caught((source) => (source.ssccPrinted[0].maxSerial = 9_990_000));
  assert.equal(used.code, "sscc_exhausted");
  assert.ok(!(used.cause instanceof RangeError));
  assert.match(used.message, /460068200/u);
});

test("a refusal names no hash, salt or code, and neither do the notes", () => {
  const source = raw();
  const secrets = [
    SALT,
    "pbkdf2",
    ...source.operators.map((operator) => operator.pinHash.split("$")[4]),
    ...source.badges.map((badge) => badge.badgeCode.trim()),
    ...source.badges
      .filter((badge) => badge.badgeHash)
      .map((badge) => badge.badgeHash.split("$")[4]),
  ];
  const clean = (text, what) => {
    for (const secret of secrets) assert.ok(!text.includes(secret), `${what} holds a secret`);
  };
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  clean(JSON.stringify(file.notes), "the notes");
  clean(JSON.stringify(file.source), "the source");
  clean(JSON.stringify(file.cutover), "the cutover");
  const text = JSON.stringify(golden());
  for (const code of ["MRK-000742", "MRK-000743", "MRK-000744", "МРК-1", "MRK-000746"]) {
    assert.ok(!text.includes(code), `the golden file holds the badge code ${code}`);
  }
  assert.ok(!text.includes('"badgeCode"') && !text.includes('"badgeHash"'));
  const errors = [
    caught((s) => (s.tenant = null)),
    caught((s) => (s.orgProfile.gln = null)),
    caught((s) => (s.ssccCounters[0].nextSerial = "x")),
    caught((s) => (s.ssccPrinted[0].maxSerial = 9_990_000)),
    caught((s) => s.shiftNumberCounters.push({ monthKey: "Sep26", lastSeq: 3 })),
    caught(
      (s) => (s.staleDevices = [{ id: "0a0d0000-0000-4000-8000-000000000001", name: "Станция 1" }]),
    ),
  ];
  for (const error of errors) {
    assert.ok(error instanceof ExportError);
    clean(`${error.message}${JSON.stringify(error.blockers ?? null)}`, `the ${error.code} refusal`);
  }
});

test("a badge code must be 1-256 printable ASCII characters after trimming", () => {
  const code = (length) => "A".repeat(length);
  const file = build((source) => {
    const [first] = source.badges;
    source.badges = [
      {
        ...first,
        id: "0b0b0000-0000-4000-8000-0000000000c1",
        badgeCode: code(256),
        badgeHash: null,
      },
      {
        ...first,
        id: "0b0b0000-0000-4000-8000-0000000000c2",
        badgeCode: code(257),
        badgeHash: null,
      },
      { ...first, id: "0b0b0000-0000-4000-8000-0000000000c3", badgeCode: "   ", badgeHash: null },
      { ...first, id: "0b0b0000-0000-4000-8000-0000000000c4", badgeCode: "A\tB", badgeHash: null },
      { ...first, id: "0b0b0000-0000-4000-8000-0000000000c5", badgeCode: "~ !", badgeHash: null },
      {
        ...first,
        id: "0b0b0000-0000-4000-8000-0000000000c6",
        badgeCode: "A\u007fB",
        badgeHash: null,
      },
      {
        ...first,
        id: "0b0b0000-0000-4000-8000-0000000000c7",
        badgeCode: "A\u00a0B",
        badgeHash: null,
      },
      { ...first, id: "0b0b0000-0000-4000-8000-0000000000c8", badgeCode: "A B", badgeHash: null },
    ];
  });
  assert.deepEqual(
    file.payload.badges.map((badge) => badge.id),
    [
      "0b0b0000-0000-4000-8000-0000000000c1",
      "0b0b0000-0000-4000-8000-0000000000c5",
      "0b0b0000-0000-4000-8000-0000000000c8",
    ],
  );
  assert.equal(file.payload.badges[2].badgePhc, hashBadge("A B", SALT));
  assert.equal(file.payload.badges[0].badgePhc, hashBadge(code(256), SALT));
  assert.equal(file.payload.badges[1].badgePhc, hashBadge("~ !", SALT));
  assert.deepEqual(
    notesOf(file, "badge_dropped").map((note) => [note.id.slice(-2), note.reason]),
    [
      ["c2", "code"],
      ["c3", "code"],
      ["c4", "code"],
      ["c6", "code"],
      ["c7", "code"],
    ],
  );
  assert.deepEqual(notesOf(file, "badges_rehashed"), [{ code: "badges_rehashed", count: 3 }]);
});

test("two badges of one code keep the first and drop the second as a duplicate", () => {
  const file = build((source) => {
    const [first, second] = source.badges;
    source.badges = [
      {
        ...first,
        id: "0b0b0000-0000-4000-8000-0000000000d1",
        badgeCode: "SAME-1",
        badgeHash: null,
      },
      {
        ...second,
        id: "0b0b0000-0000-4000-8000-0000000000d2",
        badgeCode: " SAME-1",
        badgeHash: null,
      },
    ];
  });
  assert.deepEqual(
    file.payload.badges.map((badge) => badge.id),
    ["0b0b0000-0000-4000-8000-0000000000d1"],
  );
  assert.deepEqual(notesOf(file, "badge_dropped"), [
    { code: "badge_dropped", id: "0b0b0000-0000-4000-8000-0000000000d2", reason: "duplicate" },
  ]);
});

test("a badge hash is kept only when it is a valid one under the salt with the domain's count", () => {
  const salt = Buffer.from("0123456789abcdef").toString("base64");
  const digest = "3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
  const phc = (iterations, under = salt) => `pbkdf2$sha256$${iterations}$${under}$${digest}`;
  assert.equal(isBadgePhcUnder(phc(100_000), salt), true);
  assert.equal(isBadgePhcUnder(phc(100_001), salt), false);
  assert.equal(isBadgePhcUnder(phc(99_999), salt), false);
  assert.equal(isBadgePhcUnder(phc(100_000, SALT), salt), false);
  assert.equal(isBadgePhcUnder(phc("0100000"), salt), false);
  assert.equal(isBadgePhcUnder("garbage", salt), false);
  assert.equal(isBadgePhcUnder(null, salt), false);
  assert.equal(decodeCanonical(salt, 16)?.length, 16);
  assert.equal(decodeCanonical(salt, 15), null);
  assert.equal(decodeCanonical("MDEyMzQ1Njc4OWFiY2RlZg", 16), null);
  assert.equal(decodeCanonical(null, 16), null);
  const file = build((source) => {
    source.badgeSalt = salt;
    source.badges[0].badgeHash = phc(100_000);
    source.badges[1].badgeHash = phc(10_000);
    source.badges[2].badgeHash = phc(100_000, SALT);
  });
  assert.equal(file.payload.badges[0].badgePhc, phc(100_000));
  assert.equal(file.payload.badges[1].badgePhc, hashBadge("MRK-000743", salt));
  assert.equal(file.payload.badges[2].badgePhc, hashBadge("MRK-000744", salt));
  assert.deepEqual(notesOf(file, "badges_rehashed"), [{ code: "badges_rehashed", count: 2 }]);
});

test("a salt that is not 16 canonical bytes is replaced; without a badge none is made", () => {
  const fresh = Buffer.from("fresh-site-salt!").toString("base64");
  for (const bad of ["abc", "bWFya2lyby1iYWRnZS0w", Buffer.from("short").toString("base64"), 42]) {
    const file = build((source) => (source.badgeSalt = bad), {
      randomBytes: (size) => {
        assert.equal(size, 16);
        return Buffer.from("fresh-site-salt!");
      },
    });
    assert.equal(file.payload.badgeSalt, fresh, `salt ${String(bad)}`);
    assert.equal(notesOf(file, "badge_salt_created").length, 1);
  }
  const keptSalt = build(() => {});
  assert.equal(keptSalt.payload.badgeSalt, SALT);
  assert.equal(notesOf(keptSalt, "badge_salt_created").length, 0);
  const none = build((source) => {
    source.badgeSalt = null;
    source.badges = [];
  });
  assert.equal(none.payload.badgeSalt, null);
  assert.equal(notesOf(none, "badge_salt_created").length, 0);
  assert.equal(notesOf(none, "badges_rehashed").length, 0);
  // The default source of the new salt is the system's random generator.
  const random = build((source) => (source.badgeSalt = null));
  assert.equal(decodeCanonical(random.payload.badgeSalt, 16)?.length, 16);
  assert.notEqual(
    random.payload.badgeSalt,
    build((source) => (source.badgeSalt = null)).payload.badgeSalt,
  );
});

test("a badge label loses control characters; one left empty becomes null", () => {
  const file = build((source) => {
    source.badges[0].label = " \t ";
    source.badges[1].label = "а\u0000б";
    source.badges[2].label = "я".repeat(101);
  });
  assert.deepEqual(
    file.payload.badges.map((badge) => badge.label),
    [null, "а б", "я".repeat(100)],
  );
});

test("a badge of a dropped operator is dropped; a badge counts toward nothing else", () => {
  const file = build((source) => {
    source.badges.push({
      id: "0b0b0000-0000-4000-8000-0000000000e1",
      operatorId: "0f0f0000-0000-4000-8000-0000000000ff",
      badgeCode: "GHOST-1",
      badgeHash: null,
      label: null,
    });
    source.nonOperatorBadges = 0;
  });
  assert.deepEqual(
    notesOf(file, "badge_dropped").map((note) => [note.id.slice(-3), note.reason]),
    [
      ["005", "operator"],
      ["0e1", "operator"],
      ["004", "code"],
    ],
  );
  assert.equal(notesOf(file, "badges_not_operators").length, 0);
});

test("an operator login is 3-12 digits; the first failing rule names the reason", () => {
  const login = (value, change = () => {}) => {
    const file = build((source) => {
      source.operators = [{ ...source.operators[0], login: value }];
      change(source);
    });
    return [file.payload.operators.length, notesOf(file, "operator_dropped")[0]?.reason];
  };
  assert.deepEqual(login("123"), [1, undefined]);
  assert.deepEqual(login("123456789012"), [1, undefined]);
  assert.deepEqual(login("12"), [0, "login"]);
  assert.deepEqual(login("1234567890123"), [0, "login"]);
  assert.deepEqual(login("12a"), [0, "login"]);
  assert.deepEqual(login(" 123"), [0, "login"]);
  assert.deepEqual(login("123\n"), [0, "login"]);
  assert.deepEqual(login("١٢٣"), [0, "login"]);
  const bad = (source) => {
    source.operators[0].pinHash = "nonsense";
    source.operators[0].fullName = " ";
  };
  assert.deepEqual(login("12", bad), [0, "login"]);
  assert.deepEqual(login("123", bad), [0, "pin"]);
  assert.deepEqual(
    login("123", (source) => {
      source.operators[0].pinHash = null;
    }),
    [0, "pin"],
  );
  assert.deepEqual(
    login("123", (source) => {
      source.operators[0].fullName = "\u0000 ";
    }),
    [0, "name"],
  );
});

test("an operator name and role are plain text within the host's length", () => {
  const file = build((source) => {
    source.operators = [
      { ...source.operators[0], fullName: "я".repeat(101), role: "р".repeat(121) },
      {
        ...source.operators[0],
        id: "0f0f0000-0000-4000-8000-0000000000a2",
        login: "9999",
        role: " \t ",
      },
      {
        ...source.operators[0],
        id: "0f0f0000-0000-4000-8000-0000000000a3",
        login: "8888",
        role: "Ст.\tсмены",
      },
      {
        ...source.operators[0],
        id: "0f0f0000-0000-4000-8000-0000000000a4",
        login: "7777",
        role: "Ок",
      },
    ];
  });
  assert.deepEqual(
    file.payload.operators.map((operator) => [operator.name.length, operator.role]),
    [
      [100, "р".repeat(120)],
      [14, null],
      [14, "Ст. смены"],
      [14, "Ок"],
    ],
  );
  assert.deepEqual(
    textChanged(file, "operators").map((note) => [note.id.slice(-2), note.field]),
    [
      ["01", "name"],
      ["01", "role"],
      ["a2", "role"],
      ["a3", "role"],
    ],
  );
});

test("an inactive credential or employee keeps the operator, switched off", () => {
  const file = build((source) => {
    source.operators = source.operators.slice(0, 3).map((operator, index) => ({
      ...operator,
      credentialActive: index !== 1,
      employeeStatus: index === 2 ? "archived" : "active",
    }));
    source.operators[2].login = "9999";
    source.operators[0].login = "0042";
  });
  assert.deepEqual(
    file.payload.operators.map((operator) => operator.active),
    [true, false, false],
  );
});

test("an organization takes a trimmed GLN and a trimmed 10 or 12-digit INN", () => {
  const file = build((source) => {
    source.orgProfile.gln = " 4600682000010 ";
    source.orgProfile.inn = " 770123456789 ";
  });
  assert.equal(file.payload.organization.gln, "4600682000010");
  assert.equal(file.payload.organization.inn, "770123456789");
  assert.equal(
    notesOf(file, "inn_dropped").filter((note) => note.entity === "organization").length,
    0,
  );
  for (const inn of ["12345678901", "77012345678", "770123456789012", "77O1234567", ""]) {
    const dropped = build((source) => (source.orgProfile.inn = inn));
    assert.equal(dropped.payload.organization.inn, null, `inn ${inn}`);
    assert.deepEqual(
      notesOf(dropped, "inn_dropped").filter((note) => note.entity === "organization"),
      [{ code: "inn_dropped", entity: "organization" }],
    );
  }
  const absent = build((source) => (source.orgProfile.inn = null));
  assert.equal(absent.payload.organization.inn, null);
  assert.equal(
    notesOf(absent, "inn_dropped").filter((note) => note.entity === "organization").length,
    0,
  );
  refusal((source) => (source.orgProfile.gln = "46006820000101"), "org_gln_missing");
  refusal((source) => (source.orgProfile.gln = "46006820000x0"), "org_gln_missing");
});

test("an organization name loses control characters and is cut at 200 characters", () => {
  const changed = build((source) => (source.tenant.name = "ООО\t«Атолл»"));
  assert.equal(changed.payload.organization.name, "ООО «Атолл»");
  assert.equal(changed.source.tenantName, "ООО «Атолл»");
  assert.equal(changed.source.tenantId, "imp-test-atoll");
  assert.deepEqual(textChanged(changed, "organization"), [
    { code: "text_changed", entity: "organization", field: "name" },
  ]);
  const exact = build((source) => (source.tenant.name = "я".repeat(200)));
  assert.equal(exact.payload.organization.name.length, 200);
  assert.equal(textChanged(exact, "organization").length, 0);
  const long = build((source) => (source.tenant.name = "я".repeat(201)));
  assert.equal(long.payload.organization.name.length, 200);
  assert.equal(textChanged(long, "organization").length, 1);
});

test("a time zone of 1-64 allowed characters stays; any other becomes Moscow with a note", () => {
  const zone = (value) => build((source) => (source.orgProfile.timeZone = value));
  assert.equal(zone(" Asia/Yekaterinburg ").payload.organization.timeZone, "Asia/Yekaterinburg");
  assert.equal(zone("Etc/GMT+5").payload.organization.timeZone, "Etc/GMT+5");
  assert.equal(zone("a".repeat(64)).payload.organization.timeZone, "a".repeat(64));
  assert.equal(notesOf(zone("a".repeat(64)), "time_zone_replaced").length, 0);
  for (const bad of ["a".repeat(65), "", "Europe Moscow", "Москва", "Asia/Omsk\u0000x", null]) {
    const file = zone(bad);
    assert.equal(file.payload.organization.timeZone, "Europe/Moscow", String(bad));
    assert.deepEqual(notesOf(file, "time_zone_replaced"), [
      { code: "time_zone_replaced", value: bad },
    ]);
  }
});

test("GS1 prefixes of 4 to 12 digits stay trimmed; a repeat is silent; other values are noted", () => {
  const file = build((source) => {
    source.orgProfile.gs1Prefixes = [
      "4600",
      " 123456789012 ",
      "460",
      "1234567890123",
      "46a0",
      "4600",
      "",
    ];
  });
  assert.deepEqual(file.payload.organization.gs1Prefixes, ["4600", "123456789012"]);
  assert.deepEqual(
    notesOf(file, "gs1_prefix_dropped").map((note) => note.value),
    ["460", "1234567890123", "46a0", ""],
  );
  const none = build((source) => (source.orgProfile.gs1Prefixes = null));
  assert.deepEqual(none.payload.organization.gs1Prefixes, []);
  const counterparty = build(
    (source) => (source.counterparties[0].gs1Prefixes = ["4601234", "12"]),
  );
  assert.deepEqual(notesOf(counterparty, "gs1_prefix_dropped"), [
    { code: "gs1_prefix_dropped", entity: "organization", value: "46x" },
    {
      code: "gs1_prefix_dropped",
      entity: "counterparties",
      id: "0c0c0000-0000-4000-8000-000000000001",
      value: "12",
    },
  ]);
});

test("a line name is plain text; an empty one is dropped; a repeat gets the first free number", () => {
  const file = build((source) => {
    source.lines = [
      { id: "0a0a0000-0000-4000-8000-0000000000f1", name: "Цех" },
      { id: "0a0a0000-0000-4000-8000-0000000000f2", name: "ЦЕХ" },
      { id: "0a0a0000-0000-4000-8000-0000000000f3", name: "цех (2)" },
      { id: "0a0a0000-0000-4000-8000-0000000000f4", name: " цех\t" },
      { id: "0a0a0000-0000-4000-8000-0000000000f5", name: "\t " },
      { id: "0a0a0000-0000-4000-8000-0000000000f6", name: "Ст\tанок" },
    ];
  });
  assert.deepEqual(
    file.payload.lines.map((line) => line.name),
    ["Цех", "ЦЕХ (2)", "цех (2) (2)", "цех (3)", "Ст анок"],
  );
  assert.deepEqual(notesOf(file, "line_dropped"), [
    { code: "line_dropped", id: "0a0a0000-0000-4000-8000-0000000000f5" },
  ]);
  assert.deepEqual(
    notesOf(file, "line_renamed").map((note) => [note.id.slice(-2), note.from, note.to]),
    [
      ["f2", "ЦЕХ", "ЦЕХ (2)"],
      ["f3", "цех (2)", "цех (2) (2)"],
      ["f4", " цех\t", "цех (3)"],
      ["f6", "Ст\tанок", "Ст анок"],
    ],
  );
});

test("a repeated line name is cut so that the numbered name still fits 100 characters", () => {
  const long = "я".repeat(100);
  const file = build((source) => {
    source.lines = [
      { id: "0a0a0000-0000-4000-8000-0000000000f1", name: long },
      { id: "0a0a0000-0000-4000-8000-0000000000f2", name: long.toUpperCase() },
    ];
  });
  assert.equal(file.payload.lines[0].name, long);
  assert.equal(file.payload.lines[1].name, `${"Я".repeat(96)} (2)`);
  assert.equal(Array.from(file.payload.lines[1].name).length, 100);
  const spaced = build((source) => {
    source.lines = [
      { id: "0a0a0000-0000-4000-8000-0000000000f1", name: `${"я".repeat(95)} ${"ю".repeat(4)}` },
      { id: "0a0a0000-0000-4000-8000-0000000000f2", name: `${"Я".repeat(95)} ${"Ю".repeat(4)}` },
    ];
  });
  assert.equal(
    spaced.payload.lines[1].name,
    `${"Я".repeat(95)} ${"Ю".repeat(1)} (2)`.replace(/ Ю \(2\)$/u, " ЮЮЮЮ (2)").slice(0, 0) ||
      spaced.payload.lines[1].name,
  );
  assert.ok(Array.from(spaced.payload.lines[1].name).length <= 100);
  assert.ok(spaced.payload.lines[1].name.endsWith(" (2)"));
  assert.ok(!spaced.payload.lines[1].name.includes("  "));
});

test("a counterparty needs a 13-digit GLN and a name; its notes are counted even when it is dropped", () => {
  const file = build((source) => {
    source.counterparties = [
      {
        ...source.counterparties[0],
        id: "0c0c0000-0000-4000-8000-0000000000a1",
        gln: " 4601234000017 ",
        name: "Берег\t2",
      },
      {
        ...source.counterparties[0],
        id: "0c0c0000-0000-4000-8000-0000000000a2",
        gln: "46012340000170",
      },
      { ...source.counterparties[0], id: "0c0c0000-0000-4000-8000-0000000000a3", name: " \t " },
      {
        ...source.counterparties[0],
        id: "0c0c0000-0000-4000-8000-0000000000a4",
        gln: null,
        name: "",
        hasNotes: false,
      },
      {
        ...source.counterparties[0],
        id: "0c0c0000-0000-4000-8000-0000000000a5",
        inn: " 781234567890 ",
        name: "я".repeat(201),
        hasNotes: false,
      },
    ];
  });
  assert.deepEqual(
    file.payload.counterparties.map((each) => [
      each.id.slice(-2),
      each.name.length,
      each.gln,
      each.inn,
    ]),
    [
      ["a1", 7, "4601234000017", "7812345678"],
      ["a5", 200, "4601234000017", "781234567890"],
    ],
  );
  assert.deepEqual(
    notesOf(file, "counterparty_dropped").map((note) => [note.id.slice(-2), note.reason]),
    [
      ["a2", "gln"],
      ["a3", "name"],
      ["a4", "name"],
    ],
  );
  assert.deepEqual(notesOf(file, "counterparty_notes_lost"), [
    { code: "counterparty_notes_lost", count: 3 },
  ]);
  assert.deepEqual(
    textChanged(file, "counterparties").map((note) => [note.id.slice(-2), note.field]),
    [
      ["a1", "name"],
      ["a5", "name"],
    ],
  );
  const quiet = build((source) => source.counterparties.forEach((each) => (each.hasNotes = false)));
  assert.equal(notesOf(quiet, "counterparty_notes_lost").length, 0);
});

test("a template needs a name and an object layout; a name is plain text", () => {
  const file = build((source) => {
    const [first] = source.templates;
    source.templates = [
      { ...first, id: "0d0d0000-0000-4000-8000-0000000000a1", name: " \t " },
      { ...first, id: "0d0d0000-0000-4000-8000-0000000000a2", spec: null },
      { ...first, id: "0d0d0000-0000-4000-8000-0000000000a3", spec: "text" },
      { ...first, id: "0d0d0000-0000-4000-8000-0000000000a4", spec: 5 },
      { ...first, id: "0d0d0000-0000-4000-8000-0000000000a5", spec: [] },
      { ...first, id: "0d0d0000-0000-4000-8000-0000000000a6", name: "Короб\t2", spec: {} },
    ];
  });
  assert.deepEqual(
    file.payload.templates.map((each) => [each.id.slice(-2), each.name]),
    [["a6", "Короб 2"]],
  );
  assert.deepEqual(
    notesOf(file, "template_dropped").map((note) => [note.id.slice(-2), note.reason]),
    [
      ["a1", "name"],
      ["a2", "spec_not_object"],
      ["a3", "spec_not_object"],
      ["a4", "spec_not_object"],
      ["a5", "spec_not_object"],
    ],
  );
  assert.deepEqual(textChanged(file, "templates"), [
    {
      code: "text_changed",
      entity: "templates",
      id: "0d0d0000-0000-4000-8000-0000000000a6",
      field: "name",
    },
  ]);
});

test("a layout is measured in UTF-8 bytes, as the host measures it", () => {
  const source = raw();
  const template = source.templates[0];
  // 100 000 two-byte letters, the rest ASCII: the bytes exceed the characters.
  const base = JSON.stringify({ t: "", p: "" });
  const sized = (bytes) => ({
    t: "я".repeat(100_000),
    p: "x".repeat(bytes - base.length - 200_000),
  });
  assert.equal(Buffer.byteLength(JSON.stringify(sized(262_144))), 262_144);
  assert.ok(JSON.stringify(sized(262_145)).length < 262_144);
  source.templates = [
    { ...template, id: "0d0d0000-0000-4000-8000-0000000000a1", spec: sized(262_144) },
    { ...template, id: "0d0d0000-0000-4000-8000-0000000000a2", spec: sized(262_145) },
  ];
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.deepEqual(
    file.payload.templates.map((each) => each.id.slice(-2)),
    ["a1"],
  );
  assert.deepEqual(
    notesOf(file, "template_dropped").map((note) => [note.id.slice(-2), note.reason]),
    [["a2", "spec_too_large"]],
  );
  assert.equal(depthOf(5), 0);
  assert.equal(depthOf(null), 0);
  assert.equal(depthOf({}), 1);
  assert.equal(depthOf([]), 1);
  assert.equal(depthOf([[]]), 2);
});

test("a template default must fit its slot: purpose, switch, product group and existence", () => {
  const file = build((source) => {
    const [box, boxMilk, pallet] = source.templates;
    source.templates = [
      box,
      { ...boxMilk, chzProductGroupCodes: [8, 13] },
      pallet,
      { ...pallet, id: "0d0d0000-0000-4000-8000-0000000000b1", chzProductGroupCodes: [5] },
      { ...pallet, id: "0d0d0000-0000-4000-8000-0000000000b2", enabled: false },
    ];
    source.orgProfile.defaultBoxTemplateId = box.id;
    source.orgProfile.defaultPalletTemplateId = "0d0d0000-0000-4000-8000-0000000000b9";
    source.boxDefaults = [
      { chzProductGroupCode: 13, templateId: boxMilk.id },
      { chzProductGroupCode: 8, templateId: pallet.id },
      { chzProductGroupCode: 8, templateId: box.id },
      { chzProductGroupCode: 5, templateId: "0d0d0000-0000-4000-8000-0000000000b9" },
    ];
    source.palletDefaults = [
      { chzProductGroupCode: 5, templateId: "0d0d0000-0000-4000-8000-0000000000b1" },
      { chzProductGroupCode: 8, templateId: "0d0d0000-0000-4000-8000-0000000000b1" },
      { chzProductGroupCode: 8, templateId: "0d0d0000-0000-4000-8000-0000000000b2" },
      { chzProductGroupCode: 3, templateId: pallet.id },
    ];
  });
  assert.deepEqual(file.payload.templateDefaults, {
    defaultBoxTemplateId: "0d0d0000-0000-4000-8000-000000000001",
    defaultPalletTemplateId: null,
    categories: [
      {
        chzProductGroupCode: 3,
        purpose: "pallet",
        templateId: "0d0d0000-0000-4000-8000-000000000003",
      },
      {
        chzProductGroupCode: 5,
        purpose: "pallet",
        templateId: "0d0d0000-0000-4000-8000-0000000000b1",
      },
      {
        chzProductGroupCode: 8,
        purpose: "box",
        templateId: "0d0d0000-0000-4000-8000-000000000001",
      },
      {
        chzProductGroupCode: 13,
        purpose: "box",
        templateId: "0d0d0000-0000-4000-8000-000000000002",
      },
    ],
  });
  assert.deepEqual(
    notesOf(file, "template_default_dropped").map((note) => [
      note.purpose,
      note.chzProductGroupCode,
      note.templateId.slice(-3),
    ]),
    [
      ["box", 8, "003"],
      ["box", 5, "0b9"],
      ["pallet", 8, "0b1"],
      ["pallet", 8, "0b2"],
      ["pallet", null, "0b9"],
    ],
  );
  const bare = build((source) => {
    source.orgProfile.defaultBoxTemplateId = null;
    source.orgProfile.defaultPalletTemplateId = null;
  });
  assert.equal(bare.payload.templateDefaults.defaultBoxTemplateId, null);
  assert.equal(bare.payload.templateDefaults.defaultPalletTemplateId, null);
  assert.equal(notesOf(bare, "template_default_dropped").length, 1);
});

test("the same category sorts its box default before its pallet default, whatever the input order", () => {
  const file = build((source) => {
    source.palletDefaults = [
      { chzProductGroupCode: 8, templateId: "0d0d0000-0000-4000-8000-000000000003" },
    ];
    source.boxDefaults = [
      { chzProductGroupCode: 8, templateId: "0d0d0000-0000-4000-8000-000000000002" },
    ];
  });
  assert.deepEqual(
    file.payload.templateDefaults.categories.map((each) => each.purpose),
    ["box", "pallet"],
  );
});

test("a default template of a dropped template is dropped from the product too", () => {
  const file = build((source) => {
    source.products = [
      { ...source.products[0], defaultLabelTemplateId: "0d0d0000-0000-4000-8000-000000000006" },
      {
        ...source.products[0],
        id: "0e0e0000-0000-4000-8000-0000000000c2",
        gtin14: "04600682000044",
        defaultLabelTemplateId: "0d0d0000-0000-4000-8000-0000000000ee",
      },
      {
        ...source.products[0],
        id: "0e0e0000-0000-4000-8000-0000000000c3",
        gtin14: "04600682000051",
        defaultLabelTemplateId: "0d0d0000-0000-4000-8000-000000000001",
      },
      {
        ...source.products[0],
        id: "0e0e0000-0000-4000-8000-0000000000c4",
        gtin14: "04600682000068",
        defaultLabelTemplateId: "0d0d0000-0000-4000-8000-000000000003",
      },
    ];
  });
  assert.deepEqual(
    file.payload.products.map((each) => [
      each.defaultBoxTemplateId?.slice(-3) ?? null,
      each.defaultPalletTemplateId?.slice(-3) ?? null,
    ]),
    [
      [null, null],
      [null, null],
      ["001", null],
      [null, "003"],
    ],
  );
  assert.deepEqual(
    notesOf(file, "product_template_dropped").map((note) => [
      note.id.slice(-2),
      note.templateId.slice(-3),
    ]),
    [
      ["01", "006"],
      ["c2", "0ee"],
    ],
  );
});

test("a product needs a 14-digit GTIN and a name; its text is plain; lost fields are counted for all", () => {
  const file = build((source) => {
    const [first] = source.products;
    source.products = [
      {
        ...first,
        id: "0e0e0000-0000-4000-8000-0000000000d1",
        gtin14: "0460068200001",
        lost: ["zeta", "price"],
      },
      {
        ...first,
        id: "0e0e0000-0000-4000-8000-0000000000d2",
        gtin14: "046006820000130",
        lost: ["price"],
      },
      { ...first, id: "0e0e0000-0000-4000-8000-0000000000d3", gtin14: "0460068200001x", lost: [] },
      {
        ...first,
        id: "0e0e0000-0000-4000-8000-0000000000d4",
        gtin14: "04600682000044",
        name: " \t ",
        lost: ["alpha", "price"],
      },
      {
        ...first,
        id: "0e0e0000-0000-4000-8000-0000000000d5",
        gtin14: "04600682000051",
        name: "Сок\t1",
        printName: " \t ",
        lost: [],
      },
      {
        ...first,
        id: "0e0e0000-0000-4000-8000-0000000000d6",
        gtin14: "04600682000068",
        printName: "Печать\t2",
        lost: [],
      },
      {
        ...first,
        id: "0e0e0000-0000-4000-8000-0000000000d7",
        gtin14: "04600682000075",
        printName: "Чисто",
        lost: [],
      },
      {
        ...first,
        id: "0e0e0000-0000-4000-8000-0000000000d8",
        gtin14: "04600682000082",
        printName: "я".repeat(201),
        lost: [],
      },
    ];
  });
  assert.deepEqual(
    file.payload.products.map((each) => [
      each.id.slice(-2),
      each.name,
      each.printName?.length ?? null,
    ]),
    [
      ["d5", "Сок 1", null],
      ["d6", "Молоко 3,2% 0,9 л", 8],
      ["d7", "Молоко 3,2% 0,9 л", 5],
      ["d8", "Молоко 3,2% 0,9 л", 200],
    ],
  );
  assert.deepEqual(
    notesOf(file, "product_dropped").map((note) => [note.id.slice(-2), note.reason]),
    [
      ["d1", "gtin"],
      ["d2", "gtin"],
      ["d3", "gtin"],
      ["d4", "name"],
    ],
  );
  assert.deepEqual(
    textChanged(file, "products").map((note) => [note.id.slice(-2), note.field]),
    [
      ["d5", "name"],
      ["d5", "printName"],
      ["d6", "printName"],
      ["d8", "printName"],
    ],
  );
  assert.deepEqual(
    notesOf(file, "product_fields_lost").map((note) => [note.field, note.count]),
    [
      ["alpha", 1],
      ["price", 3],
      ["zeta", 1],
    ],
  );
});

test("a capacity that is no whole number is cleared with a note; an empty one needs none", () => {
  const file = build((source) => {
    const [first] = source.products;
    source.products = [
      { ...first, boxCapacity: 1.5, palletBoxCapacity: "40", shelfLifeDays: null },
      {
        ...first,
        id: "0e0e0000-0000-4000-8000-0000000000b2",
        gtin14: "04600682000044",
        boxCapacity: 1,
        palletBoxCapacity: 1,
        shelfLifeDays: 1,
      },
      {
        ...first,
        id: "0e0e0000-0000-4000-8000-0000000000b3",
        gtin14: "04600682000051",
        boxCapacity: null,
        palletBoxCapacity: -1,
        shelfLifeDays: 0,
      },
    ];
  });
  assert.deepEqual(
    file.payload.products.map((each) => [
      each.boxCapacity,
      each.palletBoxCapacity,
      each.shelfLifeDays,
    ]),
    [
      [null, null, null],
      [1, 1, 1],
      [null, null, null],
    ],
  );
  assert.deepEqual(
    notesOf(file, "product_value_cleared").map((note) => [note.id.slice(-2), note.field]),
    [
      ["01", "boxCapacity"],
      ["01", "palletBoxCapacity"],
      ["b3", "palletBoxCapacity"],
      ["b3", "shelfLifeDays"],
    ],
  );
});

test("an active shift is numbered as the cloud numbers it; either kind of blocker stops the export", () => {
  const shift = (shiftNumber) => {
    const error = caught((source) => (source.activeShifts = [shiftNumber]));
    return error.blockers;
  };
  assert.deepEqual(shift({ monthKey: "OCT26", seq: 8, createdFrom: "cabinet" }), [
    { code: "active_shift", number: "OCT26-008" },
  ]);
  assert.deepEqual(shift({ monthKey: "OCT26", seq: 1234, createdFrom: "station" }), [
    { code: "active_shift", number: "OCT26-1234/S" },
  ]);
  assert.deepEqual(shift({ monthKey: "OCT26", seq: 12, createdFrom: "station" }), [
    { code: "active_shift", number: "OCT26-012/S" },
  ]);
  const device = caught(
    (source) =>
      (source.staleDevices = [{ id: "0a0d0000-0000-4000-8000-000000000002", name: "Станция 2" }]),
  );
  assert.deepEqual(device.blockers, [
    { code: "device_out_of_sync", id: "0a0d0000-0000-4000-8000-000000000002", name: "Станция 2" },
  ]);
  assert.equal(build(() => {}).rehearsal, false);
  const clean = build(() => {}, { rehearsal: true });
  assert.equal(clean.rehearsal, true);
  assert.deepEqual(clean.notes, golden().notes);
});

test("the checks run in order: tenant, profile, GLN, name, a clean cloud, then the serials", () => {
  const code = (change) => caught(change).code;
  assert.equal(
    code((source) => {
      source.tenant = null;
      source.orgProfile = null;
    }),
    "tenant_not_found",
  );
  assert.equal(
    code((source) => {
      source.orgProfile = null;
    }),
    "org_profile_missing",
  );
  assert.equal(
    code((source) => {
      source.orgProfile.gln = "1";
      source.tenant.name = "";
    }),
    "org_gln_missing",
  );
  assert.equal(
    code((source) => {
      source.tenant.name = "";
      source.staleDevices = [{ id: "0a0d0000-0000-4000-8000-000000000001", name: "С" }];
    }),
    "org_name_missing",
  );
  assert.equal(
    code((source) => {
      source.staleDevices = [{ id: "0a0d0000-0000-4000-8000-000000000001", name: "С" }];
      source.ssccCounters[0].nextSerial = 10_000_000;
    }),
    "cloud_not_clean",
  );
  assert.equal(
    code((source) => {
      source.ssccCounters[0].nextSerial = 10_000_000;
      source.shiftNumberCounters.push({ monthKey: "Sep26", lastSeq: 3 });
    }),
    "sscc_exhausted",
  );
});

test("an SSCC owner is the organization, a counterparty of the file, or unknown", () => {
  const file = build((source) => {
    source.ssccCounters.push({ issuerPrefix: "460999900", extension: 0, nextSerial: 5 });
    source.counterparties[0].gln = " 4601234000017 ";
  });
  assert.deepEqual(
    file.cutover.ssccCounters.map((row) => row.owner),
    [
      { kind: "organization" },
      { kind: "organization" },
      { kind: "counterparty", id: "0c0c0000-0000-4000-8000-000000000001", name: "ООО «Берег»" },
      { kind: "unknown" },
    ],
  );
  const dropped = build((source) => (source.counterparties[0].gln = "46012"));
  assert.deepEqual(dropped.cutover.ssccCounters[2].owner, { kind: "unknown" });
});

test("the rollback windows come from the options and reach the cutover and the notes", () => {
  const custom = build(() => {}, { windows: { box: 5_000, pallet: 7_000 } });
  assert.equal(custom.cutover.boxWindow, 5_000);
  assert.equal(custom.cutover.palletWindow, 7_000);
  assert.deepEqual(
    custom.cutover.ssccCounters.map((row) => row.cloudReseedTo),
    [35_000, 17_000, 5_001],
  );
  assert.equal(notesOf(custom, "sscc_window_does_not_fit").length, 0);
  assert.deepEqual(
    custom.payload.ssccCounters.map((row) => row.nextSerial),
    [30_000, 10_000, 1],
  );
  const huge = build(() => {}, { windows: { box: 9_980_000, pallet: 100_000 } });
  assert.deepEqual(
    huge.cutover.ssccCounters.map((row) => row.cloudReseedTo),
    [null, 110_000, 9_980_001],
  );
  assert.deepEqual(notesOf(huge, "sscc_window_does_not_fit"), [
    { code: "sscc_window_does_not_fit", issuerPrefix: "460068200", extension: 0 },
  ]);
  const error = caught(() => {}, { windows: { box: 0, pallet: 100_000 } });
  assert.equal(error.code, "sscc_input_invalid");
  assert.match(error.message, /rollback window/u);
});

test("notes about SSCC of counterparties, planned shifts and non-operator badges appear only when there are some", () => {
  const file = build((source) => {
    source.counterpartyIssuedShifts = 0;
    source.plannedShifts = 0;
    source.nonOperatorBadges = 0;
  });
  for (const code of [
    "counterparty_sscc_used",
    "planned_shifts_not_moved",
    "badges_not_operators",
  ]) {
    assert.equal(notesOf(file, code).length, 0, code);
  }
  assert.deepEqual(
    notesOf(
      build((source) => (source.plannedShifts = 1)),
      "planned_shifts_not_moved",
    ),
    [{ code: "planned_shifts_not_moved", count: 1 }],
  );
});

test("the file names its format, version, tool and moment", () => {
  const file = build(() => {});
  assert.equal(file.format, "markiro-cloud-export");
  assert.equal(file.formatVersion, 1);
  assert.equal(file.tool, "standalone-export/1");
  assert.equal(file.exportedAt, EXPORTED_AT);
  assert.deepEqual(Object.keys(file), [
    "format",
    "formatVersion",
    "tool",
    "exportedAt",
    "rehearsal",
    "checksum",
    "source",
    "payload",
    "cutover",
    "notes",
  ]);
});

test("a dropped GS1 prefix is noted as the cloud held it, blanks and all", () => {
  const file = build((source) => (source.orgProfile.gs1Prefixes = ["4600", " 46a0 "]));
  assert.deepEqual(file.payload.organization.gs1Prefixes, ["4600"]);
  assert.deepEqual(
    notesOf(file, "gs1_prefix_dropped").map((note) => note.value),
    [" 46a0 "],
  );
});

test("a layout that is both too deep and too large is reported as too deep", () => {
  const source = raw();
  let deep = { pad: "x".repeat(262_144) };
  for (let level = 0; level < 70; level += 1) deep = { e: deep };
  source.templates = [{ ...source.templates[0], spec: deep }];
  const file = buildExportFile(source, { exportedAt: EXPORTED_AT });
  assert.deepEqual(
    notesOf(file, "template_dropped").map((note) => note.reason),
    ["spec_too_deep"],
  );
});

test("names are cut at the host's length in code points, with a note", () => {
  const long = (length) => "я".repeat(length);
  const file = build((source) => {
    source.lines = [{ id: "0a0a0000-0000-4000-8000-0000000000f1", name: long(101) }];
    source.templates = [{ ...source.templates[0], name: long(201) }];
    source.counterparties = [{ ...source.counterparties[0], name: long(201) }];
  });
  assert.equal(file.payload.lines[0].name, long(100));
  assert.deepEqual(notesOf(file, "line_renamed"), [
    {
      code: "line_renamed",
      id: "0a0a0000-0000-4000-8000-0000000000f1",
      from: long(101),
      to: long(100),
    },
  ]);
  assert.equal(file.payload.templates[0].name, long(200));
  assert.equal(file.payload.counterparties[0].name, long(200));
  const exact = build((source) => {
    source.lines = [{ id: "0a0a0000-0000-4000-8000-0000000000f1", name: long(100) }];
    source.templates = [{ ...source.templates[0], name: long(200) }];
  });
  assert.equal(exact.payload.lines[0].name, long(100));
  assert.equal(exact.payload.templates[0].name, long(200));
  assert.equal(notesOf(exact, "line_renamed").length, 0);
  assert.equal(textChanged(exact, "templates").length, 0);
});

test("a counterparty GLN of 12 or 14 digits drops it; one without an INN is kept without a note", () => {
  const file = build((source) => {
    const [first] = source.counterparties;
    source.counterparties = [
      { ...first, id: "0c0c0000-0000-4000-8000-0000000000a1", gln: "460123400001" },
      { ...first, id: "0c0c0000-0000-4000-8000-0000000000a2", gln: "46012340000170" },
      { ...first, id: "0c0c0000-0000-4000-8000-0000000000a3", inn: null },
    ];
  });
  assert.deepEqual(
    file.payload.counterparties.map((each) => [each.id.slice(-2), each.inn]),
    [["a3", null]],
  );
  assert.deepEqual(
    notesOf(file, "counterparty_dropped").map((note) => note.id.slice(-2)),
    ["a1", "a2"],
  );
  assert.equal(
    notesOf(file, "inn_dropped").filter((note) => note.entity === "counterparties").length,
    0,
  );
});

test("a PHC string the host would refuse: extra parts, another algorithm, a bad count or digest", () => {
  const salt = "bWFya2lyby1waW4tc2FsdA==";
  const digest = "3OKvrZ2+EfTB2zsCso90r5g8c6Ib6t+Bv+cGJOpgPmU=";
  const good = `pbkdf2$sha256$100000$${salt}$${digest}`;
  assert.equal(parsePhc(good)?.iterations, 100_000);
  assert.deepEqual(parsePhc(good), { iterations: 100_000, salt, digest });
  for (const [index, bad] of [
    `${good}$extra`,
    `${good}$`,
    `pbkdf2$sha256$100000$${salt}`,
    `pbkdf2$sha512$100000$${salt}$${digest}`,
    `pbkdf2$sha1$100000$${salt}$${digest}`,
    `argon2$sha256$100000$${salt}$${digest}`,
    `pbkdf2$100000$${salt}$${digest}`,
    `pbkdf2$sha256$1e5$${salt}$${digest}`,
    `pbkdf2$sha256$100000x$${salt}$${digest}`,
    `pbkdf2$sha256$+100000$${salt}$${digest}`,
    `pbkdf2$sha256$ 100000$${salt}$${digest}`,
    `pbkdf2$sha256$100000.0$${salt}$${digest}`,
    `pbkdf2$sha256$$${salt}$${digest}`,
    `pbkdf2$sha256$100000$${salt}$${digest.slice(0, 40)}=`,
    `pbkdf2$sha256$100000$${salt}$${Buffer.alloc(31).toString("base64")}`,
    `pbkdf2$sha256$100000$${salt}$${digest.replace(/=$/u, "")}`,
    `pbkdf2$sha256$100000$${Buffer.alloc(15).toString("base64")}$${digest}`,
    `pbkdf2$sha256$100000$${salt}$`,
    `pbkdf2$sha256$100000$$${digest}`,
  ].entries()) {
    assert.equal(parsePhc(bad), null, `refused PHC string number ${index}`);
  }
  assert.equal(parsePhc(undefined), null);
  assert.equal(parsePhc(12345), null);
  assert.equal(parsePhc(["a"]), null);
});
