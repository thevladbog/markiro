import { webcrypto } from "node:crypto";
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import { TRANSFORMATION_READINESS_RULE_VERSION } from "@markiro/domain";
import type { TransformationDraft } from "@markiro/platform-contracts";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { vi, type Mock } from "vitest";
import { createUsBrowserClient } from "../../src/us/client.js";
import { masterDataCopy } from "../../src/us/master-data/copy.js";
import { TransformationRecordView } from "../../src/us/transformation/editor.js";

export const transformationId = "b0000000-0000-4000-8000-000000000001";
export const revisionId = "b0000000-0000-4000-8000-000000000007";
export const lotId = "b0000000-0000-4000-8000-000000000002";
export const productId = "b0000000-0000-4000-8000-000000000003";
export const locationId = "b0000000-0000-4000-8000-000000000004";
export const documentId = "b0000000-0000-4000-8000-000000000005";
export const stamp = "2026-09-27T00:00:00.000Z";
export const emptyTransformationDraft: TransformationDraft = {
  eventDate: null,
  processorLocationId: null,
  reason: null,
  reasonNote: null,
  notes: null,
  inputs: [],
  outputs: [],
  documentIds: [],
};
export function draftRecord(draft: TransformationDraft = emptyTransformationDraft, version = 1) {
  return {
    id: transformationId,
    eventNumber: "TRN-26-0001",
    revision: 1,
    draftVersion: version,
    status: "draft" as const,
    timeZone: "America/Chicago",
    createdBy: "operator",
    updatedBy: "operator",
    createdAt: stamp,
    updatedAt: stamp,
    lifecycle: {
      rootId: transformationId,
      lifecycleVersion: 1,
      currentEventId: null,
      pendingDraftId: transformationId,
      previousRevisionId: null,
      amendmentReason: null,
      supersededByEventId: null,
      supersededAt: null,
      supersededBy: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
    },
    draft,
  };
}
export const completeDraft: TransformationDraft = {
  eventDate: "2026-09-27",
  processorLocationId: locationId,
  reason: "repacking",
  reasonNote: null,
  notes: null,
  inputs: [{ kind: "ftl_lot", lotId, quantity: "2.5", unitOfMeasure: "kg" }],
  outputs: [{ productId, tlc: "OUT-2026-001", quantity: "2.5", unitOfMeasure: "kg" }],
  documentIds: [documentId],
};
export const completeReadiness = {
  eventId: transformationId,
  state: "complete",
  ruleVersion: TRANSFORMATION_READINESS_RULE_VERSION,
  expectedDraftVersion: 1,
  inputDigest: "a".repeat(64),
  issues: [],
};
export function revisionDraftRecord() {
  return {
    ...draftRecord(completeDraft),
    id: revisionId,
    revision: 2,
    lifecycle: {
      ...draftRecord().lifecycle,
      lifecycleVersion: 3,
      currentEventId: transformationId,
      pendingDraftId: revisionId,
      previousRevisionId: transformationId,
      amendmentReason: "Correct quantity",
    },
  };
}
export function finalizedRecord() {
  const coverage = {
    coverageStatus: "covered",
    coverageRationale: "Reviewed fresh-cut fruit",
    ftlCategory: "Fresh-cut fruits",
    ftlSourceUrl:
      "https://www.fda.gov/food/food-safety-modernization-act-fsma/food-traceability-list",
    ftlSourceVersion: "Synthetic 2026",
    reviewedBy: "qa",
    reviewedAt: stamp,
  };
  const product = { id: productId, description: "Fresh-cut fruit", coverage };
  const source = { kind: "location", id: locationId, description: "Processor" };
  return {
    id: transformationId,
    eventNumber: "TRN-26-0001",
    revision: 1,
    draftVersion: 1,
    status: "finalized",
    timeZone: "America/Chicago",
    createdBy: "operator",
    updatedBy: "qa",
    createdAt: stamp,
    updatedAt: stamp,
    finalizedAt: stamp,
    finalizedBy: "qa",
    lifecycle: {
      ...draftRecord().lifecycle,
      lifecycleVersion: 2,
      currentEventId: transformationId,
      pendingDraftId: null,
    },
    snapshot: {
      snapshotVersion: 1,
      eventId: transformationId,
      eventNumber: "TRN-26-0001",
      revision: 1,
      eventDate: "2026-09-27",
      timeZone: "America/Chicago",
      processor: { id: locationId, description: "Processor" },
      reason: "repacking",
      reasonNote: null,
      notes: null,
      inputs: [
        {
          kind: "ftl_lot",
          lineNo: 1,
          lotId,
          product,
          tlc: "IN-2026-001",
          source,
          quantity: "2.5",
          unitOfMeasure: "kg",
        },
      ],
      outputs: [
        {
          lineNo: 1,
          lotId: "b0000000-0000-4000-8000-000000000008",
          product,
          tlc: "OUT-2026-001",
          source,
          quantity: "2.5",
          unitOfMeasure: "kg",
        },
      ],
      documents: [{ id: documentId, type: "work_order", number: "WO-2026-1" }],
      finalizedBy: "qa",
      finalizedAt: stamp,
    },
  };
}

export async function renderTransformation(
  options: {
    eventId?: string | null;
    draft?: TransformationDraft;
    canTransform?: boolean;
    canManageQa?: boolean;
    mutationPending?: boolean;
    locale?: "en-US" | "es-US";
    send?: Mock<typeof fetch>;
  } = {},
): Promise<{
  user: ReturnType<typeof userEvent.setup>;
  send: Mock<typeof fetch>;
  view: (canTransform?: boolean, canManageQa?: boolean, mutationPending?: boolean) => ReactElement;
  rerender: ReturnType<typeof render>["rerender"];
  onDirtyChange: Mock<(dirty: boolean) => void>;
  onClose: Mock<() => void>;
  onOpenLot: Mock<(id: string) => void>;
}> {
  vi.stubGlobal("crypto", webcrypto);
  const record = draftRecord(options.draft);
  let current = record;
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (
      url === `/api/us/traceability/transformation/${transformationId}` &&
      (!init || init.method === "GET")
    )
      return Response.json(current);
    if (url === "/api/us/traceability/transformation" && init?.method === "POST") {
      const payload = JSON.parse(String(init.body)) as { draft: TransformationDraft };
      current = draftRecord(payload.draft);
      return Response.json(current);
    }
    if (
      url === `/api/us/traceability/transformation/${transformationId}` &&
      init?.method === "PUT"
    ) {
      const payload = JSON.parse(String(init.body)) as { draft: TransformationDraft };
      current = draftRecord(payload.draft, current.draftVersion + 1);
      return Response.json(current);
    }
    if (url.includes("/readiness?")) return Response.json(completeReadiness);
    if (
      url.includes("/traceability/lots?") ||
      url.includes("/traceability/products?") ||
      url.includes("/traceability/locations?") ||
      url.includes("/traceability/reference-documents?")
    )
      return Response.json({ items: [], limit: 50, offset: 0 });
    return Response.json({}, { status: 503 });
  });
  const transport = options.send ?? send;
  const instance = i18next.createInstance();
  await instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: options.locale ?? "en-US",
    fallbackLng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const client = createUsBrowserClient(transport);
  const base = {
    eventId: options.eventId === undefined ? transformationId : options.eventId,
    timeZone: "America/Chicago",
    client,
    mutationPending: false,
    beginMutation: () => () => undefined,
    onDirtyChange: vi.fn(),
    onForbidden: vi.fn(async () => undefined),
    onSessionLost: vi.fn(),
    onClose: vi.fn(),
    onOpenLot: vi.fn(),
  };
  function view(
    canTransform = options.canTransform ?? true,
    canManageQa = options.canManageQa ?? false,
    mutationPending = options.mutationPending ?? false,
  ) {
    return (
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          <TransformationRecordView
            {...base}
            mutationPending={mutationPending}
            canTransform={canTransform}
            canManageQa={canManageQa}
          />
        </I18nextProvider>
      </ThemeProvider>
    );
  }
  const result = render(view());
  return {
    user: userEvent.setup(),
    send: transport,
    view,
    rerender: result.rerender,
    onDirtyChange: base.onDirtyChange,
    onClose: base.onClose,
    onOpenLot: base.onOpenLot,
  };
}
