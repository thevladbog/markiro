import type { LegalDocumentCode, LegalDocumentRelease, LegalLocale } from "./types.js";

export const CURRENT_DEMO_CONSENT_ID = "MKR-PD-02/2026.08.01" as const;

const LEGAL_DOCUMENT_CODES = ["MKR-PD-01", "MKR-PD-02", "MKR-DPA-01", "MKR-BRD-01"] as const;
const LEGAL_DOCUMENT_STATUSES = ["draft", "active", "superseded", "withdrawn"] as const;
const REVISION_PATTERN = /^(\d{4})\.(0[1-9]|1[0-2])\.(\d{2})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const LEGAL_RELEASES = [
  {
    code: "MKR-PD-01",
    revision: "2026.08.01",
    effectiveDate: "2026-08-15",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/privacy/", en: "/en/privacy/" },
  },
  {
    code: "MKR-PD-02",
    revision: "2026.08.01",
    effectiveDate: "2026-08-15",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/personal-data-consent/", en: "/en/personal-data-consent/" },
  },
  {
    code: "MKR-DPA-01",
    revision: "2026.08.01",
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
    revision: "2026.08.01",
    effectiveDate: "2026-08-15",
    status: "active",
    operatorProfileId: "operator-2026-08-15",
    routes: { ru: "/legal/brand-letterhead/", en: "/en/legal/brand-letterhead/" },
  },
] as const satisfies readonly LegalDocumentRelease[];

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isCalendarRevision(value: string): boolean {
  const match = REVISION_PATTERN.exec(value);
  if (!match) return false;
  return isCalendarDate(`${match[1]}-${match[2]}-${match[3]}`);
}

function assertLocaleRoutes(routes: LegalDocumentRelease["routes"]): void {
  const entries = Object.entries(routes);
  if (entries.length !== 2 || !("ru" in routes) || !("en" in routes)) {
    throw new Error("Legal release must define paired RU and EN locale routes");
  }

  for (const [locale, route] of entries as [LegalLocale, string][]) {
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
    if (!isCalendarRevision(release.revision)) {
      throw new Error(`Invalid legal document revision: ${release.revision}`);
    }
    if (!isCalendarDate(release.effectiveDate)) {
      throw new Error(`Invalid legal document effective date: ${release.effectiveDate}`);
    }
    if (release.operatorProfileId !== "operator-2026-08-15") {
      throw new Error(`Unknown operator profile: ${String(release.operatorProfileId)}`);
    }

    const releaseKey = `${release.code}/${release.revision}`;
    if (releaseKeys.has(releaseKey)) throw new Error(`Duplicate release: ${releaseKey}`);
    releaseKeys.add(releaseKey);

    assertLocaleRoutes(release.routes);
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
    const separator = release.supersedes.lastIndexOf("/");
    const supersededRevision = release.supersedes.slice(separator + 1);
    if (supersededRevision >= release.revision) {
      throw new Error(`Supersedes must reference an older release: ${release.supersedes}`);
    }
  }

  const activeConsent = releases.find(
    ({ code, status }) => code === "MKR-PD-02" && status === "active",
  );
  if (!activeConsent || `${activeConsent.code}/${activeConsent.revision}` !== CURRENT_DEMO_CONSENT_ID) {
    throw new Error("Active consent release is inconsistent with the current consent identifier");
  }
}

export function findLegalRelease(
  code: LegalDocumentCode,
  revision?: string,
): LegalDocumentRelease {
  const release = LEGAL_RELEASES.find(
    (candidate) =>
      candidate.code === code &&
      (revision === undefined ? candidate.status === "active" : candidate.revision === revision),
  );
  if (!release) throw new Error(`Legal release not found: ${code}/${revision ?? "active"}`);
  return release;
}

validateLegalRegistry(LEGAL_RELEASES);
