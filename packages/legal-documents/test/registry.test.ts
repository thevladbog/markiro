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
      "MKR-INS-01",
      "MKR-INS-02",
      "MKR-INS-03",
      "MKR-INS-04",
      "MKR-INS-05",
      "MKR-INS-06",
      "MKR-INS-07",
      "MKR-INS-08",
      "MKR-INS-09",
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
    // Every code is still on its first revision except the reissued ones:
    // MKR-INS-04 (2026.08/02: the setup screen was rebuilt around on-screen
    // scanner and print checks), MKR-INS-06 (2026.08/03: regenerated so the
    // published PDF embeds exactly the committed screenshots -- the 02 PDF
    // carried a few antialiased pixels from a different capture run) and
    // MKR-INS-07 (2026.08/03: the corrections page was rebuilt around
    // scan-event tabs and bulk selection, and voided scans stopped blocking
    // safe close).
    const reissuedRevision: Record<string, string> = {
      // 2026-09-02: the station instruction set (01/02/03/05) was reissued in
      // one sweep -- the floor header collapsed into status dots, the work
      // screen got its product hero, and the demo product image was redrawn.
      "MKR-INS-01": "2026.09/01",
      "MKR-INS-02": "2026.09/01",
      "MKR-INS-03": "2026.09/01",
      "MKR-INS-04": "2026.08/02",
      "MKR-INS-05": "2026.09/01",
      "MKR-INS-06": "2026.08/03",
      "MKR-INS-07": "2026.08/03",
      // Not a reissue: MKR-INS-09 simply FIRST shipped in the September series.
      "MKR-INS-09": "2026.09/01",
    };
    expect(
      LEGAL_RELEASES.every(
        ({ code, revision }) => revision === (reissuedRevision[code] ?? "2026.08/01"),
      ),
    ).toBe(true);
    expect(
      LEGAL_RELEASES.filter(
        ({ code }) =>
          code !== "MKR-INS-01" &&
          code !== "MKR-INS-02" &&
          code !== "MKR-INS-03" &&
          code !== "MKR-INS-04" &&
          code !== "MKR-INS-05" &&
          code !== "MKR-INS-06" &&
          code !== "MKR-INS-07" &&
          code !== "MKR-INS-08" &&
          code !== "MKR-INS-09",
      ).every(({ effectiveDate }) => effectiveDate === "2026-08-15"),
    ).toBe(true);
    expect(findLegalRelease("MKR-INS-01").effectiveDate).toBe("2026-09-02");
    expect(findLegalRelease("MKR-INS-02").effectiveDate).toBe("2026-09-02");
    expect(findLegalRelease("MKR-INS-03").effectiveDate).toBe("2026-09-02");
    expect(findLegalRelease("MKR-INS-04").effectiveDate).toBe("2026-09-01");
    expect(findLegalRelease("MKR-INS-05").effectiveDate).toBe("2026-09-02");
    expect(findLegalRelease("MKR-INS-06").effectiveDate).toBe("2026-09-01");
    expect(findLegalRelease("MKR-INS-07").effectiveDate).toBe("2026-09-01");
    expect(findLegalRelease("MKR-INS-08").effectiveDate).toBe("2026-08-30");
    expect(findLegalRelease("MKR-INS-09").effectiveDate).toBe("2026-09-02");
    expect(new Set(LEGAL_RELEASES.flatMap(({ routes }) => Object.values(routes))).size).toBe(17);
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
    expect(() => validateLegalRegistry(missing)).toThrow(/must define routes exactly for/i);

    const mismatched = cloneReleases();
    mismatched[0] = {
      ...mismatched[0]!,
      routes: { ...mismatched[0]!.routes, en: "/privacy/" },
    } as unknown as LegalDocumentRelease;
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

  it("classifies document kinds and release locales", async () => {
    const { legalDocumentKind, legalReleaseLocales } = await import("../src/index.js");
    expect(legalDocumentKind("MKR-PD-01")).toBe("legal");
    expect(legalDocumentKind("MKR-DPA-01")).toBe("template");
    expect(legalDocumentKind("MKR-INS-01")).toBe("instruction");
    expect(legalDocumentKind("MKR-INS-02")).toBe("instruction");
    expect(legalDocumentKind("MKR-INS-03")).toBe("instruction");
    expect(legalDocumentKind("MKR-INS-04")).toBe("instruction");
    expect(legalDocumentKind("MKR-INS-05")).toBe("instruction");
    expect(legalDocumentKind("MKR-INS-06")).toBe("instruction");
    expect(legalDocumentKind("MKR-INS-07")).toBe("instruction");
    expect(legalDocumentKind("MKR-INS-08")).toBe("instruction");
    expect(legalDocumentKind("MKR-INS-09")).toBe("instruction");
    expect(legalReleaseLocales("MKR-BRD-01")).toEqual(["ru", "en"]);
    expect(legalReleaseLocales("MKR-INS-01")).toEqual(["ru"]);
    expect(legalReleaseLocales("MKR-INS-02")).toEqual(["ru"]);
    expect(legalReleaseLocales("MKR-INS-03")).toEqual(["ru"]);
    expect(legalReleaseLocales("MKR-INS-04")).toEqual(["ru"]);
    expect(legalReleaseLocales("MKR-INS-05")).toEqual(["ru"]);
    expect(legalReleaseLocales("MKR-INS-06")).toEqual(["ru"]);
    expect(legalReleaseLocales("MKR-INS-07")).toEqual(["ru"]);
    expect(legalReleaseLocales("MKR-INS-08")).toEqual(["ru"]);
    expect(legalReleaseLocales("MKR-INS-09")).toEqual(["ru"]);
  });

  it("accepts a Russian-only instruction release and rejects Russian-only legal releases", () => {
    const instructionRelease = {
      code: "MKR-INS-01",
      revision: "2026.08/02",
      effectiveDate: "2026-08-22",
      status: "draft",
      operatorProfileId: "operator-2026-08-15",
      routes: { ru: "/instruktsii/stantsiya-vkhod-i-start-smeny-chernovik/" },
    } as unknown as LegalDocumentRelease;
    expect(() => validateLegalRegistry([...cloneReleases(), instructionRelease])).not.toThrow();

    const ruOnlyLegal = cloneReleases();
    delete (ruOnlyLegal[0] as { routes: { en?: string } }).routes.en;
    expect(() => validateLegalRegistry(ruOnlyLegal)).toThrow(/must define routes exactly for/);

    const instructionWithEn = {
      ...instructionRelease,
      routes: {
        ru: "/instruktsii/stantsiya-vkhod-i-start-smeny-chernovik/",
        en: "/en/instructions/station-shift-start/",
      },
    } as unknown as LegalDocumentRelease;
    expect(() => validateLegalRegistry([...cloneReleases(), instructionWithEn])).toThrow(
      /must define routes exactly for/,
    );
  });
});
