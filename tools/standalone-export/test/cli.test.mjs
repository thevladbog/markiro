import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";

import {
  CREDENTIAL_WARNING,
  FS,
  USAGE,
  fileName,
  main,
  parseArgs,
  runPsql,
  summary,
  writeWhole,
} from "../cli.mjs";

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
  assert.deepEqual(parseArgs(["--tenant", "imp-test-atoll", "--out-dir", "/home/me/export"]), {
    tenantId: "imp-test-atoll",
    outDir: "/home/me/export",
    rehearsal: false,
    acceptSharedPrefix: false,
    psql: "psql",
  });
  assert.deepEqual(
    parseArgs([
      "--rehearsal",
      "--tenant",
      "t1",
      "--out-dir",
      "/media/usb",
      "--accept-shared-prefix",
      "--psql",
      "/opt/psql",
    ]),
    {
      tenantId: "t1",
      outDir: "/media/usb",
      rehearsal: true,
      acceptSharedPrefix: true,
      psql: "/opt/psql",
    },
  );
  assert.throws(() => parseArgs([]), /--tenant/u);
  assert.throws(() => parseArgs(["--tenant", "a'b"]), /--tenant/u);
  assert.throws(() => parseArgs(["--tenant"]), /needs a value/u);
  assert.throws(() => parseArgs(["--tenant", "t1", "--password", "x"]), /unknown argument/u);
});

test("the folder of the file is always named: the working directory may be a repository", async () => {
  assert.throws(() => parseArgs(["--tenant", "t1"]), /--out-dir <dir> is required/u);
  assert.throws(
    () => parseArgs(["--tenant", "t1", "--out-dir", ""]),
    /--out-dir <dir> is required/u,
  );
  const { code, calls, err, out } = await run(["--tenant", "imp-test-atoll"]);
  assert.equal(code, 64);
  assert.deepEqual(calls, [], "psql never ran");
  assert.deepEqual(out, []);
  assert.match(err.join("\n"), /--out-dir <dir> is required/u);
});

test("a transfer file written by mistake inside the repository is ignored by git", () => {
  // A Windows checkout may turn the file's line ends into CRLF (core.autocrlf).
  const lines = readFileSync(new URL("../../../.gitignore", import.meta.url), "utf8").split(
    /\r?\n/u,
  );
  assert.ok(lines.includes("markiro-cloud-export-*.json"), "the transfer file is not ignored");
  assert.ok(lines.includes(".markiro-cloud-export-*.partial"), "the temporary file is not ignored");
  // And git itself ignores both, at the root and deep in the tree, by the
  // repository's own .gitignore (not a user's global excludes).
  const paths = [
    "markiro-cloud-export-imp-test-atoll-2026-10-09.json",
    "apps/standalone/markiro-cloud-export-imp-test-atoll-2026-10-09.json",
    ".markiro-cloud-export-imp-test-atoll-2026-10-09.1234-0a1b2c3d4e5f.partial",
    "tools/standalone-export/.markiro-cloud-export-imp-test-atoll-2026-10-09.1234-0a1b2c3d4e5f.partial",
  ];
  const checked = spawnSync("git", ["check-ignore", "--no-index", "--verbose", ...paths], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    encoding: "utf8",
  });
  assert.equal(checked.status, 0, `git check-ignore: ${checked.stderr}`);
  // `<source>:<line>:<pattern>\t<path>`; a negated pattern that matched is
  // reported too, and means the path is not ignored.
  const matches = checked.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [match = "", path] = line.split("\t");
      const [, source, pattern = ""] = /^(.*?):\d+:(.*)$/u.exec(match) ?? [];
      return [path, source, pattern.startsWith("!") ? "negated" : "ignored"];
    });
  assert.deepEqual(
    matches,
    paths.map((path) => [path, ".gitignore", "ignored"]),
  );
});

/** `FS` with one call replaced. */
const failing = (name, error) => ({
  ...FS,
  [name]: () => {
    throw Object.assign(new Error(`${error}: injected`), { code: error });
  },
});

test("the file appears whole or not at all, and a failed write leaves nothing behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-export-"));
  try {
    const path = join(dir, "markiro-cloud-export-1-2026-10-09.json");
    for (const [name, error] of [
      ["writeSync", "ENOSPC"],
      ["fsyncSync", "EIO"],
      ["closeSync", "EIO"],
      ["linkSync", "EIO"],
    ]) {
      assert.throws(() => writeWhole(path, "{}\n", failing(name, error)), new RegExp(error, "u"));
      assert.deepEqual(readdirSync(dir), [], `${name} left a file`);
    }
    // A write the disk takes only in part is carried on until all of it is down.
    let chunks = 0;
    const halves = {
      ...FS,
      writeSync: (fd, buffer, offset, length) => {
        chunks += 1;
        return FS.writeSync(fd, buffer, offset, Math.min(length, 3));
      },
    };
    writeWhole(path, '{"a": "я"}\n', halves);
    assert.equal(readFileSync(path, "utf8"), '{"a": "я"}\n');
    assert.ok(chunks > 3);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ["markiro-cloud-export-1-2026-10-09.json"]);
    // Never over a file already there, and the temporary file goes too.
    assert.throws(() => writeWhole(path, "other\n"), /EEXIST/u);
    assert.equal(readFileSync(path, "utf8"), '{"a": "я"}\n');
    assert.deepEqual(readdirSync(dir), ["markiro-cloud-export-1-2026-10-09.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without hard links (a FAT flash drive) the file is renamed into place, still never over another", () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-export-"));
  try {
    const path = join(dir, "markiro-cloud-export-1-2026-10-09.json");
    for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"]) {
      writeWhole(path, `${code}\n`, failing("linkSync", code));
      assert.equal(readFileSync(path, "utf8"), `${code}\n`);
      assert.deepEqual(readdirSync(dir), ["markiro-cloud-export-1-2026-10-09.json"]);
      assert.throws(() => writeWhole(path, "other\n", failing("linkSync", code)), /EEXIST/u);
      assert.equal(readFileSync(path, "utf8"), `${code}\n`);
      assert.deepEqual(readdirSync(dir), ["markiro-cloud-export-1-2026-10-09.json"]);
      rmSync(path);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a write that fails exits 1 with no file, and the run after it writes the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-export-"));
  try {
    const argv = ["--tenant", "imp-test-atoll", "--out-dir", dir];
    const quiet = { stdout: () => {}, now: () => new Date("2026-10-09T18:30:00.000Z") };
    const err = [];
    const code = await main(argv, {
      ...quiet,
      run: async () => rawText,
      stderr: (line) => err.push(line),
      writeFile: (path, text) => writeWhole(path, text, failing("writeSync", "ENOSPC")),
    });
    assert.equal(code, 1);
    assert.deepEqual(err, ["Выгрузка не удалась: ENOSPC: injected"]);
    assert.deepEqual(readdirSync(dir), []);
    const again = await run(argv);
    assert.equal(again.code, 0, again.err.join("\n"));
    assert.deepEqual(readdirSync(dir), ["markiro-cloud-export-7701234567-2026-10-09.json"]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8")), golden);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
      "Записей: линий 3, контрагентов 2, шаблонов 5, товаров 4, операторов 3, бейджей 3",
      "Номера смен: NOV26 → 1, OCT26 → 7, SEP26 → 41",
      "SSCC (префикс, расширение, владелец):",
      "  460068200, короба (0), организация: выдано облаком до 21003, напечатано до 21003, автоном начнёт с 30000, облако перевести на 1030000",
      "  460068200, паллеты (1), организация: выдано облаком до 400, напечатано до 250, автоном начнёт с 10000, облако перевести на 110000",
      "  460123400, короба (0), контрагент «ООО «Берег»»: выдано облаком до —, напечатано до —, автоном начнёт с 1, облако перевести на 1000001",
      "  460999900, короба (0), неизвестно: выдано облаком до 777, напечатано до 777, автоном начнёт с 10000, облако перевести на 1010000",
      `Замечаний: 27 (их показывает офис автонома перед переносом)`,
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
    ["--tenant", "imp-test-atoll", "--out-dir", tmpdir()],
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
  assert.match(text, /--accept-shared-prefix/u);
  assert.match(text, /--out-dir <dir>\s+каталог файла переноса \(обязательно\)/u);
  assert.match(text, /sscc_prefix_shared/u);
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

test("another tenant's serials under another prefix are only reported; the file never holds them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-export-"));
  try {
    const { code, err } = await run(["--tenant", "imp-test-atoll", "--out-dir", dir]);
    assert.equal(code, 0, err.join("\n"));
    const tail = "; автоном под этим префиксом SSCC не выпускает";
    assert.deepEqual(err.slice(0, -CREDENTIAL_WARNING.length), [
      "Справка: под префиксом 460123400, короба (0) номера выдаёт и другой арендатор этой базы, наибольший 950000" +
        tail,
      "Справка: под префиксом 460123400, паллеты (1) номера выдаёт и другой арендатор этой базы, наибольший 700000" +
        tail,
      "Справка: под префиксом 460700000, короба (0) номера выдаёт и другой арендатор этой базы, наибольший 40" +
        tail,
    ]);
    const file = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    assert.deepEqual(file, golden);
    assert.ok(!JSON.stringify(file).includes("950000"));

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

test("another tenant under the organization's prefix stops the export with exit 2, unless accepted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "standalone-export-"));
  try {
    const raw = JSON.parse(rawText);
    raw.otherTenantsSscc = [{ issuerPrefix: "460068200", extension: 1, maxSerial: 12 }];
    const refused = await run(
      ["--tenant", "imp-test-atoll", "--out-dir", dir],
      JSON.stringify(raw),
    );
    assert.equal(refused.code, 2);
    assert.deepEqual(refused.out, []);
    assert.deepEqual(refused.err, [
      "Выгрузка невозможна: sscc_prefix_shared: another tenant of this database issues SSCC under the organization's prefix 460068200",
      "  под префиксом организации 460068200, паллеты (1) номера выдаёт другой арендатор этой базы, наибольший 12",
      "  решение владельца до переноса (памятка переключения, 4.3); выгрузить вопреки: --accept-shared-prefix",
    ]);
    assert.deepEqual(readdirSync(dir), []);
    // A rehearsal is no way around it.
    const rehearsal = await run(
      ["--tenant", "imp-test-atoll", "--out-dir", dir, "--rehearsal"],
      JSON.stringify(raw),
    );
    assert.equal(rehearsal.code, 2);
    assert.deepEqual(readdirSync(dir), []);

    const accepted = await run(
      ["--tenant", "imp-test-atoll", "--out-dir", dir, "--accept-shared-prefix"],
      JSON.stringify(raw),
    );
    assert.equal(accepted.code, 0, accepted.err.join("\n"));
    assert.deepEqual(accepted.err.slice(0, -CREDENTIAL_WARNING.length), [
      "Внимание: под префиксом 460068200, паллеты (1) номера выдаёт и другой арендатор этой базы, наибольший 12; " +
        "автоном начнёт с 10000. Файл записан с --accept-shared-prefix: до первой смены автонома тот арендатор " +
        "остановлен и его счётчик переведён за окно автонома (памятка переключения, 4.3), иначе SSCC повторятся",
    ]);
    const file = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"));
    assert.deepEqual(
      file.notes.filter((note) => note.code === "sscc_prefix_shared"),
      [{ code: "sscc_prefix_shared", issuerPrefix: "460068200", extension: 1 }],
    );
    assertNoSecret([...accepted.out, ...accepted.err, ...refused.err]);
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
  const ok = (id) => parseArgs(["--tenant", id, "--out-dir", "/tmp/x"]).tenantId;
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
    assert.throws(
      () => parseArgs(["--tenant", id, "--out-dir", "/tmp/x"]),
      /--tenant <tenantId>/u,
      JSON.stringify(id),
    );
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
    "Записей: линий 3, контрагентов 2, шаблонов 5, товаров 4, операторов 3, бейджей 3",
    "Номера смен: —",
    "SSCC (префикс, расширение, владелец):",
    "  460999900, паллеты (1), неизвестно: выдано облаком до 5, напечатано до —, автоном начнёт с 10000, облако перевести на окно не помещается",
    `Замечаний: ${file.notes.length} (их показывает офис автонома перед переносом)`,
    `Контрольная сумма: ${file.checksum}`,
  ]);
});
