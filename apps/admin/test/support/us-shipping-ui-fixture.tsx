import { webcrypto } from "node:crypto";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import type {
  ShippingDraft,
  ShippingHistoricalRecord,
  ShippingReadiness,
  ShippingBalanceResponse,
} from "@markiro/platform-contracts";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { vi } from "vitest";
import { createUsBrowserClient } from "../../src/us/client.js";
import { masterDataCopy } from "../../src/us/master-data/copy.js";
import { ShippingRecordView } from "../../src/us/shipping/editor.js";

export const shippingId = "c0000000-0000-4000-8000-000000000001";
export const revisionId = "c0000000-0000-4000-8000-000000000002";
export const lotId = "c0000000-0000-4000-8000-000000000003";
export const alternateLotId = "c0000000-0000-4000-8000-000000000013";
export const productId = "c0000000-0000-4000-8000-000000000004";
export const shipFromId = "c0000000-0000-4000-8000-000000000005";
export const recipientId = "c0000000-0000-4000-8000-000000000006";
export const bolId = "c0000000-0000-4000-8000-000000000007";
export const invoiceId = "c0000000-0000-4000-8000-000000000008";
export const partyId = "c0000000-0000-4000-8000-000000000009";
const stamp = "2026-09-27T15:00:00.000Z";

export const completeDraft: ShippingDraft = {
  eventDate: "2026-09-27",
  shipFromLocationId: shipFromId,
  recipientLocationId: recipientId,
  carrierReference: null,
  notes: null,
  items: [{ lotId, quantity: "100", unitOfMeasure: "case" }],
  documentIds: [bolId, invoiceId],
};
export const emptyDraft: ShippingDraft = {
  eventDate: null,
  shipFromLocationId: null,
  recipientLocationId: null,
  carrierReference: null,
  notes: null,
  items: [],
  documentIds: [],
};
const lifecycle = {
  rootId: shippingId,
  lifecycleVersion: 1,
  currentEventId: null,
  pendingDraftId: shippingId,
  previousRevisionId: null,
  amendmentReason: null,
  supersededByEventId: null,
  supersededAt: null,
  supersededBy: null,
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
};
export function draftRecord(draft: ShippingDraft = emptyDraft, draftVersion = 1) {
  return {
    id: shippingId,
    eventNumber: "SHP-26-0001",
    revision: 1,
    draftVersion,
    timeZone: "America/Chicago",
    createdBy: "operator",
    updatedBy: "operator",
    createdAt: stamp,
    updatedAt: stamp,
    status: "draft" as const,
    lifecycle,
    draft,
  };
}

function locationSnapshot(locationId: string, businessName: string, streetAddress: string) {
  return {
    schemaVersion: 1 as const,
    locationId,
    partyId,
    businessName,
    phoneNumber: "+1 503 555 0120",
    address: { kind: "street" as const, streetAddress },
    city: "Portland",
    stateOrRegion: "OR",
    zipOrPostalCode: "97203",
    countryCode: "US",
    countryDisplay: "United States",
  };
}
export function finalizedRecord(): ShippingHistoricalRecord {
  return {
    ...draftRecord(completeDraft),
    status: "finalized",
    lifecycle: {
      ...lifecycle,
      lifecycleVersion: 2,
      currentEventId: shippingId,
      pendingDraftId: null,
    },
    snapshot: {
      snapshotVersion: 1,
      eventId: shippingId,
      eventNumber: "SHP-26-0001",
      revision: 1,
      eventDate: "2026-09-27",
      timeZone: "America/Chicago",
      shipFrom: locationSnapshot(shipFromId, "North River Fresh Foods", "500 Example River Pkwy"),
      recipient: locationSnapshot(recipientId, "Harbor Market", "200 Example Harbor Ave"),
      carrierReference: null,
      notes: null,
      items: [
        {
          lineNo: 1,
          lotId,
          quantity: "100",
          unitOfMeasure: "case",
          tlc: "NRF-260915-APL01",
          source: {
            kind: "location",
            location: locationSnapshot(
              shipFromId,
              "North River Fresh Foods",
              "500 Example River Pkwy",
            ),
          },
          product: {
            id: productId,
            description: {
              snapshotVersion: 1,
              sourceProductId: productId,
              productName: "Fresh-cut apples",
              brandName: "North River",
              commodity: "Fruit",
              variety: "Honeycrisp",
              packagingSize: { value: "1", uom: "case" },
              packagingStyle: "Sealed case",
              gtin: null,
            },
            coverage: {
              coverageStatus: "covered",
              coverageRationale: "Synthetic reviewed product",
              ftlCategory: "Fresh-cut fruits",
              ftlSourceUrl: null,
              ftlSourceVersion: null,
              reviewedBy: "qa",
              reviewedAt: stamp,
            },
          },
        },
      ],
      documents: [
        { id: bolId, type: "bol", number: "BOL-0916-H", issuer: null },
        { id: invoiceId, type: "invoice", number: "INV-2026-0916-047", issuer: null },
      ],
      finalizedBy: "qa",
      finalizedAt: stamp,
    },
  };
}

const lot = {
  id: lotId,
  productId,
  tlc: "NRF-260915-APL01",
  source: { kind: "location", locationId: shipFromId },
  assignmentBasis: "transformation",
  sourceLockedAt: stamp,
  status: "active",
  revision: 1,
  createdBy: "qa",
  updatedBy: "qa",
  createdAt: stamp,
  updatedAt: stamp,
};
function location(id: string, name: string, role: "ship_from" | "recipient") {
  return {
    id,
    partyId,
    name,
    businessName: name,
    phoneNumber: "+1 503 555 0120",
    addressKind: "street",
    streetAddress: "500 Example River Pkwy",
    latitude: null,
    longitude: null,
    city: "Portland",
    stateOrRegion: "OR",
    zipOrPostalCode: "97203",
    countryCode: "US",
    roles: [role],
    archived: false,
    createdAt: stamp,
    updatedAt: stamp,
    descriptionStatus: { exportReady: true, issues: [] },
  };
}
function document(id: string, type: "bol" | "invoice", number: string) {
  return {
    id,
    type,
    typeOtherLabel: null,
    number,
    partyId: null,
    issuedOn: null,
    notes: null,
    archivedAt: null,
    createdBy: "operator",
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export async function renderShipping(
  options: {
    eventId?: string | null;
    initial?: ShippingHistoricalRecord;
    locale?: "en-US" | "es-US";
    canShip?: boolean;
    canManageQa?: boolean;
    readiness?: ShippingReadiness;
    readBalance?: (url: string) => Promise<Response>;
    extraLot?: boolean;
  } = {},
): Promise<{
  user: ReturnType<typeof userEvent.setup>;
  requestBodies: { path: string; method: string; body: unknown }[];
  requestedPaths: string[];
}> {
  vi.stubGlobal("crypto", webcrypto);
  let current: ShippingHistoricalRecord = options.initial ?? draftRecord();
  const records = new Map([
    [shippingId, finalizedRecord()],
    [current.id, current],
  ]);
  const requestBodies: { path: string; method: string; body: unknown }[] = [];
  const requestedPaths: string[] = [];
  const send = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    requestedPaths.push(url);
    const method = init?.method ?? "GET";
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    if (body) requestBodies.push({ path: url, method, body });
    if (url.includes("/traceability/lots?"))
      return Response.json({
        items: options.extraLot ? [lot, { ...lot, id: alternateLotId, tlc: "ALT-LOT" }] : [lot],
        limit: 50,
        offset: 0,
      });
    if (url.endsWith(`/traceability/lots/${lotId}`)) return Response.json(lot);
    if (
      url.includes(`/traceability/lots/${lotId}/shipping-balance`) ||
      url.includes(`/traceability/lots/${alternateLotId}/shipping-balance`)
    )
      return options.readBalance
        ? options.readBalance(url)
        : Response.json({
            lotId,
            originUom: "case",
            balance: {
              state: "known",
              unitOfMeasure: "case",
              supply: "100",
              used: "20",
              remaining: "80",
            },
          } satisfies ShippingBalanceResponse);
    if (url.includes("/traceability/locations?")) {
      const role = new URL(url, "https://office.test").searchParams.get("roles");
      const rows =
        role === "ship_from"
          ? [location(shipFromId, "North River Fresh Foods", "ship_from")]
          : role === "recipient"
            ? [location(recipientId, "Harbor Market", "recipient")]
            : [
                location(shipFromId, "North River Fresh Foods", "ship_from"),
                location(recipientId, "Harbor Market", "recipient"),
              ];
      return Response.json({ items: rows, limit: 50, offset: 0 });
    }
    if (url.endsWith(`/traceability/locations/${shipFromId}`))
      return Response.json(location(shipFromId, "North River Fresh Foods", "ship_from"));
    if (url.endsWith(`/traceability/locations/${recipientId}`))
      return Response.json(location(recipientId, "Harbor Market", "recipient"));
    if (url.includes("/traceability/reference-documents?"))
      return Response.json({
        items: [
          document(bolId, "bol", "BOL-0916-H"),
          document(invoiceId, "invoice", "INV-2026-0916-047"),
        ],
        limit: 50,
        offset: 0,
      });
    if (url.endsWith(`/traceability/reference-documents/${bolId}`))
      return Response.json(document(bolId, "bol", "BOL-0916-H"));
    if (url.endsWith(`/traceability/reference-documents/${invoiceId}`))
      return Response.json(document(invoiceId, "invoice", "INV-2026-0916-047"));
    if (url.includes("/shipments/") && url.includes("/revisions?")) {
      const query = new URL(url, "https://office.test").searchParams;
      return Response.json({
        items: [
          {
            id: shippingId,
            rootId: shippingId,
            eventNumber: "SHP-26-0001",
            revision: 1,
            status: "finalized",
            timeZone: "America/Chicago",
            lifecycleVersion: current.lifecycle?.lifecycleVersion ?? 2,
            currentEventId: current.lifecycle?.currentEventId ?? shippingId,
            pendingDraftId: current.lifecycle?.pendingDraftId ?? null,
            previousRevisionId: null,
            amendmentReason: null,
            voidReason: null,
          },
          ...(current.id === revisionId
            ? [
                {
                  id: revisionId,
                  rootId: shippingId,
                  eventNumber: "SHP-26-0001",
                  revision: 2,
                  status: current.status,
                  timeZone: "America/Chicago",
                  lifecycleVersion: current.lifecycle?.lifecycleVersion ?? 3,
                  currentEventId: current.lifecycle?.currentEventId ?? shippingId,
                  pendingDraftId: current.lifecycle?.pendingDraftId ?? null,
                  previousRevisionId: shippingId,
                  amendmentReason: "Correct quantity",
                  voidReason: null,
                },
              ]
            : []),
        ],
        limit: Number(query.get("limit")),
        offset: Number(query.get("offset")),
        lifecycleVersion: current.lifecycle?.lifecycleVersion ?? 2,
      });
    }
    if (url.includes("/shipments/") && url.includes("/readiness?"))
      return Response.json(
        options.readiness ?? {
          eventId: current.id,
          expectedDraftVersion: current.draftVersion,
          ruleVersion: "shipping-readiness-v1",
          inputDigest: "a".repeat(64),
          state: "complete",
          profileCode: "US_FSMA204_PROCESSOR",
          issues: [],
        },
      );
    if (url.endsWith("/traceability/shipments") && method === "POST") {
      const payload = body as { draft: ShippingDraft };
      current = draftRecord(payload.draft);
      records.set(current.id, current);
      return Response.json(current);
    }
    if (url.endsWith(`/shipments/${current.id}`) && method === "PUT") {
      const payload = body as { draft: ShippingDraft };
      current = {
        ...current,
        draftVersion: current.draftVersion + 1,
        draft: payload.draft,
      } as ShippingHistoricalRecord;
      records.set(current.id, current);
      return Response.json(current);
    }
    if (url.endsWith(`/shipments/${current.id}/finalize`) && method === "POST") {
      current = finalizedRecord();
      records.set(current.id, current);
      return Response.json(current);
    }
    if (url.endsWith(`/shipments/${current.id}/amend`) && method === "POST") {
      const payload = body as { operationKey: string; reason: string };
      current = {
        ...draftRecord(completeDraft),
        id: revisionId,
        revision: 2,
        lifecycle: {
          ...lifecycle,
          lifecycleVersion: 3,
          currentEventId: shippingId,
          pendingDraftId: revisionId,
          previousRevisionId: shippingId,
          amendmentReason: payload.reason,
        },
      };
      records.set(current.id, current);
      return Response.json({
        receiptVersion: 1,
        command: "shipping.amend",
        operationKey: payload.operationKey,
        inputDigest: "b".repeat(64),
        eventId: revisionId,
        record: current,
      });
    }
    if (url.endsWith(`/shipments/${current.id}/void`) && method === "POST") {
      const payload = body as { operationKey: string; reason: string };
      const pending = current.status === "draft" && current.revision > 1;
      current = pending
        ? {
            ...current,
            status: "void",
            lifecycle: {
              ...lifecycle,
              ...current.lifecycle,
              lifecycleVersion: 4,
              pendingDraftId: null,
              voidedAt: stamp,
              voidedBy: "qa",
              voidReason: payload.reason,
            },
          }
        : {
            ...finalizedRecord(),
            status: "void",
            lifecycle: {
              ...lifecycle,
              lifecycleVersion: 3,
              currentEventId: null,
              pendingDraftId: null,
              voidedAt: stamp,
              voidedBy: "qa",
              voidReason: payload.reason,
            },
          };
      records.set(current.id, current);
      if (pending) {
        const predecessor = finalizedRecord();
        records.set(shippingId, {
          ...predecessor,
          lifecycle: {
            ...lifecycle,
            ...predecessor.lifecycle,
            lifecycleVersion: 4,
            currentEventId: shippingId,
            pendingDraftId: null,
          },
        });
      }
      return Response.json({
        receiptVersion: 1,
        command: "shipping.void",
        operationKey: payload.operationKey,
        inputDigest: "c".repeat(64),
        eventId: current.id,
        record: current,
      });
    }
    if (url.includes("/traceability/shipments/") && method === "GET") {
      const id = url.split("/").at(-1) ?? "";
      return Response.json(records.get(id) ?? current);
    }
    return Response.json({}, { status: 503 });
  });
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
  const onDirtyChange = vi.fn();
  const onClose = vi.fn();
  const onForbidden = vi.fn(async () => undefined);
  const onSessionLost = vi.fn();
  render(
    <ThemeProvider defaultTheme="light">
      <I18nextProvider i18n={instance}>
        <ShippingRecordView
          client={createUsBrowserClient(send)}
          eventId={options.eventId === undefined ? shippingId : options.eventId}
          timeZone="America/Chicago"
          canShip={options.canShip ?? true}
          canManageQa={options.canManageQa ?? false}
          mutationPending={false}
          beginMutation={() => () => undefined}
          onDirtyChange={onDirtyChange}
          onForbidden={onForbidden}
          onSessionLost={onSessionLost}
          onClose={onClose}
        />
      </I18nextProvider>
    </ThemeProvider>,
  );
  return { user: userEvent.setup(), requestBodies, requestedPaths };
}
