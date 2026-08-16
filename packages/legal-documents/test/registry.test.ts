import { describe, expect, it } from "vitest";
import {
  CURRENT_DEMO_CONSENT_ID,
  LEGAL_RELEASES,
  OPERATOR_PROFILES,
  findLegalRelease,
  parseLegalRevision,
  validateLegalRegistry,
  type LegalDocumentRelease,
} from "../src/index.js";

const cloneReleases = (): LegalDocumentRelease[] =>
  LEGAL_RELEASES.map((release) => ({ ...release, routes: { ...release.routes } }));

describe("legal document registry", () => {
  it("pins the first release set and operator snapshot", () => {
    expect(LEGAL_RELEASES.map(({ code }) => code)).toEqual([
      "MKR-PD-01",
      "MKR-PD-02",
      "MKR-DPA-01",
      "MKR-BRD-01",
    ]);
    expect(OPERATOR_PROFILES["operator-2026-08-15"]).toEqual({
      name: "Богатырев Владислав Сергеевич",
      address:
        "353745, Краснодарский край, Ленинградский район, ст. Ленинградская, ул. Грузская, д. 26",
      email: "hello@v-b.tech",
      phone: "+7 934 355-14-90",
      site: "https://markiro.app",
    });
    expect(CURRENT_DEMO_CONSENT_ID).toBe("MKR-PD-02/2026.08/01");
    expect(CURRENT_DEMO_CONSENT_ID.length).toBeLessThanOrEqual(64);
  });

  it("pins paired, unique public routes and valid initial metadata", () => {
    expect(() => validateLegalRegistry(LEGAL_RELEASES)).not.toThrow();
    expect(LEGAL_RELEASES.every(({ revision }) => revision === "2026.08/01")).toBe(true);
    expect(LEGAL_RELEASES.every(({ effectiveDate }) => effectiveDate === "2026-08-15")).toBe(true);
    expect(new Set(LEGAL_RELEASES.flatMap(({ routes }) => Object.values(routes))).size).toBe(8);
    expect(findLegalRelease("MKR-PD-02")).toBe(LEGAL_RELEASES[1]);
    expect(findLegalRelease("MKR-PD-02", "2026.08/01")).toBe(LEGAL_RELEASES[1]);
  });

  it("accepts a year-month revision with a two-digit sequence", () => {
    expect(parseLegalRevision("2026.08/01")).toEqual({ yearMonth: "2026.08", sequence: "01" });
  });

  it.each(["2026.08.01", "2026.08/1", "2026.08/00", "2026.08/100"])(
    "rejects an invalid legal revision %s",
    (revision) => {
      expect(() => parseLegalRevision(revision)).toThrow(/invalid legal revision/i);
    },
  );

  it("rejects duplicate code and revision pairs", () => {
    expect(() => validateLegalRegistry([...LEGAL_RELEASES, LEGAL_RELEASES[0]!])).toThrow(
      /duplicate release/i,
    );
  });

  it("rejects duplicate public routes", () => {
    const releases = cloneReleases();
    releases[1] = { ...releases[1]!, routes: releases[0]!.routes };
    expect(() => validateLegalRegistry(releases)).toThrow(/duplicate route/i);
  });

  it.each([
    ["invalid code", { code: "MKR-UNKNOWN-01" }],
    ["invalid year-month revision", { revision: "2026.13/01" }],
    ["zero revision sequence", { revision: "2026.08/00" }],
    ["non-two-digit revision sequence", { revision: "2026.02/1" }],
    ["invalid ISO date", { effectiveDate: "2026-02-31" }],
  ])("rejects %s", (_label, mutation) => {
    const releases = cloneReleases();
    releases[0] = { ...releases[0]!, ...mutation } as LegalDocumentRelease;
    expect(() => validateLegalRegistry(releases)).toThrow();
  });

  it("rejects missing or mismatched locale routes", () => {
    const missing = cloneReleases();
    missing[0] = {
      ...missing[0]!,
      routes: { ru: missing[0]!.routes.ru },
    } as LegalDocumentRelease;
    expect(() => validateLegalRegistry(missing)).toThrow(/locale routes/i);

    const mismatched = cloneReleases();
    mismatched[0] = {
      ...mismatched[0]!,
      routes: { ...mismatched[0]!.routes, en: "/privacy/" },
    };
    expect(() => validateLegalRegistry(mismatched)).toThrow(/English route/i);
  });

  it("rejects two active releases for one code", () => {
    const oldRelease: LegalDocumentRelease = {
      ...LEGAL_RELEASES[0]!,
      revision: "2026.07/01",
      effectiveDate: "2026-07-01",
      routes: { ru: "/legal/archive/privacy-2026-07/", en: "/en/legal/archive/privacy-2026-07/" },
    };
    expect(() => validateLegalRegistry([...LEGAL_RELEASES, oldRelease])).toThrow(
      /multiple active/i,
    );
  });

  it("rejects supersedes references that are unknown or not older", () => {
    const unknown = cloneReleases();
    unknown[0] = { ...unknown[0]!, supersedes: "MKR-PD-01/2025.01/01" };
    expect(() => validateLegalRegistry(unknown)).toThrow(/unknown supersedes/i);

    const newer: LegalDocumentRelease = {
      ...LEGAL_RELEASES[0]!,
      revision: "2026.09/01",
      effectiveDate: "2026-09-01",
      status: "superseded",
      routes: { ru: "/legal/archive/privacy-2026-09/", en: "/en/legal/archive/privacy-2026-09/" },
    };
    const current = cloneReleases();
    current[0] = { ...current[0]!, supersedes: "MKR-PD-01/2026.09/01" };
    expect(() => validateLegalRegistry([...current, newer])).toThrow(/older release/i);
  });

  it("rejects an active consent release inconsistent with the shared identifier", () => {
    const releases = cloneReleases();
    releases[1] = { ...releases[1]!, revision: "2026.08/02" };
    expect(() => validateLegalRegistry(releases)).toThrow(/consent identifier/i);
  });
});
