import { buildSscc } from "@markiro/domain";
import {
  referenceDocumentInputSchema,
  type ReferenceDocumentInput,
} from "@markiro/platform-contracts";
import { usDemoDefinition } from "./us-demo-definition.js";
import { makeUsDemoReferenceRecipe } from "./us-demo-reference-recipe.js";
import { makeUsSixMonthCatalogue } from "./us-six-month-references.js";

export type UsSixMonthDocument = Readonly<{
  key: string;
  partyKey: string;
  input: Omit<ReferenceDocumentInput, "partyId">;
}>;
export type UsSixMonthLotLine = Readonly<{
  productKey: string;
  tlc: string;
  quantity: string;
  unitOfMeasure: "lb";
}>;
export type UsSixMonthShipment = Readonly<{
  eventDate: string;
  tlc: string;
  quantity: string;
  unitOfMeasure: "case";
  shippingLocationKey: string;
  recipientLocationKey: string;
  references: readonly string[];
}>;
export type UsSixMonthChain = Readonly<{
  unitKey: string;
  receiving: Readonly<{
    eventDate: string;
    previousSourceLocationKey: string;
    receivingLocationKey: string;
    references: readonly string[];
    lines: readonly UsSixMonthLotLine[];
  }>;
  transformation: Readonly<{
    eventDate: string;
    locationKey: string;
    references: readonly string[];
    inputs: readonly UsSixMonthLotLine[];
    output: Readonly<{
      productKey: string;
      tlc: string;
      quantity: string;
      unitOfMeasure: "case";
      tlcSourceLocationKey: string;
    }>;
  }>;
  shipping: readonly UsSixMonthShipment[];
  cases: readonly string[];
  documents: readonly UsSixMonthDocument[];
}>;

const monthlyCounts = [34, 38, 42, 46, 48, 52] as const;
const catalogue = makeUsSixMonthCatalogue();

function invalid(): never {
  throw new Error("us_six_month_chain_invalid");
}

/** Only owned JSON copies enter this helper. */
function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

function regularCaseCount(index: number): number {
  if (index === 259) return 100;
  if (index === 258) return 60;
  const deltas = [5, 10, 15, 20] as const;
  const delta = deltas[Math.floor(index / 2) % deltas.length];
  if (delta === undefined) return invalid();
  return index % 2 === 0 ? 60 - delta : 60 + delta;
}

function stableKey(kind: "supplier" | "recipient" | "inbound" | "output", ordinal: number): string {
  if (ordinal === 1) return kind === "supplier" ? "previous_source" : kind;
  return `${kind}_${String(ordinal).padStart(2, "0")}`;
}

function resolveKey(group: "parties" | "locations" | "products", key: string): string {
  if (catalogue[group].filter((entry) => entry.key === key).length !== 1) return invalid();
  if (group === "locations") {
    const location = catalogue.locations.find((entry) => entry.key === key);
    if (!location) return invalid();
    resolveKey("parties", location.partyKey);
  }
  return key;
}

function civilDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function nextWeekday(date: string): string {
  const calendar = new Date(`${date}T00:00:00Z`);
  do {
    calendar.setUTCDate(calendar.getUTCDate() + 1);
  } while (calendar.getUTCDay() === 0 || calendar.getUTCDay() === 6);
  return civilDate(calendar);
}

function receivingDate(index: number): string {
  let localIndex = index;
  for (const [monthOrdinal, count] of monthlyCounts.entries()) {
    if (localIndex >= count) {
      localIndex -= count;
      continue;
    }
    const month = monthOrdinal + 3;
    const calendar = new Date(Date.UTC(2026, month, 1));
    const weekdays: string[] = [];
    while (calendar.getUTCMonth() === month) {
      if (calendar.getUTCDay() !== 0 && calendar.getUTCDay() !== 6)
        weekdays.push(civilDate(calendar));
      calendar.setUTCDate(calendar.getUTCDate() + 1);
    }
    const weights = [1, 3, 2, 1] as const;
    const slots = weekdays.slice(0, -4).flatMap((date, position) => {
      if (position % 5 === 2) return [];
      const weight = weights[position % weights.length];
      if (weight === undefined) return invalid();
      return Array.from({ length: weight }, () => date);
    });
    return slots[Math.floor((localIndex * slots.length) / count)] ?? invalid();
  }
  return invalid();
}

/** One bounded fictional chain; the SSCC namespace is synthetic and unallocated. */
export function makeUsSixMonthRegularChain(index: number): UsSixMonthChain {
  if (!Number.isSafeInteger(index) || index < 0 || index > 259) return invalid();
  const unitKey = `chain_${String(index).padStart(4, "0")}`;
  if (index === 259) {
    const chain = structuredClone({
      unitKey,
      receiving: usDemoDefinition.receiving,
      transformation: usDemoDefinition.transformation,
      shipping: [usDemoDefinition.shipping],
      cases: usDemoDefinition.cases,
      documents: makeUsDemoReferenceRecipe().documents,
    });
    for (const key of [
      chain.receiving.previousSourceLocationKey,
      chain.receiving.receivingLocationKey,
      chain.transformation.locationKey,
      chain.transformation.output.tlcSourceLocationKey,
      ...chain.shipping.flatMap((shipment) => [
        shipment.shippingLocationKey,
        shipment.recipientLocationKey,
      ]),
    ])
      resolveKey("locations", key);
    for (const line of [...chain.receiving.lines, ...chain.transformation.inputs])
      resolveKey("products", line.productKey);
    resolveKey("products", chain.transformation.output.productKey);
    for (const document of chain.documents) resolveKey("parties", document.partyKey);
    return freezeOwned(chain);
  }
  const source = resolveKey("locations", stableKey("supplier", (index % 10) + 1));
  const processor = resolveKey("locations", "processor");
  const product = resolveKey("products", stableKey("inbound", (index % 8) + 1));
  const outputProduct = resolveKey("products", stableKey("output", (index % 8) + 1));
  const rDate = receivingDate(index);
  const tDate = nextWeekday(rDate);
  const outputTlc = `MUS-OUT-${tDate.replaceAll("-", "")}-${unitKey}`;
  const count = regularCaseCount(index);
  const lines: UsSixMonthLotLine[] = [
    {
      productKey: product,
      tlc: `MUS-IN-${rDate.replaceAll("-", "")}-${unitKey}-A1`,
      quantity: `${300 + 25 * (index % 9)}${index % 2 === 1 ? ".5" : ""}`,
      unitOfMeasure: "lb",
    },
    {
      productKey: product,
      tlc: `MUS-IN-${rDate.replaceAll("-", "")}-${unitKey}-A2`,
      quantity: String(325 + 25 * ((index + 3) % 9)),
      unitOfMeasure: "lb",
    },
  ];
  const documents: UsSixMonthDocument[] = [];
  function document(
    stage: string,
    kind: ReferenceDocumentInput["type"],
    partyKey: string,
    issuedOn: string,
  ): string {
    resolveKey("parties", partyKey);
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
  const rReferences = [
    document("receiving", "asn", source, rDate),
    document("receiving", "bol", source, rDate),
  ];
  const tReferences = [
    document("transformation", "work_order", processor, tDate),
    document("transformation", "batch_log", processor, tDate),
  ];
  const shipmentCount = index < 180 ? 2 : 1;
  const retained =
    shipmentCount === 2 ? (index % 3 === 0 ? 10 : 0) : index % 2 === 1 ? Math.floor(count / 4) : 0;
  const firstQuantity = shipmentCount === 2 ? Math.floor((count * 2) / 5) : count - retained;
  let sDate = nextWeekday(tDate);
  const shipping: UsSixMonthShipment[] = [];
  for (let shipment = 0; shipment < shipmentCount; shipment++) {
    const recipient = resolveKey(
      "locations",
      stableKey("recipient", ((index + shipment) % 12) + 1),
    );
    const quantity = shipment === 0 ? firstQuantity : count - retained - firstQuantity;
    if (!Number.isSafeInteger(quantity) || quantity <= 0 || sDate.slice(0, 7) !== rDate.slice(0, 7))
      return invalid();
    const stage = `shipping_${String(shipment + 1).padStart(2, "0")}`;
    shipping.push({
      eventDate: sDate,
      tlc: outputTlc,
      quantity: String(quantity),
      unitOfMeasure: "case",
      shippingLocationKey: processor,
      recipientLocationKey: recipient,
      references: [
        document(stage, "bol", recipient, sDate),
        document(stage, "invoice", recipient, sDate),
      ],
    });
    sDate = nextWeekday(sDate);
  }
  let serialStart = 101;
  for (let previous = 0; previous < index; previous++) serialStart += regularCaseCount(previous);
  if (!Number.isSafeInteger(serialStart) || !Number.isSafeInteger(count)) return invalid();
  return freezeOwned(
    structuredClone({
      unitKey,
      receiving: {
        eventDate: rDate,
        previousSourceLocationKey: source,
        receivingLocationKey: processor,
        references: rReferences,
        lines,
      },
      transformation: {
        eventDate: tDate,
        locationKey: processor,
        references: tReferences,
        inputs: lines,
        output: {
          productKey: outputProduct,
          tlc: outputTlc,
          quantity: String(count),
          unitOfMeasure: "case",
          tlcSourceLocationKey: processor,
        },
      },
      shipping,
      cases: Array.from({ length: count }, (_, offset) =>
        buildSscc(9, "9999999", serialStart + offset),
      ),
      documents,
    }),
  );
}
