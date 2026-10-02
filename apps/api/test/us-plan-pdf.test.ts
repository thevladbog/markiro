import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUsPlanApprovedEvidence,
  buildUsPlanDraftFactSources,
  buildUsPlanSnapshot,
  type UsPlanConfiguredFacts,
  type UsPlanSections,
} from "@markiro/domain";
import { describe, expect, it } from "vitest";
import {
  renderUsPlanDraftPreview,
  renderUsPlanPdf,
  US_PLAN_PDF_RENDERER_VERSION,
} from "../src/modules/traceability/plans/us-plan-pdf";

const approvedAt = "2026-10-02T10:00:00.000Z";
const facts: UsPlanConfiguredFacts = {
  tenantName: "Example Foods LLC",
  profileCode: "US_FSMA204_PROCESSOR",
  baselineVersion: "fsma204-v1",
  timeZone: "America/Chicago",
  retentionYears: 5,
  tlcSourceLocations: [
    {
      id: "location-1",
      description: {
        partyId: "party-1",
        businessName: "Example Foods Receiving",
        phoneNumber: "+1 312 555 0123",
        addressKind: "street",
        streetAddress: "100 Sample Street",
        latitude: null,
        longitude: null,
        city: "Chicago",
        stateOrRegion: "IL",
        zipOrPostalCode: "60601",
        countryCode: "US",
      },
    },
  ],
  productProfiles: [{ productId: "product-1", revision: 4, coverageStatus: "covered" }],
};
const sections: UsPlanSections = {
  recordMaintenance: {
    systemOfRecord: "Bound receiving register",
    formats: ["PDF", "CSV"],
    recordLocations: ["Restricted QA cabinet"],
    responsibleRoles: ["QA manager"],
    backupAndRecovery: "The operator reports a nightly encrypted backup.",
    narrative: ["Paper corrections are initialed and dated."],
  },
  ftlIdentification: {
    procedure: "QA reviews each product profile against the current FTL.",
    reviewCadence: "On product onboarding or a material change.",
  },
  tlcAssignment: { procedure: "Assign the TLC at the receiving location before processing." },
  pointOfContact: {
    name: "Alex Example",
    title: "QA manager",
    phone: "+1 312 555 0100",
    email: "alex@example.test",
  },
  farmActivity: {
    status: "no",
    explanation: "The processor reports no farming or raising of FTL food.",
  },
  reviewAndUpdate: {
    procedure: "QA updates this plan when operating procedures change.",
  },
};

function model(synthetic = false, configuredFacts = facts, planSections = sections) {
  const snapshot = buildUsPlanSnapshot(
    configuredFacts,
    planSections,
    synthetic ? "trusted_synthetic" : "operational",
  );
  const factSources = buildUsPlanDraftFactSources(configuredFacts, planSections);
  const evidence = buildUsPlanApprovedEvidence(snapshot, factSources, {
    kind: synthetic ? "synthetic" : "operational",
    actorId: "actor-1",
    confirmedAt: approvedAt,
    confirmations: {
      procedures: true,
      backupAndRecovery: true,
      contact: true,
      nonFarmScope: true,
    },
    ...(synthetic
      ? { trustedSeed: { seedId: "seed-1", verifiedBy: "server", verifiedAt: approvedAt } }
      : {}),
  });
  return {
    versionNumber: 2,
    approvedBy: "actor-1",
    approvedAt,
    changeSummary: "Receiving location and contact revised.",
    evidence,
  };
}

function extractedPages(bytes: Buffer): string[] {
  const directory = mkdtempSync(join(tmpdir(), "us-plan-pdf-test-"));
  try {
    const path = join(directory, "plan.pdf");
    writeFileSync(path, bytes);
    return execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" })
      .split("\f")
      .filter((page) => page.trim().length > 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("US plan PDF", () => {
  it("renders identical English bytes and hash from the same frozen evidence", async () => {
    const input = model();
    const first = await renderUsPlanPdf(input);
    const spanishUiContext = { ...input, uiLocale: "es-US" };
    const second = await renderUsPlanPdf(spanishUiContext);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.sha256).toBe(second.sha256);
    expect(first.byteSize).toBe(first.bytes.length);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.rendererVersion).toBe(US_PLAN_PDF_RENDERER_VERSION);
    expect(first.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const text = extractedPages(first.bytes).join("\n").replace(/\s+/gu, " ");
    expect(text).toContain("Traceability plan");
    expect(text).toContain("Version: 2");
    expect(text).toContain("Effective date: 2026-10-02 (America/Chicago)");
    expect(text).toContain("Approved by: actor-1");
    expect(text).toContain("Bound receiving register");
    expect(text).toContain("Example Foods Receiving");
    expect(text).toMatch(
      /Frozen TLC-source locations \(configured source\) • Example Foods Receiving/u,
    );
    expect(text).toContain("100 Sample Street");
    expect(text).toContain("Location phone: +1 312 555 0123");
    expect(text).toContain("Party: party-1");
    expect(text).toContain("Chicago, IL, 60601, US");
    expect(text).toContain("product-1");
    expect(text).toContain("Alex Example");
    expect(text).toContain("The processor reports no farming");
    expect(text).toContain("Receiving location and contact revised.");
    expect(text).toContain("configured");
    expect(text).toContain("operator confirmed by actor-1 at 2026-10-02T10:00:00.000Z");
    expect(text).toContain("application policy v1");
    expect(text).toContain(
      "Retention policy requires previous versions for at least two years after update",
    );
    expect(text).not.toContain("Previous versions are retained");
    expect(text).toContain("does not independently verify");
    expect(text).not.toContain("Synthetic demo");
    expect(text).not.toContain("DRAFT");
  });

  it("marks each page of a multi-page synthetic PDF", async () => {
    const input = model(true, facts, {
      ...sections,
      recordMaintenance: {
        ...sections.recordMaintenance,
        narrative: Array.from(
          { length: 35 },
          (_, index) =>
            "Synthetic procedure " + (index + 1) + ": receiving staff preserve source records.",
        ),
      },
    });
    const result = await renderUsPlanPdf(input);
    const pages = extractedPages(result.bytes);
    expect(pages.length).toBeGreaterThan(1);
    for (const [index, page] of pages.entries()) {
      expect(page).toContain("Synthetic demo — not an operational record");
      expect(page).toContain("Page " + (index + 1) + " of " + pages.length);
    }
    const contactPage = pages.find((page) => page.includes("4. Point of contact"));
    expect(contactPage).toContain("Email: alex@example.test");
  });

  it("renders draft preview bytes with a watermark and no published hash", async () => {
    const input = model(true);
    const preview = await renderUsPlanDraftPreview({
      versionNumber: input.versionNumber,
      changeSummary: input.changeSummary,
      snapshot: input.evidence.snapshot,
      factSources: buildUsPlanDraftFactSources(facts, sections),
    });
    const pages = extractedPages(preview);
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(page).toContain("DRAFT — not effective");
      expect(page).toContain("Synthetic demo — not an operational record");
    }
    expect(pages.join("\n")).not.toContain("Approved by:");
  });

  it("refuses a farm-scope claim that the processor PDF cannot support", async () => {
    const input = model();
    input.evidence.snapshot.sections.farmActivity.status = "yes";
    await expect(renderUsPlanPdf(input)).rejects.toThrow("us_plan_pdf_input_invalid");
  });

  it("refuses missing published provenance rather than printing an unknown source", async () => {
    const input = model();
    input.evidence.factSources.entries = input.evidence.factSources.entries.filter(
      (entry) => entry.path !== "/sections/pointOfContact/name",
    );
    await expect(renderUsPlanPdf(input)).rejects.toThrow("us_plan_pdf_input_invalid");
  });

  it("refuses a missing provenance path for a listed narrative item", async () => {
    const input = model();
    input.evidence.factSources.entries = input.evidence.factSources.entries.filter(
      (entry) => entry.path !== "/sections/recordMaintenance/narrative/0",
    );
    await expect(renderUsPlanPdf(input)).rejects.toThrow("us_plan_pdf_input_invalid");
  });

  it("refuses synthetic provenance on an unmarked operational PDF", async () => {
    const input = model();
    const source = input.evidence.factSources.entries.find(
      (entry) => entry.path === "/sections/pointOfContact/name",
    );
    if (!source) throw new Error("fixture_missing_source");
    source.source = {
      origin: "synthetic_fixture",
      trustedSeed: { seedId: "seed-1", verifiedBy: "server", verifiedAt: approvedAt },
    };
    await expect(renderUsPlanPdf(input)).rejects.toThrow("us_plan_pdf_input_invalid");
  });

  it("refuses a source actor or time that contradicts the approval", async () => {
    for (const sourceChange of [
      { actorId: "different-actor", confirmedAt: approvedAt },
      { actorId: "actor-1", confirmedAt: "2026-10-02T11:00:00.000Z" },
    ]) {
      const input = model();
      const entry = input.evidence.factSources.entries.find(
        ({ path }) => path === "/sections/pointOfContact/name",
      );
      if (!entry) throw new Error("fixture_missing_source");
      entry.source = { origin: "operator_confirmed", ...sourceChange };
      await expect(renderUsPlanPdf(input)).rejects.toThrow("us_plan_pdf_input_invalid");
    }
  });

  it("refuses an extra path or inconsistent synthetic trusted seed", async () => {
    const extra = model();
    extra.evidence.factSources.entries.push({
      path: "/sections/invented",
      source: { origin: "configured" },
    });
    await expect(renderUsPlanPdf(extra)).rejects.toThrow("us_plan_pdf_input_invalid");

    const synthetic = model(true);
    const entry = synthetic.evidence.factSources.entries.find(
      ({ path }) => path === "/sections/pointOfContact/name",
    );
    if (!entry) throw new Error("fixture_missing_source");
    entry.source = {
      origin: "synthetic_fixture",
      trustedSeed: { seedId: "other-seed", verifiedBy: "server", verifiedAt: approvedAt },
    };
    await expect(renderUsPlanPdf(synthetic)).rejects.toThrow("us_plan_pdf_input_invalid");

    const confirmation = model(true);
    confirmation.evidence.confirmations.contact = {
      origin: "synthetic_fixture",
      trustedSeed: { seedId: "other-seed", verifiedBy: "server", verifiedAt: approvedAt },
    };
    await expect(renderUsPlanPdf(confirmation)).rejects.toThrow("us_plan_pdf_input_invalid");

    const operationalConfirmation = model();
    operationalConfirmation.evidence.confirmations.contact = {
      origin: "operator_confirmed",
      actorId: "actor-1",
      confirmedAt: "2026-10-02T11:00:00.000Z",
    };
    await expect(renderUsPlanPdf(operationalConfirmation)).rejects.toThrow(
      "us_plan_pdf_input_invalid",
    );
  });

  it("refuses a timezone-less approval instant", async () => {
    const input = model();
    input.approvedAt = "2026-10-02T10:00:00";
    await expect(renderUsPlanPdf(input)).rejects.toThrow("us_plan_pdf_input_invalid");
  });

  it("omits a null TLC location phone without printing a placeholder", async () => {
    const withoutPhone: UsPlanConfiguredFacts = {
      ...facts,
      tlcSourceLocations: facts.tlcSourceLocations.map((location) => ({
        ...location,
        description: { ...location.description, phoneNumber: null },
      })),
    };
    const text = extractedPages((await renderUsPlanPdf(model(false, withoutPhone))).bytes).join(
      " ",
    );
    expect(text).toContain("100 Sample Street");
    expect(text).not.toContain("Location phone:");
    expect(text).not.toContain("null");
  });

  it("prints the frozen coordinate address rather than an absent street address", async () => {
    const coordinates: UsPlanConfiguredFacts = {
      ...facts,
      tlcSourceLocations: facts.tlcSourceLocations.map((location) => ({
        ...location,
        description: {
          ...location.description,
          addressKind: "coordinates" as const,
          streetAddress: null,
          latitude: "41.881832",
          longitude: "-87.623177",
        },
      })),
    };
    const text = extractedPages((await renderUsPlanPdf(model(false, coordinates))).bytes)
      .join(" ")
      .replace(/\s+/gu, " ");
    expect(text).toContain("Coordinates: 41.881832, -87.623177");
    expect(text).not.toContain("100 Sample Street");
    expect(text).not.toContain("null");
  });

  it("fails before layout for oversized text and arrays", async () => {
    const oversizedText = model();
    oversizedText.evidence.snapshot.sections.recordMaintenance.systemOfRecord = "x".repeat(4097);
    await expect(renderUsPlanPdf(oversizedText)).rejects.toThrow("us_plan_pdf_input_limit");
    const oversizedArray = model();
    oversizedArray.evidence.snapshot.sections.recordMaintenance.narrative = Array.from(
      { length: 51 },
      () => "entry",
    );
    await expect(renderUsPlanPdf(oversizedArray)).rejects.toThrow("us_plan_pdf_input_limit");
  });

  it("accepts a normal provenance manifest with more than 80 facts", async () => {
    const configuredFacts: UsPlanConfiguredFacts = {
      ...facts,
      productProfiles: Array.from({ length: 25 }, (_, index) => ({
        productId: "product-" + String(index + 1).padStart(2, "0"),
        revision: 1,
        coverageStatus: "covered",
      })),
    };
    const result = await renderUsPlanPdf(model(false, configuredFacts));
    expect(extractedPages(result.bytes).join("\n")).toContain("product-25");
  });
});
