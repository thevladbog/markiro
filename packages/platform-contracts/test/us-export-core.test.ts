import { describe, expect, it } from "vitest";
import { usExportBuildIdentitySchema, usExportInputV1Schema } from "../src/index.js";
import {
  at,
  draft,
  eventId,
  snapshotV1,
  snapshotV2,
  snapshotV3,
  successorId,
} from "./support/us-receiving-lifecycle-fixture.js";

const receiving = {
  type: "receiving",
  eventId,
  revision: 1,
  timeZone: "America/Los_Angeles",
  lifecycle: "current_finalized",
  payload: { kind: "frozen", snapshot: snapshotV3 },
};
const metadata = {
  mode: "export_ready_candidate",
  profile: "US_FSMA204_PROCESSOR",
  scopeLabel: "Captured receiving scope",
  timeZone: "America/Chicago",
  generatedAt: "2026-10-02T12:00:00.000Z",
  baselineId: "US-REG-2026-09-03",
  registryId: "fda_sortable_xlsx",
  registryVersion: 1,
  registryHash: "b".repeat(64),
  build: { apiVersion: "0.1.0", gitSha: "a".repeat(40), dirty: true },
};
const valid = {
  schemaVersion: 1,
  mode: "export_ready_candidate",
  tenantId: "synthetic-tenant",
  events: [receiving],
  findings: [],
  metadata,
};
const line = at(snapshotV1.items, 0);
const receivingDraftLine = {
  productId: line.productId,
  lotLinkMode: "link_existing",
  lotId: line.lotId,
  tlc: line.tlc,
  source: { kind: "location", locationId: snapshotV1.previousSourceLocationId },
  exemptSupplier: false,
  exemptReason: null,
  supplierLotReference: null,
  quantity: "5",
  unitOfMeasure: "lb",
  notes: null,
};
const transformation = {
  snapshotVersion: 1,
  eventId,
  eventNumber: "TRN-26-0001",
  revision: 1,
  eventDate: "2026-09-07",
  timeZone: "America/Los_Angeles",
  processor: { id: snapshotV1.locationId, description: "Receiver" },
  reason: "repacking",
  reasonNote: null,
  notes: null,
  inputs: [
    {
      kind: "ftl_lot",
      lineNo: 1,
      lotId: line.lotId,
      product: { id: line.productId, description: "Apples", coverage: line.coverage },
      tlc: line.tlc,
      source: {
        kind: "location",
        id: snapshotV1.previousSourceLocationId,
        description: "Supplier",
      },
      quantity: "5",
      unitOfMeasure: "lb",
    },
  ],
  outputs: [
    {
      lineNo: 1,
      lotId: successorId,
      product: { id: line.productId, description: "Apples", coverage: line.coverage },
      tlc: "OUT",
      source: { kind: "location", id: snapshotV1.locationId, description: "Receiver" },
      quantity: "2",
      unitOfMeasure: "case",
    },
  ],
  documents: [
    { id: at(snapshotV1.documents, 0).document.documentId, type: "bol", number: "BOL-1" },
  ],
  finalizedBy: "qa",
  finalizedAt: metadata.generatedAt,
};
const shipping = {
  snapshotVersion: 1,
  eventId,
  eventNumber: "SHP-26-0001",
  revision: 1,
  eventDate: "2026-09-07",
  timeZone: "America/Los_Angeles",
  shipFrom: snapshotV1.locationDescription,
  recipient: snapshotV1.previousSourceDescription,
  carrierReference: null,
  notes: null,
  items: [
    {
      lineNo: 1,
      lotId: line.lotId,
      quantity: "5",
      unitOfMeasure: "lb",
      tlc: line.tlc,
      source: { kind: "location", location: snapshotV1.previousSourceDescription },
      product: {
        id: line.productId,
        description: line.productDescription,
        coverage: line.coverage,
      },
    },
  ],
  documents: [
    {
      id: at(snapshotV1.documents, 0).document.documentId,
      type: "bol",
      number: "BOL-1",
      issuer: null,
    },
  ],
  finalizedBy: "qa",
  finalizedAt: metadata.generatedAt,
};

describe("US frozen export input", () => {
  it.each([
    ["transformation", transformation],
    ["shipping", shipping],
  ] as const)(
    "requires exact equality between %s frozen and captured timezone",
    (type, snapshot) => {
      const record = { ...receiving, type, payload: { kind: "frozen", snapshot } };
      expect(usExportInputV1Schema.safeParse({ ...valid, events: [record] }).success).toBe(true);
      expect(
        usExportInputV1Schema.safeParse({
          ...valid,
          events: [{ ...record, timeZone: "America/Chicago" }],
        }).success,
      ).toBe(false);
      expect(
        usExportInputV1Schema.safeParse({
          ...valid,
          events: [
            {
              ...record,
              payload: { kind: "frozen", snapshot: { ...snapshot, timeZone: "America/Chicago" } },
            },
          ],
        }).success,
      ).toBe(false);
    },
  );
  it.each([
    { ...receiving },
    { ...receiving, lifecycle: "draft", payload: { kind: "saved_draft", draft } },
    { ...receiving, type: "transformation", payload: { kind: "frozen", snapshot: transformation } },
    {
      ...receiving,
      type: "transformation",
      lifecycle: "draft",
      payload: {
        kind: "saved_draft",
        draft: {
          eventDate: null,
          processorLocationId: null,
          reason: null,
          reasonNote: null,
          notes: null,
          inputs: [],
          outputs: [],
          documentIds: [],
        },
      },
    },
    { ...receiving, type: "shipping", payload: { kind: "frozen", snapshot: shipping } },
    {
      ...receiving,
      type: "shipping",
      lifecycle: "void",
      payload: {
        kind: "saved_draft",
        draft: {
          eventDate: null,
          shipFromLocationId: null,
          recipientLocationId: null,
          carrierReference: null,
          notes: null,
          items: [],
          documentIds: [],
        },
      },
    },
  ])(
    "requires and preserves the captured timezone of $type $lifecycle independently of metadata",
    (record) => {
      const input = {
        ...valid,
        mode: "available_records_incomplete",
        metadata: { ...metadata, mode: "available_records_incomplete" },
        events: [record],
      };
      expect(usExportInputV1Schema.parse(input).events[0]?.timeZone).toBe("America/Los_Angeles");
      const missing = { ...record };
      Reflect.deleteProperty(missing, "timeZone");
      expect(usExportInputV1Schema.safeParse({ ...input, events: [missing] }).success).toBe(false);
      for (const timeZone of ["Mars/Base", "+03:00", "", null])
        expect(
          usExportInputV1Schema.safeParse({ ...input, events: [{ ...record, timeZone }] }).success,
        ).toBe(false);
    },
  );
  it.each(["draft", "void"])(
    "preserves amendment predecessor lines for Receiving revision 2 %s",
    (lifecycle) => {
      const amendment = {
        ...draft,
        items: [
          { ...receivingDraftLine, previousLineNo: 4 },
          { ...receivingDraftLine, previousLineNo: null },
        ],
      };
      const input = {
        ...valid,
        mode: "available_records_incomplete",
        metadata: { ...metadata, mode: "available_records_incomplete" },
        events: [
          {
            ...receiving,
            revision: 2,
            lifecycle,
            payload: { kind: "saved_draft", draft: amendment },
          },
        ],
      };
      const parsed = usExportInputV1Schema.parse(input);
      const event = parsed.events[0];
      if (event?.type !== "receiving" || event.payload.kind !== "saved_draft")
        throw new Error("Expected a saved Receiving draft");
      expect(
        event.payload.draft.items.map((item) =>
          "previousLineNo" in item ? item.previousLineNo : undefined,
        ),
      ).toEqual([4, null]);
    },
  );
  it("requires the saved Receiving draft shape corresponding to its revision", () => {
    const saved = { ...draft, items: [receivingDraftLine] };
    const amendment = { ...draft, items: [{ ...receivingDraftLine, previousLineNo: 4 }] };
    const input = {
      ...valid,
      mode: "available_records_incomplete",
      metadata: { ...metadata, mode: "available_records_incomplete" },
    };
    for (const [revision, savedDraft] of [
      [1, amendment],
      [2, saved],
    ] as const)
      expect(
        usExportInputV1Schema.safeParse({
          ...input,
          events: [
            {
              ...receiving,
              revision,
              lifecycle: "draft",
              payload: { kind: "saved_draft", draft: savedDraft },
            },
          ],
        }).success,
      ).toBe(false);
    expect(
      usExportInputV1Schema.safeParse({
        ...input,
        events: [
          {
            ...receiving,
            revision: 2,
            lifecycle: "draft",
            payload: {
              kind: "saved_draft",
              draft: { ...amendment, items: [amendment.items[0], amendment.items[0]] },
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it.each([snapshotV1, snapshotV2, snapshotV3])(
    "preserves Receiving snapshot v$snapshotVersion",
    (snapshot) => {
      expect(
        usExportInputV1Schema.parse({
          ...valid,
          events: [{ ...receiving, payload: { kind: "frozen", snapshot } }],
        }).events[0]?.payload,
      ).toEqual({ kind: "frozen", snapshot });
    },
  );
  it("accepts a saved draft only with explicit non-final lifecycle and incomplete mode", () => {
    const record = { ...receiving, lifecycle: "draft", payload: { kind: "saved_draft", draft } };
    const input = {
      ...valid,
      mode: "available_records_incomplete",
      metadata: { ...metadata, mode: "available_records_incomplete" },
      events: [record],
    };
    expect(usExportInputV1Schema.safeParse(input).success).toBe(true);
    expect(
      usExportInputV1Schema.safeParse({
        ...input,
        events: [{ ...record, lifecycle: "current_finalized" }],
      }).success,
    ).toBe(false);
    expect(usExportInputV1Schema.safeParse({ ...valid, events: [record] }).success).toBe(false);
    expect(
      usExportInputV1Schema.safeParse({
        ...input,
        events: [{ ...record, payload: { kind: "saved_draft", draft: { ...draft, extra: true } } }],
      }).success,
    ).toBe(false);
  });
  it.each([
    ["transformation", transformation],
    ["shipping", shipping],
  ] as const)("binds %s frozen event ID and revision to its envelope", (type, snapshot) => {
    const record = { ...receiving, type, payload: { kind: "frozen", snapshot } };
    expect(usExportInputV1Schema.safeParse({ ...valid, events: [record] }).success).toBe(true);
    expect(
      usExportInputV1Schema.safeParse({ ...valid, events: [{ ...record, eventId: successorId }] })
        .success,
    ).toBe(false);
    expect(
      usExportInputV1Schema.safeParse({ ...valid, events: [{ ...record, revision: 2 }] }).success,
    ).toBe(false);
  });
  it("requires nonempty unique pins without collapsing distinct revisions", () => {
    expect(usExportInputV1Schema.safeParse({ ...valid, events: [] }).success).toBe(false);
    expect(
      usExportInputV1Schema.safeParse({ ...valid, events: [receiving, receiving] }).success,
    ).toBe(false);
    expect(
      usExportInputV1Schema.safeParse({
        ...valid,
        events: [receiving, { ...receiving, eventId: eventId.toLowerCase() }],
      }).success,
    ).toBe(false);
    expect(
      usExportInputV1Schema.safeParse({
        ...valid,
        events: [receiving, { ...receiving, revision: 2 }],
      }).success,
    ).toBe(true);
  });
  it("retains historical and void frozen values only in incomplete mode", () => {
    for (const lifecycle of ["historical_finalized", "void"]) {
      const record = { ...receiving, lifecycle };
      expect(usExportInputV1Schema.safeParse({ ...valid, events: [record] }).success).toBe(false);
      expect(
        usExportInputV1Schema.safeParse({
          ...valid,
          mode: "available_records_incomplete",
          metadata: { ...metadata, mode: "available_records_incomplete" },
          events: [record],
        }).success,
      ).toBe(true);
    }
    expect(
      usExportInputV1Schema.safeParse({
        ...valid,
        mode: "available_records_incomplete",
        metadata: { ...metadata, mode: "available_records_incomplete" },
        events: [{ ...receiving, lifecycle: "draft" }],
      }).success,
    ).toBe(false);
  });
  it.each([
    ["receiving", draft],
    [
      "transformation",
      {
        eventDate: null,
        processorLocationId: null,
        reason: null,
        reasonNote: null,
        notes: null,
        inputs: [],
        outputs: [],
        documentIds: [],
      },
    ],
    [
      "shipping",
      {
        eventDate: null,
        shipFromLocationId: null,
        recipientLocationId: null,
        carrierReference: null,
        notes: null,
        items: [],
        documentIds: [],
      },
    ],
  ])(
    "validates %s saved drafts and void drafts through their existing schema",
    (type, savedDraft) => {
      const input = {
        ...valid,
        mode: "available_records_incomplete",
        metadata: { ...metadata, mode: "available_records_incomplete" },
      };
      for (const lifecycle of ["draft", "void"]) {
        const record = {
          ...receiving,
          type,
          lifecycle,
          payload: { kind: "saved_draft", draft: savedDraft },
        };
        expect(usExportInputV1Schema.safeParse({ ...input, events: [record] }).success).toBe(true);
        expect(
          usExportInputV1Schema.safeParse({
            ...input,
            events: [{ ...record, payload: { kind: "saved_draft", draft: {} } }],
          }).success,
        ).toBe(false);
      }
    },
  );
  it("rejects invalid event pins and unsupported snapshot versions", () => {
    for (const patch of [{ eventId: "bad" }, { revision: 0 }, { revision: 1.5 }])
      expect(
        usExportInputV1Schema.safeParse({ ...valid, events: [{ ...receiving, ...patch }] }).success,
      ).toBe(false);
    expect(
      usExportInputV1Schema.safeParse({
        ...valid,
        events: [
          {
            ...receiving,
            payload: { kind: "frozen", snapshot: { ...snapshotV3, snapshotVersion: 4 } },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it.each(["baselineId", "registryId", "registryVersion", "registryHash", "build"])(
    "requires metadata %s",
    (field) => {
      const incomplete = { ...metadata };
      Reflect.deleteProperty(incomplete, field);
      expect(usExportInputV1Schema.safeParse({ ...valid, metadata: incomplete }).success).toBe(
        false,
      );
    },
  );
  it("rejects invalid timezone, instant, registry identity and mismatched mode", () => {
    for (const patch of [
      { timeZone: "Mars/Base" },
      { generatedAt: "2026-10-02" },
      { registryHash: "hash" },
      { registryVersion: 2 },
      { baselineId: "" },
      { mode: "available_records_incomplete" },
    ])
      expect(
        usExportInputV1Schema.safeParse({ ...valid, metadata: { ...metadata, ...patch } }).success,
      ).toBe(false);
  });
  it("rejects extra keys at input, metadata, envelope, payload, snapshot and finding boundaries", () => {
    const finding = {
      code: "missing_kde",
      severity: "warning",
      sourceRecord: "receiving/1",
      message: "Quantity absent",
      eventId,
      revision: 1,
      lineNo: 1,
      fieldKey: "quantity",
    };
    expect(usExportInputV1Schema.safeParse({ ...valid, findings: [finding] }).success).toBe(true);
    for (const input of [
      { ...valid, extra: true },
      { ...valid, metadata: { ...metadata, extra: true } },
      { ...valid, events: [{ ...receiving, status: "finalized" }] },
      { ...valid, events: [{ ...receiving, payload: { ...receiving.payload, extra: true } }] },
      {
        ...valid,
        events: [
          { ...receiving, payload: { kind: "frozen", snapshot: { ...snapshotV3, eventId } } },
        ],
      },
      { ...valid, findings: [{ ...finding, extra: true }] },
    ])
      expect(usExportInputV1Schema.safeParse(input).success).toBe(false);
  });
});

it("requires an explicitly injected immutable build identity including dirty state", () => {
  expect(usExportBuildIdentitySchema.parse(metadata.build)).toEqual(metadata.build);
  for (const build of [
    { ...metadata.build, gitSha: "a".repeat(39) },
    { ...metadata.build, gitSha: "A".repeat(40) },
    { ...metadata.build, apiVersion: "" },
    { apiVersion: "0.1.0", gitSha: "a".repeat(40) },
    { ...metadata.build, extra: true },
  ])
    expect(usExportBuildIdentitySchema.safeParse(build).success).toBe(false);
});
