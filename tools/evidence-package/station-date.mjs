import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli.mjs";
import {
  bindEvidenceRoot,
  closeEvidenceRoot,
  installBoundFileIfMissing,
  invalid,
} from "./secure-filesystem.mjs";

function capturedAt(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/u, "+00:00");
}

function validateArgument(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    invalid(`${label} is invalid`);
  }
}

function validateProductionDate(value) {
  if (value === null) return;
  if (typeof value !== "string") {
    invalid("Station production date must be null or a real YYYY-MM-DD date");
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) invalid("Station production date must be null or a real YYYY-MM-DD date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999) {
    invalid("Station production date must be null or a real YYYY-MM-DD date");
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    invalid("Station production date must be null or a real YYYY-MM-DD date");
  }
}

function validateOutputName(relativePath) {
  if (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.includes("/") ||
    relativePath.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(relativePath) ||
    Buffer.byteLength(relativePath) > 180
  ) {
    invalid("evidence output filename is invalid");
  }
}

async function writeNewJson(outputPath, contents, options) {
  const target = resolve(outputPath);
  const parent = dirname(target);
  const relativePath = basename(target);
  validateOutputName(relativePath);
  const session = await bindEvidenceRoot(parent, options);
  try {
    await installBoundFileIfMissing(session, relativePath, contents, async () => {
      invalid("evidence output already exists");
    });
  } finally {
    await closeEvidenceRoot(session);
  }
}

export async function captureStationProductionDate(
  databasePath,
  shiftId,
  outputPath,
  options = {},
) {
  validateArgument(databasePath, "Station database path");
  validateArgument(shiftId, "shift id");
  validateArgument(outputPath, "evidence output path");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let rows;
  try {
    try {
      rows = database
        .prepare("SELECT id, production_date FROM shift_mirror WHERE id = ?")
        .all(shiftId);
    } catch (error) {
      if (error?.code === "ERR_SQLITE_ERROR") {
        invalid("Station database schema is incompatible", { cause: error });
      }
      throw error;
    }
  } finally {
    database.close();
  }
  if (rows.length !== 1) invalid("Station shift query must return exactly one row");
  if (rows[0].id !== shiftId) invalid("Station shift query returned an unexpected id");
  validateProductionDate(rows[0].production_date);

  const evidence = {
    version: 1,
    source: "station_mirror",
    shiftId: rows[0].id,
    productionDate: rows[0].production_date,
    capturedAt: capturedAt(),
  };
  await writeNewJson(outputPath, Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`), options);
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli({
    action: ([databasePath, shiftId, outputPath]) =>
      captureStationProductionDate(databasePath, shiftId, outputPath),
    args: process.argv.slice(2),
    command: "evidence:station-date",
    expectedArgs: 3,
    formatSuccess: () => "Captured Station production date evidence: 1 row\n",
    usage: "usage: evidence:station-date <station-db-path> <shift-id> <output-json>",
  });
}
