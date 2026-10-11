/**
 * From what `export.sql` read to the import file (pilot spec §8.2, §8.7).
 *
 * The file's `payload` is exactly what `POST /v1/office/import` takes
 * (`markiro_proto::cloud_import::CloudImportPayload`): every value already
 * passes the standalone host's rules, so the host can refuse the whole file
 * on any row that does not (that means a damaged file or a bug, never data).
 * What the cloud holds and the standalone cannot keep is changed or left out
 * here and named in `notes`, which the office shows before the import. The
 * file carries PIN and badge hashes and the badge salt, never a badge code:
 * a code is read only to hash it again, and nothing here logs.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";

import { fileChecksum } from "./canonical.mjs";
import { decodeCanonical, hashBadge, isBadgePhcUnder, parsePhc } from "./phc.mjs";
import { BOX_WINDOW, PALLET_WINDOW, planShiftNumberCounters, planSsccCounters } from "./sscc.mjs";

export const FILE_FORMAT = "markiro-cloud-export";
export const FILE_FORMAT_VERSION = 1;
export const TOOL = "standalone-export/1";

/** The host's bounds (`apps/standalone/host/src/validate.rs`). */
const MAX_BOX_CAPACITY = 100_000;
const MAX_PALLET_BOX_CAPACITY = 10_000;
const MAX_SHELF_LIFE_DAYS = 3_650;
const MAX_SPEC_BYTES = 256 * 1024;
const MAX_SPEC_DEPTH = 64;
const MAX_GS1_PREFIXES = 10;

/**
 * What `export.sql` always prints: every list and every count. A key that is
 * missing means the SQL is not this tool's SQL (or ran against a schema it
 * does not know), and reading on would end in a TypeError — or, for a count,
 * in a quiet `undefined > 0`.
 */
const RAW_LISTS = [
  "lines",
  "counterparties",
  "templates",
  "boxDefaults",
  "palletDefaults",
  "products",
  "operators",
  "badges",
  "ssccCounters",
  "ssccBlocks",
  "ssccPrinted",
  "shiftNumberCounters",
  "shiftNumberMaxima",
  "otherTenantsSscc",
  "activeShifts",
  "staleDevices",
];
const RAW_COUNTS = ["nonOperatorBadges", "counterpartyIssuedShifts", "plannedShifts"];

/**
 * A refusal to write any file: the data cannot become a site. The codes:
 * `tenant_not_found`, `org_profile_missing`, `org_gln_missing`,
 * `org_name_missing`, `cloud_not_clean` (with `blockers`), `sscc_exhausted`
 * (the cloud used every serial of a prefix), `sscc_input_invalid` (a prefix,
 * an extension or a serial the export cannot read) and
 * `shift_counter_unreadable` (a shift-number counter that drew numbers but
 * cannot be carried over), `shift_counter_behind` (shifts already hold
 * numbers past their month's counter) and `export_output_invalid` (what
 * `export.sql` printed lacks a list or a count). A message never holds a
 * hash, a salt or a code.
 */
export class ExportError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ExportError";
    this.code = code;
  }
}

/**
 * Free text as the host takes it: every control character (`\p{Cc}`, which
 * is Rust's `char::is_control`) becomes a space, the ends are trimmed, and at
 * most `max` characters (code points, as the host counts them) are kept.
 */
export function plainText(text, max) {
  const replaced = Array.from(text ?? "", (char) => (/\p{Cc}/u.test(char) ? " " : char))
    .join("")
    .trim();
  const chars = Array.from(replaced);
  return chars.length > max ? chars.slice(0, max).join("").trim() : replaced;
}

/** How deep a value nests: an object or an array is a level, a scalar none. */
export function depthOf(value) {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depthOf));
  if (value !== null && typeof value === "object") {
    return 1 + Math.max(0, ...Object.values(value).map(depthOf));
  }
  return 0;
}

/** An INN of 10 or 12 digits after trimming, else `null`. */
function innOf(text) {
  const inn = (text ?? "").trim();
  return /^(?:\d{10}|\d{12})$/u.test(inn) ? inn : null;
}

/** GS1 prefixes as the host keeps them: trimmed, 4–12 digits, distinct, at most 10. */
function prefixesOf(values, note) {
  const kept = [];
  for (const value of values ?? []) {
    const prefix = value.trim();
    if (kept.includes(prefix)) continue;
    if (!/^\d{4,12}$/u.test(prefix) || kept.length === MAX_GS1_PREFIXES) {
      note({ value });
      continue;
    }
    kept.push(prefix);
  }
  return kept;
}

/** A count within 1..=`max`, else `null`. */
function countOf(value, max) {
  return Number.isInteger(value) && value >= 1 && value <= max ? value : null;
}

/** Whether a template may stand in the slot of `purpose` for `category` (`null`: the organization's), as the host's `templates::fits`. */
function fits(template, purpose, category) {
  if (!template.enabled || template.purpose !== purpose) return false;
  if (template.chzProductGroupCodes === null) return true;
  return category !== null && template.chzProductGroupCodes.includes(category);
}

function formatShiftNumber({ monthKey, seq, createdFrom }) {
  return `${monthKey}-${String(seq).padStart(3, "0")}${createdFrom === "station" ? "/S" : ""}`;
}

/** `raw` has every list and count `export.sql` prints, or the export stops. */
function assertRawShape(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ExportError("export_output_invalid", "the export output is not an object");
  }
  for (const key of RAW_LISTS) {
    if (!Array.isArray(raw[key])) {
      throw new ExportError("export_output_invalid", `the export output has no list "${key}"`);
    }
  }
  for (const key of RAW_COUNTS) {
    if (!Number.isSafeInteger(raw[key]) || raw[key] < 0) {
      throw new ExportError("export_output_invalid", `the export output has no count "${key}"`);
    }
  }
  if (raw.formatVersion !== 1) {
    throw new ExportError("export_output_invalid", "the export output is not format version 1");
  }
}

/**
 * The import file of `raw`. Throws `ExportError` when no file can be made
 * (no tenant, no organization profile or GLN, a used-up prefix) and, unless
 * `rehearsal`, when the cloud is not clean (an active shift, a station with a
 * live block that has not synced since the last close: pilot spec §8.6).
 */
export function buildExportFile(raw, options) {
  const {
    exportedAt,
    rehearsal = false,
    windows = { box: BOX_WINDOW, pallet: PALLET_WINDOW },
    randomBytes = nodeRandomBytes,
  } = options;
  const notes = [];
  const note = (entry) => notes.push(entry);

  assertRawShape(raw);
  if (raw.tenant === null) throw new ExportError("tenant_not_found", "no such tenant");
  if (raw.orgProfile === null) {
    throw new ExportError("org_profile_missing", "the tenant has no organization profile");
  }
  const gln = (raw.orgProfile.gln ?? "").trim();
  if (!/^\d{13}$/u.test(gln)) {
    throw new ExportError("org_gln_missing", "the organization profile has no 13-digit GLN");
  }
  const orgName = plainText(raw.tenant.name, 200);
  if (orgName === "") throw new ExportError("org_name_missing", "the organization has no name");

  const blockers = [
    ...raw.activeShifts.map((shift) => ({
      code: "active_shift",
      number: formatShiftNumber(shift),
    })),
    ...raw.staleDevices.map((device) => ({
      code: "device_out_of_sync",
      id: device.id,
      name: device.name,
    })),
  ];
  if (blockers.length > 0 && !rehearsal) {
    const error = new ExportError(
      "cloud_not_clean",
      "the cloud has an active shift or an unsynced station",
    );
    error.blockers = blockers;
    throw error;
  }
  for (const blocker of blockers) note(blocker);

  // Organization.
  if (orgName !== raw.tenant.name)
    note({ code: "text_changed", entity: "organization", field: "name" });
  const orgInn = innOf(raw.orgProfile.inn);
  if (orgInn === null && raw.orgProfile.inn !== null) {
    note({ code: "inn_dropped", entity: "organization" });
  }
  const orgPrefixes = prefixesOf(raw.orgProfile.gs1Prefixes, ({ value }) =>
    note({ code: "gs1_prefix_dropped", entity: "organization", value }),
  );
  let timeZone = (raw.orgProfile.timeZone ?? "").trim();
  if (!/^[A-Za-z0-9/_+-]{1,64}$/u.test(timeZone)) {
    note({ code: "time_zone_replaced", value: raw.orgProfile.timeZone });
    timeZone = "Europe/Moscow";
  }
  const organization = { name: orgName, inn: orgInn, gln, gs1Prefixes: orgPrefixes, timeZone };

  // Lines: a name the host keys without case once only (« (2)» after the second).
  const lines = [];
  const lineKeys = new Set();
  for (const line of raw.lines) {
    const name = plainText(line.name, 100);
    if (name === "") {
      note({ code: "line_dropped", id: line.id });
      continue;
    }
    let unique = name;
    for (let n = 2; lineKeys.has(unique.toLowerCase()); n += 1) {
      const suffix = ` (${n})`;
      unique = `${Array.from(name)
        .slice(0, 100 - suffix.length)
        .join("")
        .trim()}${suffix}`;
    }
    if (unique !== line.name)
      note({ code: "line_renamed", id: line.id, from: line.name, to: unique });
    lineKeys.add(unique.toLowerCase());
    lines.push({ id: line.id, name: unique });
  }

  // Counterparties.
  const counterparties = [];
  let counterpartyNotes = 0;
  for (const each of raw.counterparties) {
    if (each.hasNotes) counterpartyNotes += 1;
    const cpGln = (each.gln ?? "").trim();
    const name = plainText(each.name, 200);
    if (!/^\d{13}$/u.test(cpGln) || name === "") {
      note({ code: "counterparty_dropped", id: each.id, reason: name === "" ? "name" : "gln" });
      continue;
    }
    if (name !== each.name)
      note({ code: "text_changed", entity: "counterparties", id: each.id, field: "name" });
    const inn = innOf(each.inn);
    if (inn === null && each.inn !== null)
      note({ code: "inn_dropped", entity: "counterparties", id: each.id });
    const gs1Prefixes = prefixesOf(each.gs1Prefixes, ({ value }) =>
      note({ code: "gs1_prefix_dropped", entity: "counterparties", id: each.id, value }),
    );
    counterparties.push({ id: each.id, name, inn, gln: cpGln, gs1Prefixes });
  }
  if (counterpartyNotes > 0) note({ code: "counterparty_notes_lost", count: counterpartyNotes });

  // Templates.
  const templates = [];
  const templateById = new Map();
  for (const each of raw.templates) {
    const name = plainText(each.name, 200);
    let reason = null;
    if (name === "") reason = "name";
    else if (each.spec === null || typeof each.spec !== "object" || Array.isArray(each.spec)) {
      reason = "spec_not_object";
    } else if (depthOf(each.spec) > MAX_SPEC_DEPTH) reason = "spec_too_deep";
    else if (Buffer.byteLength(JSON.stringify(each.spec), "utf8") > MAX_SPEC_BYTES) {
      reason = "spec_too_large";
    }
    if (reason !== null) {
      note({ code: "template_dropped", id: each.id, reason });
      continue;
    }
    if (name !== each.name)
      note({ code: "text_changed", entity: "templates", id: each.id, field: "name" });
    const template = {
      id: each.id,
      name,
      purpose: each.purpose,
      enabled: each.enabled,
      chzProductGroupCodes: each.chzProductGroupCodes,
      spec: each.spec,
    };
    templates.push(template);
    templateById.set(template.id, template);
  }

  // Template defaults: only a template that fits its slot, as the host checks.
  const orgDefault = (id, purpose) => {
    if (id === null) return null;
    const template = templateById.get(id);
    if (template !== undefined && fits(template, purpose, null)) return id;
    note({ code: "template_default_dropped", purpose, chzProductGroupCode: null, templateId: id });
    return null;
  };
  const categories = [];
  for (const [purpose, rows] of [
    ["box", raw.boxDefaults],
    ["pallet", raw.palletDefaults],
  ]) {
    for (const row of rows) {
      const template = templateById.get(row.templateId);
      if (template !== undefined && fits(template, purpose, row.chzProductGroupCode)) {
        categories.push({
          chzProductGroupCode: row.chzProductGroupCode,
          purpose,
          templateId: row.templateId,
        });
      } else {
        note({
          code: "template_default_dropped",
          purpose,
          chzProductGroupCode: row.chzProductGroupCode,
          templateId: row.templateId,
        });
      }
    }
  }
  categories.sort((a, b) =>
    a.chzProductGroupCode === b.chzProductGroupCode
      ? a.purpose < b.purpose
        ? -1
        : 1
      : a.chzProductGroupCode - b.chzProductGroupCode,
  );
  const templateDefaults = {
    defaultBoxTemplateId: orgDefault(raw.orgProfile.defaultBoxTemplateId, "box"),
    defaultPalletTemplateId: orgDefault(raw.orgProfile.defaultPalletTemplateId, "pallet"),
    categories,
  };

  // Products.
  const products = [];
  const lost = new Map();
  for (const each of raw.products) {
    for (const field of each.lost) lost.set(field, (lost.get(field) ?? 0) + 1);
    const name = plainText(each.name, 200);
    if (!/^\d{14}$/u.test(each.gtin14) || name === "") {
      note({ code: "product_dropped", id: each.id, reason: name === "" ? "name" : "gtin" });
      continue;
    }
    if (name !== each.name)
      note({ code: "text_changed", entity: "products", id: each.id, field: "name" });
    const printName = each.printName === null ? null : plainText(each.printName, 200) || null;
    if (each.printName !== null && printName !== each.printName) {
      note({ code: "text_changed", entity: "products", id: each.id, field: "printName" });
    }
    const bounded = (field, max) => {
      const value = countOf(each[field], max);
      if (value === null && each[field] !== null)
        note({ code: "product_value_cleared", id: each.id, field });
      return value;
    };
    let defaultBoxTemplateId = null;
    let defaultPalletTemplateId = null;
    if (each.defaultLabelTemplateId !== null) {
      const template = templateById.get(each.defaultLabelTemplateId);
      if (template?.purpose === "box") defaultBoxTemplateId = template.id;
      else if (template?.purpose === "pallet") defaultPalletTemplateId = template.id;
      else
        note({
          code: "product_template_dropped",
          id: each.id,
          templateId: each.defaultLabelTemplateId,
        });
    }
    products.push({
      id: each.id,
      gtin14: each.gtin14,
      name,
      printName,
      chzProductGroupCode: each.chzProductGroupCode,
      boxCapacity: bounded("boxCapacity", MAX_BOX_CAPACITY),
      palletBoxCapacity: bounded("palletBoxCapacity", MAX_PALLET_BOX_CAPACITY),
      shelfLifeDays: bounded("shelfLifeDays", MAX_SHELF_LIFE_DAYS),
      defaultBoxTemplateId,
      defaultPalletTemplateId,
      archived: each.archived,
    });
  }
  for (const [field, count] of [...lost.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    note({ code: "product_fields_lost", field, count });
  }

  // Operators: the PIN hash moves byte for byte (§8.3).
  const operators = [];
  for (const each of raw.operators) {
    const name = plainText(each.fullName, 100);
    let reason = null;
    if (!/^\d{3,12}$/u.test(each.login)) reason = "login";
    else if (parsePhc(each.pinHash) === null) reason = "pin";
    else if (name === "") reason = "name";
    if (reason !== null) {
      note({ code: "operator_dropped", id: each.id, reason });
      continue;
    }
    if (name !== each.fullName)
      note({ code: "text_changed", entity: "operators", id: each.id, field: "name" });
    const role = each.role === null ? null : plainText(each.role, 120) || null;
    if (each.role !== null && role !== each.role) {
      note({ code: "text_changed", entity: "operators", id: each.id, field: "role" });
    }
    operators.push({
      id: each.id,
      login: each.login,
      name,
      role,
      pinPhc: each.pinHash,
      active: each.credentialActive && each.employeeStatus === "active",
    });
  }

  // Badges: the tenant's salt becomes the site's (§8.3, option 1). A badge
  // whose hash is missing or carries another salt is hashed again from its
  // code, as the cloud's `activeBadgeHashes` does; a code a station could not
  // read (not 1–256 printable ASCII after trimming) is left out.
  const operatorIds = new Set(operators.map((operator) => operator.id));
  const kept = raw.badges.filter((badge) => {
    if (operatorIds.has(badge.operatorId)) return true;
    note({ code: "badge_dropped", id: badge.id, reason: "operator" });
    return false;
  });
  let badgeSalt = decodeCanonical(raw.badgeSalt, 16) === null ? null : raw.badgeSalt;
  if (badgeSalt === null && kept.length > 0) {
    badgeSalt = randomBytes(16).toString("base64");
    note({ code: "badge_salt_created" });
  }
  const badges = [];
  const phcs = new Set();
  let rehashed = 0;
  for (const each of kept) {
    const code = each.badgeCode.trim();
    if (!/^[ -~]{1,256}$/u.test(code)) {
      note({ code: "badge_dropped", id: each.id, reason: "code" });
      continue;
    }
    let badgePhc = each.badgeHash;
    if (code !== each.badgeCode || !isBadgePhcUnder(badgePhc, badgeSalt)) {
      badgePhc = hashBadge(code, badgeSalt);
      rehashed += 1;
    }
    if (phcs.has(badgePhc)) {
      note({ code: "badge_dropped", id: each.id, reason: "duplicate" });
      continue;
    }
    phcs.add(badgePhc);
    const label = each.label === null ? null : plainText(each.label, 100) || null;
    badges.push({ id: each.id, operatorId: each.operatorId, badgePhc, label });
  }
  if (rehashed > 0) note({ code: "badges_rehashed", count: rehashed });
  if (raw.nonOperatorBadges > 0)
    note({ code: "badges_not_operators", count: raw.nonOperatorBadges });

  // SSCC and shift numbers (§8.4, §8.5).
  const owners = (prefix) => {
    if (prefix === gln.slice(0, 9)) return { kind: "organization" };
    const counterparty = counterparties.find((each) => each.gln.slice(0, 9) === prefix);
    return counterparty === undefined
      ? { kind: "unknown" }
      : { kind: "counterparty", id: counterparty.id, name: counterparty.name };
  };
  let cutoverCounters;
  try {
    cutoverCounters = planSsccCounters(
      { counters: raw.ssccCounters, blocks: raw.ssccBlocks, printed: raw.ssccPrinted },
      owners,
      windows,
    );
  } catch (error) {
    // A prefix the cloud used up is the owner's decision; a value the export
    // cannot read (a RangeError of `sscc.mjs`) is a damaged read, never the same.
    throw new ExportError(
      error instanceof RangeError ? "sscc_input_invalid" : "sscc_exhausted",
      error.message,
      { cause: error },
    );
  }
  for (const row of cutoverCounters) {
    if (row.cloudReseedTo === null) {
      note({
        code: "sscc_window_does_not_fit",
        issuerPrefix: row.issuerPrefix,
        extension: row.extension,
      });
    }
  }
  if (raw.counterpartyIssuedShifts > 0) {
    note({ code: "counterparty_sscc_used", count: raw.counterpartyIssuedShifts });
  }
  if (raw.plannedShifts > 0) note({ code: "planned_shifts_not_moved", count: raw.plannedShifts });

  // A month the cloud drew numbers in, left out of the planned counters (a key
  // that is no MONYY, a count that is no whole number), would draw its numbers
  // again on the standalone: a note cannot repair that, so the export stops.
  const shiftNumberCounters = planShiftNumberCounters(raw.shiftNumberCounters);
  const unreadable = raw.shiftNumberCounters.filter(
    (counter) => planShiftNumberCounters([counter]).length === 0 && counter.lastSeq !== 0,
  );
  if (unreadable.length > 0) {
    throw new ExportError(
      "shift_counter_unreadable",
      `${unreadable.length} shift-number counter(s) cannot be carried over: ` +
        unreadable.map((counter) => JSON.stringify(counter.monthKey)).join(", "),
    );
  }

  // The shifts themselves must not be ahead of the counters: a month whose
  // shifts hold a number past its counter (or have no counter at all) would
  // hand the same number out again on the standalone.
  const lastSeqByMonth = new Map(
    raw.shiftNumberCounters.map((counter) => [counter.monthKey, counter.lastSeq]),
  );
  const behind = raw.shiftNumberMaxima.filter((each) => {
    const last = lastSeqByMonth.get(each.monthKey);
    return !(last >= each.maxSeq);
  });
  if (behind.length > 0) {
    throw new ExportError(
      "shift_counter_behind",
      `shifts hold numbers past their month's counter: ` +
        behind
          .map(
            (each) =>
              `${JSON.stringify(each.monthKey)} (shifts up to ${each.maxSeq}, counter ${
                lastSeqByMonth.get(each.monthKey) ?? "missing"
              })`,
          )
          .join(", "),
    );
  }

  const payload = {
    organization,
    badgeSalt,
    lines,
    counterparties,
    templates,
    templateDefaults,
    products,
    operators,
    badges,
    ssccCounters: cutoverCounters.map((row) => ({
      issuerPrefix: row.issuerPrefix,
      extension: row.extension,
      nextSerial: row.standaloneStart,
    })),
    shiftNumberCounters,
  };
  const file = {
    format: FILE_FORMAT,
    formatVersion: FILE_FORMAT_VERSION,
    tool: TOOL,
    exportedAt,
    rehearsal,
    checksum: "",
    source: { tenantId: raw.tenant.id, tenantName: orgName },
    payload,
    cutover: {
      boxWindow: windows.box,
      palletWindow: windows.pallet,
      ssccCounters: cutoverCounters,
    },
    notes,
  };
  file.checksum = fileChecksum(file);
  return file;
}
