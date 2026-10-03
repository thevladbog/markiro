import { ThemeProvider } from "@markiro/ui";
import { buildUsPlanSnapshot } from "@markiro/domain";
import type { UsPlanDetailResponse, UsPlanListResponse } from "@markiro/platform-contracts";
import { render, type RenderResult } from "@testing-library/react";
import i18next, { type i18n as I18nInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { createUsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";

export const profile = {
  code: "US_FSMA204_PROCESSOR" as const,
  timeZone: "America/Los_Angeles",
  retentionYears: 7,
  baselineVersion: "US-REG-2026-09-03",
  effectiveAt: "2026-09-05T00:00:00Z",
};
export const id = "11111111-1111-4111-8111-111111111111";
export const actor = "22222222-2222-4222-8222-222222222222";
export const sections = {
  recordMaintenance: {
    systemOfRecord: "Frozen system",
    formats: ["PDF"],
    recordLocations: ["Archive"],
    responsibleRoles: ["QA"],
    backupAndRecovery: "Operator backup statement",
    narrative: ["Frozen procedure"],
  },
  ftlIdentification: { procedure: "Manual identification", reviewCadence: "When changed" },
  tlcAssignment: { procedure: "Assign at processing" },
  pointOfContact: {
    name: "Contact person",
    title: "Contact title",
    phone: "+1 555 0100",
    email: null,
  },
  farmActivity: { status: "no" as const, explanation: "No growing" },
  reviewAndUpdate: { procedure: "Review on change" },
};
export const published: Extract<UsPlanDetailResponse, { status: "effective" | "superseded" }> = {
  id,
  versionNumber: 2,
  status: "effective",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  provenance: "trusted_synthetic",
  approvedAt: "2026-10-02T00:00:00Z",
  supersededAt: null,
  retainThrough: null,
  artifact: { sha256: "a".repeat(64), byteSize: 1200, rendererVersion: "1" },
  schemaVersion: 1,
  createdBy: actor,
  approvedBy: actor,
  changeSummary: "Updated frozen procedures",
  snapshot: buildUsPlanSnapshot(
    {
      tenantName: "Frozen tenant",
      profileCode: profile.code,
      baselineVersion: profile.baselineVersion,
      timeZone: profile.timeZone,
      retentionYears: 5,
      tlcSourceLocations: [],
      productProfiles: [],
    },
    sections,
    "trusted_synthetic",
  ),
  factSources: {
    schemaVersion: 1,
    entries: [
      { path: "/configured/tenantName", source: { origin: "configured" } },
      {
        path: "/sections/recordMaintenance/systemOfRecord",
        source: {
          origin: "operator_confirmed",
          actorId: actor,
          confirmedAt: "2026-10-02T00:00:00Z",
        },
      },
    ],
  },
  confirmations: {
    procedures: { origin: "synthetic_fixture" },
    backupAndRecovery: { origin: "synthetic_fixture" },
    contact: { origin: "synthetic_fixture" },
    nonFarmScope: { origin: "synthetic_fixture" },
  },
  comparisonAgainstCurrentConfiguredFacts: {
    changedSections: ["productProfiles"],
    changedLocationIds: [],
    changedProductIds: [actor],
  },
  retentionIndefiniteReason: null,
};
export const draft: UsPlanDetailResponse = {
  id: actor,
  versionNumber: 3,
  status: "draft",
  draftRevision: 1,
  schemaVersion: 1,
  sections,
  changeSummary: "Next version",
  createdBy: actor,
  createdAt: published.createdAt,
  updatedAt: published.updatedAt,
  provenance: "trusted_synthetic",
  statementOwnership: "operator_pending",
};
export const list: UsPlanListResponse = {
  items: [
    {
      id,
      versionNumber: 2,
      status: "effective",
      createdAt: published.createdAt,
      updatedAt: published.updatedAt,
      provenance: "trusted_synthetic",
      approvedAt: published.approvedAt,
      supersededAt: null,
      retainThrough: null,
      artifact: published.artifact,
    },
    {
      id: actor,
      versionNumber: 3,
      status: "draft",
      draftRevision: 1,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      provenance: "trusted_synthetic",
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      versionNumber: 1,
      status: "superseded",
      createdAt: published.createdAt,
      updatedAt: published.updatedAt,
      provenance: "operational",
      approvedAt: published.approvedAt,
      supersededAt: published.approvedAt,
      retainThrough: "2031-10-01",
      artifact: published.artifact,
    },
  ],
  effectiveImpact: {
    changedSections: ["tlcSourceLocations"],
    changedLocationIds: [id],
    changedProductIds: [],
  },
  publicationAvailability: "artifact_storage_unconfigured",
};
export function clientFixture(capabilities = ["traceability.read"]) {
  const send = vi.fn<typeof fetch>(async (path) => {
    const url = String(path);
    if (url.endsWith("/access")) return Response.json({ capabilities });
    if (url.endsWith("/plans")) return Response.json(list);
    if (url.endsWith(`/plans/${id}`)) return Response.json(published);
    if (url.endsWith(`/plans/${actor}`)) return Response.json(draft);
    return Response.json({ items: [], limit: 50, offset: 0 });
  });
  return { client: createUsBrowserClient(send), send };
}
export function renderPlanUi(
  node: ReactNode,
  locale = "en-US",
): RenderResult & { instance: I18nInstance } {
  const instance = i18next.createInstance();
  void instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: locale,
    fallbackLng: "en-US",
    initAsync: false,
  });
  return {
    ...render(
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>{node}</I18nextProvider>
      </ThemeProvider>,
    ),
    instance,
  };
}
