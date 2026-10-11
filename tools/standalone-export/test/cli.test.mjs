import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CREDENTIAL_WARNING, USAGE, fileName, main, parseArgs, runPsql, summary } from "../cli.mjs";

const rawText = readFileSync(new URL("./fixtures/raw-cloud.json", import.meta.url), "utf8");
const golden = JSON.parse(
  readFileSync(
    new URL("../../../apps/standalone/proto/fixtures/cloud-export-file.json", import.meta.url),
    "utf8",
  ),
);

/** `main` with psql replaced by `output` and the console captured. */
async function run(argv, output = rawText) {
  const out = [];
  const err = [];
  const calls = [];
  const code = await main(argv, {
    run: async (options) => {
      calls.push(options);
      return output;
    },
    now: () => new Date("2026-10-09T18:30:00.000Z"),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    env: { PGHOST: "restored-copy" },
  });
  return { code, out, err, calls };
}

test("arguments: a tenant is required and nothing unknown is taken", () => {
  assert.deepEqual(parseArgs(["--tenant", "imp-test-atoll"]), {
    tenantId: "imp-test-atoll",
    outDir: ".",
    rehearsal: false,
    psql: "psql",
  });
  assert.deepEqual(
    parseArgs(["--rehearsal", "--tenant", "t1", "--out-dir", "/media/usb", "--psql", "/opt/psql"]),
    { tenantId: "t1", outDir: "/media/usb", rehearsal: true, psql: "/opt/psql" },
  );
  assert.throws(() => parseArgs([]), /--tenant/u);
  assert.throws(() => parseArgs(["--tenant", "a'b"]), /--tenant/u);
  assert.throws(() => parseArgs(["--tenant"]), /needs a value/u);
  assert.throws(() => parseArgs(["--tenant", "t1", "--password", "x"]), /unknown argument/u);
});

test("the file is written owner-only under its name and the summary names no secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-export-"));
  try {
    const { code, out, err, calls } = await run(["--tenant", "imp-test-atoll", "--out-dir", dir]);
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(calls, [
      { psql: "psql", tenantId: "imp-test-atoll", env: { PGHOST: "restored-copy" } },
    ]);
    const path = join(dir, "markiro-cloud-export-7701234567-2026-10-09.json");
    assert.equal(fileName(golden), "markiro-cloud-export-7701234567-2026-10-09.json");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), golden);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(out, [
      `Файл: ${path}`,
      "Организация: ООО «Атолл», ИНН 7701234567, GLN 4600682000010, часовой пояс Europe/Moscow",
      "Записей: линий 3, контрагентов 2, шаблонов 5, товаров 3, операторов 3, бейджей 3",
      "Номера смен: NOV26 → 1, OCT26 → 7, SEP26 → 41",
      "SSCC (префикс, расширение, владелец):",
      "  460068200, короба (0), организация: выдано облаком до 21003, напечатано до 21003, автоном начнёт с 30000, облако перевести на 1030000",
      "  460068200, паллеты (1), организация: выдано облаком до 400, напечатано до 250, автоном начнёт с 10000, облако перевести на 110000",
      "  460123400, короба (0), контрагент «ООО «Берег»»: выдано облаком до —, напечатано до —, автоном начнёт с 1, облако перевести на 1000001",
      `Замечаний: 24 (их показывает офис автонома перед переносом)`,
      `Контрольная сумма: ${golden.checksum}`,
    ]);
    const printed = [...out, ...err].join("\n");
    for (const secret of [
      golden.payload.badgeSalt,
      ...golden.payload.badges.map((badge) => badge.badgePhc),
      ...golden.payload.operators.map((operator) => operator.pinPhc),
      "pbkdf2$",
      "MRK-000743",
    ]) {
      assert.ok(!printed.includes(secret), "the console shows a secret");
    }

    const again = await run(["--tenant", "imp-test-atoll", "--out-dir", dir]);
    assert.equal(again.code, 1);
    assert.match(again.err.join("\n"), /EEXIST/u);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), golden);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cloud that is not clean writes no file and says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-export-"));
  try {
    const raw = JSON.parse(rawText);
    raw.activeShifts = [{ monthKey: "OCT26", seq: 7, createdFrom: "admin" }];
    raw.staleDevices = [{ id: "0a0d0000-0000-4000-8000-000000000001", name: "Станция 1" }];
    const { code, out, err } = await run(
      ["--tenant", "imp-test-atoll", "--out-dir", dir],
      JSON.stringify(raw),
    );
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.deepEqual(err, [
      "Выгрузка невозможна: cloud_not_clean: the cloud has an active shift or an unsynced station",
      "  смена OCT26-007 не закрыта",
      "  станция «Станция 1» не синхронизирована после последнего закрытия смены",
    ]);
    const rehearsal = await run(
      ["--tenant", "imp-test-atoll", "--out-dir", dir, "--rehearsal"],
      JSON.stringify(raw),
    );
    assert.equal(rehearsal.code, 0, rehearsal.err.join("\n"));
    assert.match(rehearsal.out[0], /ПРОБНЫЙ: не для переключения/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output that is not JSON fails without quoting it", async () => {
  const { code, err } = await run(
    ["--tenant", "imp-test-atoll"],
    '{"badgeCode": "MRK-SECRET-1" oops',
  );
  assert.equal(code, 1);
  assert.deepEqual(err, ["Выгрузка не удалась: psql did not print one JSON document"]);
});

test("an unknown argument exits with 64 before psql runs", async () => {
  const { code, calls, err } = await run(["--tenant", "t1", "--force"]);
  assert.equal(code, 64);
  assert.deepEqual(calls, []);
  assert.deepEqual(err, ["unknown argument --force"]);
});

const SECRET_MARKERS = [
  golden.payload.badgeSalt,
  ...golden.payload.badges.map((badge) => badge.badgePhc),
  ...golden.payload.operators.map((operator) => operator.pinPhc),
  "pbkdf2$",
  "MRK-000742",
  "MRK-000743",
  "MRK-000744",
];

function assertNoSecret(lines) {
  const printed = lines.join("\n");
  for (const secret of SECRET_MARKERS)
    assert.ok(!printed.includes(secret), "the console shows a secret");
}

test("--help prints the usage, the libpq connection, 0600 and the Windows rule, and runs nothing", async () => {
  for (const argv of [["--help"], ["-h"], ["--tenant", "--help"], ["--bogus", "-h"]]) {
    const { code, out, err, calls } = await run(argv);
    assert.equal(code, 0, argv.join(" "));
    assert.deepEqual(out, USAGE);
    assert.deepEqual(err, []);
    assert.deepEqual(calls, []);
  }
  const text = USAGE.join("\n");
  assert.match(text, /PGHOST/u);
  assert.match(text, /PGPASSWORD/u);
  assert.match(text, /Пароль в аргументах не принимается/u);
  assert.match(text, /только для владельца \(права 0600 на macOS и Linux\)/u);
  assert.match(text, /Windows/u);
  assert.match(text, /папку своего\s+профиля/u);
  assert.match(text, /удалить/u);
  assert.match(text, /--rehearsal/u);
});

test("every file written is followed by a warning that it holds credential verifiers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-export-"));
  try {
    for (const extra of [[], ["--rehearsal"]]) {
      const dirOne = mkdtempSync(join(dir, "run-"));
      const { code, out, err } = await run([
        "--tenant",
        "imp-test-atoll",
        "--out-dir",
        dirOne,
        ...extra,
      ]);
      assert.equal(code, 0, err.join("\n"));
      assert.deepEqual(err.slice(-CREDENTIAL_WARNING.length), CREDENTIAL_WARNING);
      assert.match(CREDENTIAL_WARNING.join(" "), /хеши PIN и бейджей, соль бейджей/u);
      assert.match(CREDENTIAL_WARNING.join(" "), /УДАЛИТЕ/u);
      assert.ok(out.every((line) => !CREDENTIAL_WARNING.includes(line)));
      assertNoSecret([...out, ...err]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("another tenant's serials under a prefix of this one are warned about, never written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-export-"));
  try {
    const { code, err } = await run(["--tenant", "imp-test-atoll", "--out-dir", dir]);
    assert.equal(code, 0, err.join("\n"));
    const tail = " — номера могут повториться: решите до переноса (памятка переключения)";
    assert.deepEqual(err.slice(0, -CREDENTIAL_WARNING.length), [
      "Внимание: под префиксом 460068200, короба (0) номера выдавал и другой арендатор этой базы, наибольший 900000; автоном начнёт с 30000" +
        tail,
      "Внимание: под префиксом 460068200, паллеты (1) номера выдавал и другой арендатор этой базы, наибольший 700000; автоном начнёт с 10000" +
        tail,
      "Внимание: под префиксом 460123400, короба (0) номера выдавал и другой арендатор этой базы, наибольший 500000; автоном начнёт с 1" +
        tail,
      "Внимание: под префиксом 460123400, паллеты (1) номера выдавал и другой арендатор этой базы, наибольший 600000; автоном начнёт с —",
    ]);
    const file = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    assert.deepEqual(file, golden);
    assert.ok(!JSON.stringify(file).includes("900000"));

    // The boundary: the first serial the standalone issues is taken at 30000, free at 29999.
    for (const [maxSerial, overlaps] of [
      [29_999, false],
      [30_000, true],
    ]) {
      const raw = JSON.parse(rawText);
      raw.otherTenantsSscc = [{ issuerPrefix: "460068200", extension: 0, maxSerial }];
      const other = mkdtempSync(join(dir, "boundary-"));
      const result = await run(
        ["--tenant", "imp-test-atoll", "--out-dir", other],
        JSON.stringify(raw),
      );
      assert.equal(result.code, 0);
      const line = result.err[0];
      assert.match(line, new RegExp(`наибольший ${maxSerial}; автоном начнёт с 30000`, "u"));
      assert.equal(line.endsWith(tail), overlaps, line);
    }

    // No other tenant, no warning (only the credential one).
    const alone = JSON.parse(rawText);
    alone.otherTenantsSscc = [];
    const quiet = await run(
      ["--tenant", "imp-test-atoll", "--out-dir", mkdtempSync(join(dir, "alone-"))],
      JSON.stringify(alone),
    );
    assert.deepEqual(quiet.err, CREDENTIAL_WARNING);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refusal writes no file and names no hash, salt or badge code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-export-"));
  try {
    const behind = JSON.parse(rawText);
    behind.shiftNumberMaxima[1].maxSeq = 9;
    const missingList = JSON.parse(rawText);
    delete missingList.badges;
    const cases = [
      [
        behind,
        [
          `Выгрузка невозможна: shift_counter_behind: shifts hold numbers past their month's counter: "OCT26" (shifts up to 9, counter 7)`,
        ],
      ],
      [
        missingList,
        [`Выгрузка невозможна: export_output_invalid: the export output has no list "badges"`],
      ],
    ];
    for (const [raw, expected] of cases) {
      const { code, out, err } = await run(
        ["--tenant", "imp-test-atoll", "--out-dir", dir, "--rehearsal"],
        JSON.stringify(raw),
      );
      assert.equal(code, 2);
      assert.deepEqual(out, []);
      assert.deepEqual(err, expected);
      assert.deepEqual(readdirSync(dir), []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "psql is started with libpq's environment and a tenant variable, never a password argument",
  {
    skip: process.platform === "win32" ? "the fake psql is a POSIX script" : false,
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "standalone-export-"));
    try {
      const fake = join(dir, "fake-psql.mjs");
      writeFileSync(
        fake,
        [
          "#!/usr/bin/env node",
          'import { writeFileSync } from "node:fs";',
          "writeFileSync(process.env.FAKE_PSQL_LOG, JSON.stringify({",
          "  argv: process.argv.slice(2),",
          "  host: process.env.PGHOST ?? null,",
          "  password: process.env.PGPASSWORD ?? null,",
          "}));",
          'process.stdout.write(process.env.FAKE_PSQL_OUT ?? "");',
          "process.exit(Number(process.env.FAKE_PSQL_EXIT ?? 0));",
        ].join("\n"),
      );
      chmodSync(fake, 0o755);
      const log = join(dir, "log.json");
      const env = {
        ...process.env,
        FAKE_PSQL_LOG: log,
        FAKE_PSQL_OUT: rawText,
        PGHOST: "restored-copy",
        PGPASSWORD: "libpq-only-password",
      };
      const output = await runPsql({ psql: fake, tenantId: "imp-test-atoll", env });
      assert.equal(output, rawText);
      const seen = JSON.parse(readFileSync(log, "utf8"));
      assert.deepEqual(seen.argv, [
        "-X",
        "-q",
        "-A",
        "-t",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "tenant_id=imp-test-atoll",
        "-f",
        join(import.meta.dirname, "..", "export.sql"),
      ]);
      assert.equal(seen.host, "restored-copy");
      assert.equal(seen.password, "libpq-only-password");
      assert.ok(!seen.argv.join(" ").includes("libpq-only-password"));

      // A psql that fails fails the export, and nothing it printed is used.
      await assert.rejects(
        runPsql({ psql: fake, tenantId: "t1", env: { ...env, FAKE_PSQL_EXIT: "3" } }),
        /^Error: psql exited with 3$/u,
      );
      const { code, out, err } = await (async () => {
        const lines = { out: [], err: [] };
        const exit = await main(["--tenant", "t1", "--out-dir", dir, "--psql", fake], {
          env: { ...env, FAKE_PSQL_EXIT: "3" },
          stdout: (line) => lines.out.push(line),
          stderr: (line) => lines.err.push(line),
        });
        return { code: exit, ...lines };
      })();
      assert.equal(code, 1);
      assert.deepEqual(out, []);
      assert.deepEqual(err, ["Выгрузка не удалась: psql exited with 3"]);
      assert.deepEqual(readdirSync(dir).sort(), ["fake-psql.mjs", "log.json"]);

      // A psql that is not there is a failure too, not a hang.
      await assert.rejects(
        runPsql({ psql: join(dir, "no-such-psql"), tenantId: "t1", env }),
        (error) => error.code === "ENOENT",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("a tenant id is 1 to 64 letters, digits, _ and -, and nothing else reaches psql", () => {
  const ok = (id) => parseArgs(["--tenant", id]).tenantId;
  assert.equal(ok("a"), "a");
  assert.equal(ok("A_b-9".repeat(12) + "abcd"), "A_b-9".repeat(12) + "abcd");
  assert.equal(ok("x".repeat(64)), "x".repeat(64));
  for (const id of [
    "",
    "x".repeat(65),
    "a.b",
    "a b",
    "a/b",
    "a'b",
    'a"b',
    "a;b",
    "a\nb",
    "ab\n",
    "\nab",
    "ä",
    "a:b",
  ]) {
    assert.throws(() => parseArgs(["--tenant", id]), /--tenant <tenantId>/u, JSON.stringify(id));
  }
});

test("the file is named after the INN, or the tenant when it has none, and the day of the export", () => {
  const noInn = structuredClone(golden);
  noInn.payload.organization.inn = null;
  assert.equal(fileName(noInn), "markiro-cloud-export-imp-test-atoll-2026-10-09.json");
  assert.equal(fileName(golden), "markiro-cloud-export-7701234567-2026-10-09.json");
});

test("the summary says what is unknown, empty or without a window, and marks a rehearsal", () => {
  const file = structuredClone(golden);
  file.rehearsal = true;
  file.payload.organization.inn = null;
  file.payload.shiftNumberCounters = [];
  file.cutover.ssccCounters = [
    {
      issuerPrefix: "460999900",
      extension: 1,
      owner: { kind: "unknown" },
      issuedMax: 5,
      printedMax: null,
      standaloneStart: 10_000,
      cloudReseedTo: null,
    },
  ];
  assert.deepEqual(summary(file, "/media/usb/x.json"), [
    "Файл: /media/usb/x.json (ПРОБНЫЙ: не для переключения)",
    "Организация: ООО «Атолл», ИНН —, GLN 4600682000010, часовой пояс Europe/Moscow",
    "Записей: линий 3, контрагентов 2, шаблонов 5, товаров 3, операторов 3, бейджей 3",
    "Номера смен: —",
    "SSCC (префикс, расширение, владелец):",
    "  460999900, паллеты (1), неизвестно: выдано облаком до 5, напечатано до —, автоном начнёт с 10000, облако перевести на окно не помещается",
    `Замечаний: ${file.notes.length} (их показывает офис автонома перед переносом)`,
    `Контрольная сумма: ${file.checksum}`,
  ]);
});
