import { BRAND_LETTERHEAD_CONTENT } from "./documents/brand-letterhead.js";
import { CONSENT_CONTENT } from "./documents/consent.js";
import { PRIVACY_CONTENT } from "./documents/privacy.js";
import { TENANT_PROCESSING_CONTENT } from "./documents/tenant-processing.js";
import { formatLegalEffectiveDate, parseLegalRevision } from "./identity.js";
import type { LegalRevision } from "./identity.js";
import type {
  LegalDocumentCode,
  LegalDocumentKind,
  LegalDocumentLocaleContent,
  LegalDocumentRelease,
  LegalDocumentSource,
  LegalLocale,
} from "./types.js";

export const CURRENT_DEMO_CONSENT_ID = "MKR-PD-02/2026.08/01" as const;

const LEGAL_DOCUMENT_CODES = ["MKR-PD-01", "MKR-PD-02", "MKR-DPA-01", "MKR-BRD-01", "MKR-INS-01"] as const;
const LEGAL_DOCUMENT_STATUSES = ["draft", "active", "superseded", "withdrawn"] as const;

export const LEGAL_DOCUMENT_KIND_BY_CODE = {
  "MKR-PD-01": "legal",
  "MKR-PD-02": "legal",
  "MKR-DPA-01": "template",
  "MKR-BRD-01": "template",
  "MKR-INS-01": "instruction",
} as const satisfies Record<LegalDocumentCode, LegalDocumentKind>;

export function legalDocumentKind(code: LegalDocumentCode): LegalDocumentKind {
  return LEGAL_DOCUMENT_KIND_BY_CODE[code];
}

export function legalReleaseLocales(code: LegalDocumentCode): readonly LegalLocale[] {
  return legalDocumentKind(code) === "instruction" ? ["ru"] : ["ru", "en"];
}

export function requireLegalContent(
  source: LegalDocumentSource,
  locale: LegalLocale,
): LegalDocumentLocaleContent {
  const content = source.content[locale];
  if (!content) throw new Error(`Legal document has no ${locale} content: ${source.releaseKey}`);
  return content;
}

export const LEGAL_RELEASES = [
  {
    code: "MKR-PD-01",
    revision: "2026.08/01",
    effectiveDate: "2026-08-15",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/privacy/", en: "/en/privacy/" },
  },
  {
    code: "MKR-PD-02",
    revision: "2026.08/01",
    effectiveDate: "2026-08-15",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/personal-data-consent/", en: "/en/personal-data-consent/" },
  },
  {
    code: "MKR-DPA-01",
    revision: "2026.08/01",
    effectiveDate: "2026-08-15",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: {
      ru: "/legal/tenant-data-processing/",
      en: "/en/legal/tenant-data-processing/",
    },
  },
  {
    code: "MKR-BRD-01",
    revision: "2026.08/01",
    effectiveDate: "2026-08-15",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/legal/brand-letterhead/", en: "/en/legal/brand-letterhead/" },
  },
] as const satisfies readonly LegalDocumentRelease[];

export const LEGAL_DOCUMENTS = [
  { releaseKey: "MKR-PD-01/2026.08/01", content: PRIVACY_CONTENT },
  { releaseKey: "MKR-PD-02/2026.08/01", content: CONSENT_CONTENT },
  { releaseKey: "MKR-DPA-01/2026.08/01", content: TENANT_PROCESSING_CONTENT },
  { releaseKey: "MKR-BRD-01/2026.08/01", content: BRAND_LETTERHEAD_CONTENT },
] as const satisfies readonly LegalDocumentSource[];

function compareLegalRevisions(left: LegalRevision, right: LegalRevision): number {
  const leftParts = parseLegalRevision(left);
  const rightParts = parseLegalRevision(right);
  const leftYear = Number(leftParts.yearMonth.slice(0, 4));
  const leftMonth = Number(leftParts.yearMonth.slice(5));
  const rightYear = Number(rightParts.yearMonth.slice(0, 4));
  const rightMonth = Number(rightParts.yearMonth.slice(5));

  return (
    leftYear - rightYear ||
    leftMonth - rightMonth ||
    Number(leftParts.sequence) - Number(rightParts.sequence)
  );
}

function assertLocaleRoutes(
  code: LegalDocumentCode,
  routes: LegalDocumentRelease["routes"],
): void {
  const expectedLocales = legalReleaseLocales(code);
  const entries = Object.entries(routes) as [LegalLocale, string][];
  if (
    entries.length !== expectedLocales.length ||
    expectedLocales.some((locale) => !(locale in routes))
  ) {
    throw new Error(
      `Legal release ${code} must define routes exactly for: ${expectedLocales.join(", ")}`,
    );
  }

  for (const [locale, route] of entries) {
    if (!route.startsWith("/") || !route.endsWith("/") || route.includes("://")) {
      throw new Error(`Invalid external legal route: ${route}`);
    }
    if (locale === "en" && !route.startsWith("/en/")) {
      throw new Error(`English route must start with /en/: ${route}`);
    }
    if (locale === "ru" && route.startsWith("/en/")) {
      throw new Error(`Russian route must not start with /en/: ${route}`);
    }
  }
}

export function validateLegalRegistry(releases: readonly LegalDocumentRelease[]): void {
  const releaseKeys = new Set<string>();
  const routes = new Set<string>();
  const activeCodes = new Set<LegalDocumentCode>();

  for (const release of releases) {
    if (!(LEGAL_DOCUMENT_CODES as readonly string[]).includes(release.code)) {
      throw new Error(`Invalid legal document code: ${String(release.code)}`);
    }
    if (!(LEGAL_DOCUMENT_STATUSES as readonly string[]).includes(release.status)) {
      throw new Error(`Invalid legal document status: ${String(release.status)}`);
    }
    try {
      parseLegalRevision(release.revision);
    } catch {
      throw new Error(`Invalid legal document revision: ${release.revision}`);
    }
    try {
      formatLegalEffectiveDate(release.effectiveDate, "ru");
    } catch {
      throw new Error(`Invalid legal document effective date: ${release.effectiveDate}`);
    }
    if (release.operatorProfileId !== "operator-2026-08-15") {
      throw new Error(`Unknown operator profile: ${String(release.operatorProfileId)}`);
    }

    const releaseKey = `${release.code}/${release.revision}`;
    if (releaseKeys.has(releaseKey)) throw new Error(`Duplicate release: ${releaseKey}`);
    releaseKeys.add(releaseKey);

    assertLocaleRoutes(release.code, release.routes);
    for (const route of Object.values(release.routes)) {
      if (routes.has(route)) throw new Error(`Duplicate route: ${route}`);
      routes.add(route);
    }

    if (release.status === "active") {
      if (activeCodes.has(release.code)) {
        throw new Error(`Multiple active releases for ${release.code}`);
      }
      activeCodes.add(release.code);
    }
  }

  for (const release of releases) {
    if (!release.supersedes) continue;
    if (!releaseKeys.has(release.supersedes)) {
      throw new Error(`Unknown supersedes reference: ${release.supersedes}`);
    }
    const separator = release.supersedes.indexOf("/");
    const supersededRevision = release.supersedes.slice(separator + 1) as LegalRevision;
    if (compareLegalRevisions(supersededRevision, release.revision) >= 0) {
      throw new Error(`Supersedes must reference an older release: ${release.supersedes}`);
    }
  }

  const activeConsent = releases.find(
    ({ code, status }) => code === "MKR-PD-02" && status === "active",
  );
  if (
    !activeConsent ||
    `${activeConsent.code}/${activeConsent.revision}` !== CURRENT_DEMO_CONSENT_ID
  ) {
    throw new Error("Active consent release is inconsistent with the current consent identifier");
  }
}

export function findLegalRelease(code: LegalDocumentCode, revision?: string): LegalDocumentRelease {
  const release = LEGAL_RELEASES.find(
    (candidate) =>
      candidate.code === code &&
      (revision === undefined ? candidate.status === "active" : candidate.revision === revision),
  );
  if (!release) throw new Error(`Legal release not found: ${code}/${revision ?? "active"}`);
  return release;
}

export function findLegalDocument(code: LegalDocumentCode, revision?: string): LegalDocumentSource {
  const release = findLegalRelease(code, revision);
  const releaseKey = `${release.code}/${release.revision}`;
  const source = LEGAL_DOCUMENTS.find((candidate) => candidate.releaseKey === releaseKey);
  if (!source) throw new Error(`Legal document source not found: ${releaseKey}`);
  return source;
}

validateLegalRegistry(LEGAL_RELEASES);
