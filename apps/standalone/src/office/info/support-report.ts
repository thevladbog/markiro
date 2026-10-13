import type { TFunction } from "i18next";

import type { InstallRole } from "../../host/device.js";

/** The state of the link to the host as the shell reports it (`HostStatus.state`). */
export type ReportLinkState = "online" | "connecting" | "offline";

/**
 * Everything the support text may say, field by field. The text is built from
 * this list alone: a field that is not here cannot reach it, whatever the
 * object holds (a session, a device record, a copy of the host's reply). Do
 * not add a field that carries a secret: no PIN, badge, hash, key, token,
 * password or pairing code, no certificate fingerprint, no path with a user's
 * name.
 */
export interface SupportFacts {
  generatedAt: Date;
  appVersion: string | null;
  buildCommit: string | null;
  buildDate: string | null;
  /** The protocol this build of the app speaks. */
  appProtocol: number;
  hostVersion: string | null;
  hostProtocol: number | null;
  hostMinProtocol: number | null;
  role: InstallRole | "unknown";
  os: string | null;
  arch: string | null;
  webview: string | null;
  /** Whether the host answered `hello` just now. */
  hostReachable: boolean;
  linkState: ReportLinkState | null;
  /** The paired host's address; only its scheme, name and port reach the text. */
  hostAddress: string | null;
  /** The host's id; only its first eight characters reach the text. */
  hostId: string | null;
  /** The newest verified copy's time, an instant. */
  lastBackupAt: string | null;
}

/** The i18n key of a role under `office.about.role`: `null` is a development build, which has no installer. */
export function roleKey(
  role: InstallRole | "unknown",
): "host" | "station" | "office" | "development" | "unknown" {
  return role === null ? "development" : role;
}

const MAX_VALUE_CHARS = 120;
const SHORT_ID_CHARS = 8;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Control characters, no-break and zero-width spaces, line separators and bidirectional controls. */
/* eslint-disable no-control-regex -- control characters are exactly what this removes. */
const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f\u00a0\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g;
/* eslint-enable no-control-regex */

/**
 * One value as the text carries it: no control characters, a Windows user
 * folder named only by `%USERPROFILE%`, a PHC hash or a long token-like run
 * hidden, and at most `MAX_VALUE_CHARS` characters. A second guard behind the
 * allowlist, for a value that carries more than its field should.
 */
export function safeValue(value: string): string {
  const text = value
    .replace(INVISIBLE, " ")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/gi, "%USERPROFILE%")
    .replace(/\$[a-z0-9-]+\$[^\s]*/gi, "[скрыто]")
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, "[скрыто]")
    .trim();
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

/** The first characters of a UUID, never the whole id; `null` for anything else. */
export function shortId(id: string | null): string | null {
  if (id === null || !UUID.test(id)) return null;
  return id.slice(0, SHORT_ID_CHARS).toLowerCase();
}

/** `scheme://host:port` of an address, without a user, a password, a path or a query; `null` if it is none. */
export function plainAddress(address: string | null): string | null {
  if (address === null) return null;
  try {
    const url = new URL(address);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function instant(value: string | null): string | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** The label of a line and its value, in the order the text prints them. */
function lines(facts: SupportFacts, t: TFunction): [string, string][] {
  const unknown = t("office.about.report.unknown");
  const yes = t("office.about.report.yes");
  const no = t("office.about.report.no");
  const known = (value: string | null): string => (value === null ? unknown : safeValue(value));
  const build =
    facts.buildCommit === null && facts.buildDate === null
      ? unknown
      : [facts.buildCommit, facts.buildDate]
          .filter((part): part is string => part !== null)
          .map(safeValue)
          .join(", ");
  const protocols = t("office.about.report.protocols", {
    app: facts.appProtocol,
    host: facts.hostProtocol ?? unknown,
    min: facts.hostMinProtocol ?? unknown,
  });
  const system = [facts.os, facts.arch, facts.webview]
    .filter((part): part is string => part !== null)
    .map(safeValue)
    .join(", ");
  const address = plainAddress(facts.hostAddress);
  const id = shortId(facts.hostId);
  const host =
    address === null
      ? unknown
      : id === null
        ? safeValue(address)
        : `${safeValue(address)} (${t("office.about.report.hostId", { id })})`;
  return [
    [t("office.about.report.appVersion"), known(facts.appVersion)],
    [t("office.about.report.build"), build],
    [t("office.about.report.hostVersion"), known(facts.hostVersion)],
    [t("office.about.report.protocol"), protocols],
    [t("office.about.report.role"), t(`office.about.role.${roleKey(facts.role)}`)],
    [t("office.about.report.system"), system === "" ? unknown : system],
    [t("office.about.report.hostReachable"), facts.hostReachable ? yes : no],
    [
      t("office.about.report.link"),
      facts.linkState === null ? unknown : t(`office.about.link.${facts.linkState}`),
    ],
    [t("office.about.report.host"), host],
    [t("office.about.report.lastBackup"), known(instant(facts.lastBackupAt))],
    [t("office.about.report.license"), t("office.about.license.notConnected")],
  ];
}

/**
 * An extra block of the support text (extension point T2 of the license and
 * update spec): a heading and «label: value» lines the contributor has
 * already translated. Every heading, label and value passes `safeValue` here,
 * so a contributor cannot bring a long token or a user's folder into the text;
 * what it must not put in at all (hashes, keys, tokens, pairing codes, the
 * text of a license file) is the contributor's rule, and its test's.
 */
export interface SupportBlock {
  title: string;
  lines: readonly (readonly [label: string, value: string])[];
}

/**
 * The support text: a title, when it was made (UTC) and one line for each
 * allowlisted fact. Plain text, so it pastes into a letter and a file alike.
 */
export function buildSupportReport(
  facts: SupportFacts,
  t: TFunction,
  blocks: readonly SupportBlock[] = [],
): string {
  const head = [
    t("office.about.report.title"),
    t("office.about.report.generated", { when: facts.generatedAt.toISOString() }),
    "",
  ];
  const extra = blocks.flatMap((block) => [
    "",
    safeValue(block.title),
    ...block.lines.map(([label, value]) => `${safeValue(label)}: ${safeValue(value)}`),
  ]);
  return [
    ...head,
    ...lines(facts, t).map(([label, value]) => `${label}: ${value}`),
    ...extra,
    "",
  ].join("\r\n");
}
