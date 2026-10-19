/** Database locale is recovery data; never manufacture or refresh ICU versions. */
import { canonical, ensure, keys, quote } from "./schemas.mjs";
const baseKeys = ["encoding", "collate", "ctype", "provider"];
const icuKeys = ["icuLocale", "icuRules", "collationVersion", "actualCollationVersion"];
const bounded = (value, limit) =>
  typeof value === "string" && value.length > 0 && value.length <= limit && !value.includes("\0");
export function validateLocale(locale) {
  keys(locale, [...baseKeys, ...(locale?.provider === "i" ? icuKeys : [])]);
  ensure(["c", "i"].includes(locale.provider));
  ensure(
    [locale.encoding, locale.collate, locale.ctype].every(
      (value) => typeof value === "string" && /^[A-Za-z0-9_.@-]+$/u.test(value),
    ),
  );
  if (locale.provider === "i") {
    ensure(locale.collate === "C" && locale.ctype === "C");
    ensure([locale.encoding, locale.collate, locale.ctype].every((value) => bounded(value, 256)));
    ensure(bounded(locale.icuLocale, 1024));
    ensure(
      locale.icuRules === null ||
        (typeof locale.icuRules === "string" &&
          locale.icuRules.length <= 65536 &&
          !locale.icuRules.includes("\0")),
    );
    ensure(bounded(locale.collationVersion, 256) && bounded(locale.actualCollationVersion, 256));
    ensure(locale.collationVersion === locale.actualCollationVersion);
  }
  return locale;
}
export async function captureLocale(client) {
  const result = await client.query(
    `SELECT pg_encoding_to_char(encoding) AS encoding,datcollate AS collate,datctype AS ctype,datlocprovider AS provider,datlocale AS "icuLocale",daticurules AS "icuRules",datcollversion AS "collationVersion",pg_database_collation_actual_version(oid) AS "actualCollationVersion" FROM pg_database WHERE datname=current_database()`,
  );
  ensure(result.rows.length === 1);
  const row = result.rows[0];
  // Old libc inventories deliberately retain their exact four-field contract.
  return validateLocale(
    row.provider === "c" ? Object.fromEntries(baseKeys.map((key) => [key, row[key]])) : row,
  );
}
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
/** Caller must set standard_conforming_strings=on on this session. */
export function createDatabaseSql(database) {
  const locale = validateLocale(database.locale);
  const base = `CREATE DATABASE ${quote(database.name)} OWNER ${quote(database.owner)} TEMPLATE template0 ENCODING ${literal(locale.encoding)} LC_COLLATE ${literal(locale.collate)} LC_CTYPE ${literal(locale.ctype)} LOCALE_PROVIDER`;
  if (locale.provider === "c") return `${base} libc`;
  return `${base} icu ICU_LOCALE ${literal(locale.icuLocale)}${locale.icuRules === null ? "" : ` ICU_RULES ${literal(locale.icuRules)}`}`;
}
export async function compareDatabaseLocale(client, expected) {
  validateLocale(expected);
  ensure(canonical(await captureLocale(client)) === canonical(expected));
}
