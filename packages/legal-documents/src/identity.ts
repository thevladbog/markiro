import type { LegalDocumentCode, LegalLocale } from "./types.js";

export type LegalRevision = `${number}.${number}/${number}`;

export interface LegalRevisionParts {
  readonly yearMonth: `${number}.${number}`;
  readonly sequence: `${number}`;
}

export interface LegalIdentity {
  readonly code: LegalDocumentCode;
  readonly revision: LegalRevision;
  readonly effectiveDate: `${number}-${number}-${number}`;
}

const LEGAL_REVISION_PATTERN = /^(\d{4}\.(?:0[1-9]|1[0-2]))\/(0[1-9]|[1-9]\d)$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ENGLISH_MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function parseLegalRevision(value: string): LegalRevisionParts {
  const match = LEGAL_REVISION_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid legal revision: ${value}`);

  return {
    yearMonth: match[1] as LegalRevisionParts["yearMonth"],
    sequence: match[2] as LegalRevisionParts["sequence"],
  };
}

export function legalRevisionFileToken(value: LegalRevision): `${number}.${number}-${number}` {
  const { yearMonth, sequence } = parseLegalRevision(value);
  return `${yearMonth}-${sequence}`;
}

export function formatLegalEffectiveDate(value: string, locale: LegalLocale): string {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid legal effective date: ${value}`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid legal effective date: ${value}`);
  }

  if (locale === "ru") return `${match[3]}.${match[2]}.${match[1]}`;
  const englishMonth = ENGLISH_MONTH_NAMES[month - 1];
  if (!englishMonth) throw new Error(`Invalid legal effective date: ${value}`);
  return `${day} ${englishMonth} ${year}`;
}

export function legalVerificationPath(
  release: LegalIdentity,
): `/d/${string}/${string}/${string}/${string}` {
  return `/d/${release.code}/${release.revision}/${formatLegalEffectiveDate(
    release.effectiveDate,
    "ru",
  )}`;
}

export function legalVerificationUrl(
  release: LegalIdentity,
): `https://markiro.app/d/${string}/${string}/${string}/${string}` {
  return `https://markiro.app${legalVerificationPath(release)}`;
}
