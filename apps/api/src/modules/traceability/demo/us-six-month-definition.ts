import { buildSscc } from "@markiro/domain";
import { canonicalExportDigest, ownedUsDemoJsonCopy } from "./us-demo-canonical.js";
import {
  referenceDocumentInputSchema,
  type ReferenceDocumentInput,
} from "@markiro/platform-contracts";
import {
  parseUsDatasetDefinition,
  type UsDatasetDefinition,
  type UsDatasetUnit,
} from "./us-dataset-contract.js";
import { usDemoDefinition, usDemoDefinitionDigest } from "./us-demo-definition.js";
import type {
  UsSixMonthChain,
  UsSixMonthDocument,
  UsSixMonthLotLine,
} from "./us-six-month-chains.js";
import { makeUsSixMonthCatalogue } from "./us-six-month-references.js";

export type UsSixMonthSpecialExamples = Readonly<{
  correction: Readonly<{
    initialReceiving: UsSixMonthChain["receiving"];
    amendmentReason: string;
    correctedChain: UsSixMonthChain;
  }>;
  orphan: Readonly<{
    unitKey: "orphan_0001";
    receiving: UsSixMonthChain["receiving"];
    documents: readonly UsSixMonthDocument[];
    voidReason: string;
  }>;
}>;
export type UsSixMonthRequestSelection = Readonly<{
  unitKey: "request_scenario_a" | "request_april" | "request_september";
  reference: string;
  chainKeys: readonly string[];
}>;

/** Only recursively freezes module-owned JSON, never caller data. */
function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

/** Static amendment/void recipes; services must supply actual revision and audit facts. */
export function makeUsSixMonthSpecialExamples(): UsSixMonthSpecialExamples {
  function receipt(
    unitKey: string,
    date: string,
    ordinal: number,
    quantities: readonly [string, string],
  ) {
    const source = `supplier_${String(ordinal).padStart(2, "0")}`;
    const lines: UsSixMonthLotLine[] = quantities.map((quantity, index) => ({
      productKey: `inbound_${String(ordinal).padStart(2, "0")}`,
      tlc: `MUS-IN-${date.replaceAll("-", "")}-${unitKey}-A${index + 1}`,
      quantity,
      unitOfMeasure: "lb",
    }));
    const documents: UsSixMonthDocument[] = [];
    function document(
      stage: string,
      kind: ReferenceDocumentInput["type"],
      partyKey: string,
      issuedOn: string,
    ): string {
      const number = `MUS-${unitKey}-${stage}-${kind}`;
      const { partyId: _parent, ...input } = referenceDocumentInputSchema.parse({
        type: kind,
        number,
        issuedOn,
        partyId: "00000000-0000-4000-8000-000000000000",
        typeOtherLabel: null,
        notes: "Synthetic demo metadata only; no source attachment.",
      });
      void _parent;
      documents.push({ key: `${unitKey}_${stage}_${kind}`, partyKey, input });
      return number;
    }
    const receiving: UsSixMonthChain["receiving"] = {
      eventDate: date,
      previousSourceLocationKey: source,
      receivingLocationKey: "processor",
      references: [
        document("receiving", "asn", source, date),
        document("receiving", "bol", source, date),
      ],
      lines,
    };
    return { receiving, documents, document };
  }
  const correction = receipt("correction_0001", "2026-06-10", 2, ["300", "400"]);
  const outputTlc = "MUS-OUT-20260611-correction_0001";
  const correctedChain: UsSixMonthChain = {
    unitKey: "correction_0001",
    receiving: correction.receiving,
    transformation: {
      eventDate: "2026-06-11",
      locationKey: "processor",
      references: [
        correction.document("transformation", "work_order", "processor", "2026-06-11"),
        correction.document("transformation", "batch_log", "processor", "2026-06-11"),
      ],
      inputs: correction.receiving.lines,
      output: {
        productKey: "output_02",
        tlc: outputTlc,
        quantity: "60",
        unitOfMeasure: "case",
        tlcSourceLocationKey: "processor",
      },
    },
    shipping: [
      {
        eventDate: "2026-06-12",
        tlc: outputTlc,
        quantity: "50",
        unitOfMeasure: "case",
        shippingLocationKey: "processor",
        recipientLocationKey: "recipient_02",
        references: [
          correction.document("shipping_01", "bol", "recipient_02", "2026-06-12"),
          correction.document("shipping_01", "invoice", "recipient_02", "2026-06-12"),
        ],
      },
    ],
    cases: Array.from({ length: 60 }, (_, offset) => buildSscc(9, "9999999", 15641 + offset)),
    documents: correction.documents,
  };
  const initialReceiving = {
    ...correction.receiving,
    lines: correction.receiving.lines.map((line, index) => ({
      ...line,
      quantity: index === 0 ? "250" : line.quantity,
    })),
  };
  const orphan = receipt("orphan_0001", "2026-08-10", 3, ["200", "200"]);
  return ownedUsDemoJsonCopy({
    correction: {
      initialReceiving,
      amendmentReason: "Correct synthetic receiving quantity before downstream use.",
      correctedChain,
    },
    orphan: {
      unitKey: "orphan_0001" as const,
      receiving: orphan.receiving,
      documents: orphan.documents,
      voidReason: "Void synthetic receipt before downstream use.",
    },
  });
}

function chainKeys(start: number, count: number): string[] {
  return Array.from(
    { length: count },
    (_, offset) => `chain_${String(start + offset).padStart(4, "0")}`,
  );
}

export const usSixMonthRequestSelections: readonly UsSixMonthRequestSelection[] = freezeOwned([
  { unitKey: "request_scenario_a", reference: "REQ-2026-APPLE-001", chainKeys: ["chain_0259"] },
  { unitKey: "request_april", reference: "MUS-REQ-APRIL-001", chainKeys: chainKeys(0, 12) },
  {
    unitKey: "request_september",
    reference: "MUS-REQ-SEPTEMBER-001",
    chainKeys: chainKeys(208, 12),
  },
]);

// Every scalar/pattern used by the version-1 expansion is part of its compact identity.
const expansionParameters = {
  regularIndexRange: [0, 259],
  unitKeyPattern: "chain_<index padded to 4 digits>",
  year: 2026,
  firstMonth: 4,
  monthlyCounts: [34, 38, 42, 46, 48, 52],
  monthAssignment: "cumulative monthlyCounts; localIndex = index - preceding monthly counts",
  scheduling: {
    calendarArithmetic: "UTC Gregorian civil weekdays",
    weekendDays: [0, 6],
    removeLastWeekdays: 4,
    quietModulo: 5,
    quietRemainder: 2,
    weekdayWeights: [1, 3, 2, 1],
    weightFormula: "weekdayWeights[candidatePosition % 4] before quiet-position removal",
    slotFormula: "floor(localIndex * slots.length / monthlyCount)",
    transformation: "next weekday after Receiving",
    firstShipping: "next weekday after Transformation",
    secondShipping: "next weekday after first Shipping",
    assignedMonthRequired: true,
  },
  references: {
    supplierCount: 10,
    recipientCount: 12,
    productVariantCount: 8,
    ordinalBase: 1,
    supplierFormula: "(index % 10) + 1",
    firstRecipientFormula: "(index % 12) + 1",
    secondRecipientFormula: "((index + 1) % 12) + 1",
    productFormula: "(index % 8) + 1",
    ordinalOneKeys: {
      supplier: "previous_source",
      recipient: "recipient",
      inbound: "inbound",
      output: "output",
    },
    ordinalKeyPattern: "<kind>_<ordinal padded to 2 digits>",
    processorKey: "processor",
  },
  quantities: {
    inboundUom: "lb",
    outputUom: "case",
    firstBase: 300,
    secondBase: 325,
    step: 25,
    cycle: 9,
    secondOffset: 3,
    oddFraction: ".5",
    firstFormula: "String(300 + 25 * (index % 9)) + (index % 2 === 1 ? '.5' : '')",
    secondFormula: "String(325 + 25 * ((index + 3) % 9))",
    consume: "exact two Receiving quantities; no UOM conversion",
    caseBase: 60,
    deltas: [5, 10, 15, 20],
    pairSize: 2,
    deltaCycle: 4,
    caseFormula: "index <= 257: delta = deltas[floor(index / 2) % 4]; even 60-delta, odd 60+delta",
    finalNonAIndex: 258,
    finalNonACases: 60,
    scenarioAIndex: 259,
    scenarioACases: 100,
    doubleShipmentCount: 180,
    singleShipmentCount: 80,
    retentionModulo: 3,
    doubleRetained: 10,
    firstNumerator: 2,
    firstDenominator: 5,
    singleRetainedDivisor: 4,
    shipmentFormula:
      "index < 180: retained = index % 3 === 0 ? 10 : 0; first = floor(caseCount * 2 / 5); second = caseCount - retained - first; indices 180..258: odd retain floor(caseCount / 4), even retain 0; ship remainder",
    scenarioAShipsAll: true,
  },
  tlcPatterns: {
    inbound: "MUS-IN-<YYYYMMDD receiving>-<unitKey>-A1/A2",
    output: "MUS-OUT-<YYYYMMDD transformation>-<unitKey>",
  },
  namespace: {
    synthetic: true,
    allocated: false,
    extensionDigit: 9,
    prefix: "9999999",
    scenarioASerials: [1, 100],
    regularSerials: [101, 15640],
    correctionSerials: [15641, 15700],
    regularStartFormula: "101 + sum(caseCounts of earlier non-A indices)",
    builder: "@markiro/domain buildSscc",
  },
  documents: {
    keyPattern: "<unitKey>_<stage>_<kind>",
    numberPattern: "MUS-<unitKey>-<stage>-<kind>",
    receivingKinds: ["asn", "bol"],
    transformationKinds: ["work_order", "batch_log"],
    shippingKinds: ["bol", "invoice"],
    shippingStagePattern: "shipping_<ordinal padded to 2 digits>",
    issuedOn: "event civil date",
    party: "Receiving previous source; Transformation processor; Shipping recipient",
    typeOtherLabel: null,
    notes: "Synthetic demo metadata only; no source attachment.",
  },
  scenarioA: {
    index: 259,
    expansion: "exact compact definition and compact reference documents; bypass general algorithm",
  },
};

const units: UsDatasetUnit[] = [
  { key: "references", kind: "references", stages: ["references"] },
  ...chainKeys(0, 260).map((key) => ({
    key,
    kind: "chain" as const,
    stages: ["receiving", "transformation", "cases", "shipping", "trace_readiness"] as const,
  })),
  {
    key: "correction_0001",
    kind: "correction",
    stages: [
      "receiving",
      "amend_receiving",
      "transformation",
      "cases",
      "shipping",
      "trace_readiness",
    ],
  },
  {
    key: "orphan_0001",
    kind: "orphan",
    stages: ["receiving", "void_receiving", "trace_readiness"],
  },
  { key: "plan", kind: "plan", stages: ["plan"] },
  ...usSixMonthRequestSelections.map((selection) => ({
    key: selection.unitKey,
    kind: "request" as const,
    stages: ["request", "package"] as const,
  })),
];
const body = {
  version: "us-processor-six-month-v1" as const,
  manifest: {
    algorithmVersion: "markiro-us-six-month-expansion-v1",
    synthetic: true,
    period: { start: "2026-04-01", end: "2026-09-30" },
    timezone: "America/Los_Angeles",
    expectedTotals: { eventRoots: 964, currentFinalizedEvents: 963, lots: 785, boxes: 15700 },
    catalogue: makeUsSixMonthCatalogue(),
    scenarioA: {
      chainKey: "chain_0259",
      definition: usDemoDefinition,
      digest: usDemoDefinitionDigest,
    },
    expansionParameters,
    specialExamples: makeUsSixMonthSpecialExamples(),
    requestSelections: usSixMonthRequestSelections,
  },
  units,
};
export const usSixMonthDefinition: UsDatasetDefinition = parseUsDatasetDefinition({
  ...body,
  digest: canonicalExportDigest(body),
});
