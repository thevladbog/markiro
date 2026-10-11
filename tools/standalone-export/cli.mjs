#!/usr/bin/env node
/**
 * Cloud → standalone export (pilot spec §8.7, plan IMP). Runs `export.sql`
 * through psql against a RESTORED COPY of the cloud database, builds the
 * import file and writes it next to nothing else:
 *
 *   node tools/standalone-export/cli.mjs --tenant <tenantId> [--out-dir <dir>] [--rehearsal] [--psql <path>]
 *
 * The connection comes from libpq's environment (PGHOST, PGPORT, PGUSER,
 * PGPASSWORD or ~/.pgpass, PGDATABASE, PGSSLMODE), never from an argument,
 * so no password reaches the shell history or a process list. The file
 * holds PIN and badge hashes and the badge salt: it is written owner-only
 * (mode 0600; on Windows the folder's access rules apply, so write into the
 * user's own profile folder) and never over an existing file; it travels on a
 * flash drive and is deleted after the import
 * (docs/runbooks/standalone-cloud-cutover.md). Nothing the tool prints, on
 * stdout or stderr, names a hash, a salt or a badge code: the summary holds
 * counts, numbers and the checksum, and a failure holds a reason.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ExportError, buildExportFile } from "./transform.mjs";

const SQL = fileURLToPath(new URL("./export.sql", import.meta.url));
const EXTENSIONS = { 0: "короба", 1: "паллеты" };

/** What `--help` prints: the options, where the connection comes from, and what the file is. */
export const USAGE = [
  "Использование: node tools/standalone-export/cli.mjs --tenant <tenantId> [--out-dir <dir>] [--rehearsal] [--psql <path>]",
  "  --tenant <id>    organization.id организации в облаке (обязательно)",
  "  --out-dir <dir>  каталог файла переноса (по умолчанию текущий)",
  "  --rehearsal      пробный файл из нечистого облака; не для переключения",
  "  --psql <path>    путь к psql (по умолчанию psql из PATH)",
  "  --help, -h       эта справка",
  "Подключение к ВОССТАНОВЛЕННОЙ КОПИИ базы облака только переменными libpq: PGHOST, PGPORT,",
  "PGUSER, PGPASSWORD или ~/.pgpass, PGDATABASE, PGSSLMODE. Пароль в аргументах не принимается.",
  "Файл переноса содержит проверочные значения учётных данных (хеши PIN и бейджей, соль бейджей).",
  "Он создаётся только для владельца (права 0600 на macOS и Linux) и никогда поверх существующего файла.",
  "На Windows права 0600 не действуют: файл наследует права каталога, поэтому пишите в папку своего",
  "профиля пользователя, а не на общий диск. После переноса файл нужно удалить.",
  "Коды выхода: 0 файл записан; 1 сбой; 2 выгрузка невозможна (в том числе нечистое облако); 64 неверные аргументы.",
];

/** Printed to stderr after every file written, so it is read before the file travels. */
export const CREDENTIAL_WARNING = [
  "ВНИМАНИЕ: файл содержит проверочные значения учётных данных (хеши PIN и бейджей, соль бейджей).",
  "Храните его только у себя (флешка владельца), не пересылайте и УДАЛИТЕ сразу после переноса.",
];

export function parseArgs(argv) {
  const options = { tenantId: null, outDir: ".", rehearsal: false, psql: "psql" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--rehearsal") options.rehearsal = true;
    else if (arg === "--tenant" || arg === "--out-dir" || arg === "--psql") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      index += 1;
      if (arg === "--tenant") options.tenantId = value;
      else if (arg === "--out-dir") options.outDir = value;
      else options.psql = value;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (options.tenantId === null || !/^[A-Za-z0-9_-]{1,64}$/u.test(options.tenantId)) {
    throw new Error("--tenant <tenantId> (letters, digits, _ and -) is required");
  }
  return options;
}

/** `export.sql`'s JSON for `tenantId`, read from psql's stdout into memory. */
export function runPsql({ psql = "psql", tenantId, env = process.env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      psql,
      ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-v", `tenant_id=${tenantId}`, "-f", SQL],
      { env, stdio: ["ignore", "pipe", "inherit"] },
    );
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`psql exited with ${code}`));
    });
  });
}

/**
 * psql's output as one JSON document. `JSON.parse`'s own message quotes the
 * text around the fault, and that text may hold a badge code, so a failure
 * says only that it failed.
 */
export function parseRaw(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("psql did not print one JSON document");
  }
}

/** `markiro-cloud-export-<INN or tenant>-<date>.json`, as the pilot spec names it. */
export function fileName(file) {
  const owner = file.payload.organization.inn ?? file.source.tenantId;
  return `markiro-cloud-export-${owner}-${file.exportedAt.slice(0, 10)}.json`;
}

/** What the person running the export reads: counts and numbers, no secret. */
export function summary(file, path) {
  const { payload, cutover } = file;
  const org = payload.organization;
  const lines = [
    `Файл: ${path}${file.rehearsal ? " (ПРОБНЫЙ: не для переключения)" : ""}`,
    `Организация: ${org.name}, ИНН ${org.inn ?? "—"}, GLN ${org.gln}, часовой пояс ${org.timeZone}`,
    `Записей: линий ${payload.lines.length}, контрагентов ${payload.counterparties.length}, ` +
      `шаблонов ${payload.templates.length}, товаров ${payload.products.length}, ` +
      `операторов ${payload.operators.length}, бейджей ${payload.badges.length}`,
    `Номера смен: ${
      payload.shiftNumberCounters.map((each) => `${each.monthKey} → ${each.lastSeq}`).join(", ") ||
      "—"
    }`,
    "SSCC (префикс, расширение, владелец):",
  ];
  for (const row of cutover.ssccCounters) {
    const owner =
      row.owner.kind === "organization"
        ? "организация"
        : row.owner.kind === "counterparty"
          ? `контрагент «${row.owner.name}»`
          : "неизвестно";
    lines.push(
      `  ${row.issuerPrefix}, ${EXTENSIONS[row.extension]} (${row.extension}), ${owner}: ` +
        `выдано облаком до ${row.issuedMax ?? "—"}, напечатано до ${row.printedMax ?? "—"}, ` +
        `автоном начнёт с ${row.standaloneStart}, облако перевести на ${row.cloudReseedTo ?? "окно не помещается"}`,
    );
  }
  lines.push(`Замечаний: ${file.notes.length} (их показывает офис автонома перед переносом)`);
  lines.push(`Контрольная сумма: ${file.checksum}`);
  return lines;
}

/**
 * Other tenants of the same database that issue under a prefix this tenant
 * uses. The file never carries their numbers, so the person running the export
 * is told: a serial the standalone would hand out may already be taken there.
 */
export function sharedPrefixWarnings(raw, file) {
  const starts = new Map(
    file.cutover.ssccCounters.map((row) => [
      `${row.issuerPrefix}/${row.extension}`,
      row.standaloneStart,
    ]),
  );
  return raw.otherTenantsSscc.map((row) => {
    const start = starts.get(`${row.issuerPrefix}/${row.extension}`);
    const text =
      `Внимание: под префиксом ${row.issuerPrefix}, ${EXTENSIONS[row.extension]} (${row.extension}) ` +
      `номера выдавал и другой арендатор этой базы, наибольший ${row.maxSerial}; ` +
      `автоном начнёт с ${start ?? "—"}`;
    return start !== undefined && row.maxSerial >= start
      ? `${text} — номера могут повториться: решите до переноса (памятка переключения)`
      : text;
  });
}

export async function main(argv, deps = {}) {
  const {
    run = runPsql,
    now = () => new Date(),
    stdout = (line) => process.stdout.write(`${line}\n`),
    stderr = (line) => process.stderr.write(`${line}\n`),
    writeFile = (path, text) => writeFileSync(path, text, { flag: "wx", mode: 0o600 }),
    env = process.env,
  } = deps;
  if (argv.includes("--help") || argv.includes("-h")) {
    for (const line of USAGE) stdout(line);
    return 0;
  }
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(error.message);
    return 64;
  }
  try {
    const raw = parseRaw(await run({ psql: options.psql, tenantId: options.tenantId, env }));
    const file = buildExportFile(raw, {
      exportedAt: now().toISOString(),
      rehearsal: options.rehearsal,
    });
    const path = join(options.outDir, fileName(file));
    writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
    for (const line of summary(file, path)) stdout(line);
    for (const line of sharedPrefixWarnings(raw, file)) stderr(line);
    for (const line of CREDENTIAL_WARNING) stderr(line);
    return 0;
  } catch (error) {
    if (error instanceof ExportError) {
      stderr(`Выгрузка невозможна: ${error.code}: ${error.message}`);
      for (const blocker of error.blockers ?? []) {
        stderr(
          blocker.code === "active_shift"
            ? `  смена ${blocker.number} не закрыта`
            : `  станция «${blocker.name}» не синхронизирована после последнего закрытия смены`,
        );
      }
      return 2;
    }
    stderr(`Выгрузка не удалась: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
