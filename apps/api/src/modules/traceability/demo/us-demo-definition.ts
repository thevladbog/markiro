import { buildSscc, canonicalExportDigest } from "@markiro/domain";

export const US_DEMO_VERSION = "us-processor-demo-v1";

/** Only called with objects owned by this module, never with caller input. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Scenario A's static fictional facts. Runtime receipts/times belong in the journal. */
export const usDemoDefinition = deepFreeze({
  scenarioVersion: US_DEMO_VERSION,
  profile: "US_FSMA204_PROCESSOR",
  timezone: "America/Los_Angeles",
  parties: [
    { key: "previous_source", name: "Orchard Slice Supply LLC", phone: "+1 509-555-0101" },
    { key: "processor", name: "North River Fresh Foods LLC", phone: "+1 503-555-0120" },
    { key: "recipient", name: "Harbor Market Distribution Center", phone: "+1 206-555-0147" },
  ],
  locations: [
    {
      key: "previous_source",
      partyKey: "previous_source",
      address: "100 Example Orchard Rd, Yakima, WA 98901, USA",
    },
    {
      key: "processor",
      partyKey: "processor",
      address: "500 Example River Pkwy, Portland, OR 97203, USA",
    },
    {
      key: "recipient",
      partyKey: "recipient",
      address: "200 Example Harbor Ave, Seattle, WA 98134, USA",
    },
  ],
  products: [
    {
      key: "inbound",
      description: "Fresh-Cut Red Delicious Apple Slices",
      brand: "Orchard Slice",
      packaging: "10 lb bag",
    },
    {
      key: "output",
      description: "Fresh-Cut Apple Snack Cups",
      brand: "North River",
      packaging: "6 oz cups, 24 cups/case",
    },
  ],
  receiving: {
    eventDate: "2026-09-14",
    previousSourceLocationKey: "previous_source",
    receivingLocationKey: "processor",
    references: ["ASN-2026-0914-001", "BOL-0914-A"],
    lines: [
      { productKey: "inbound", tlc: "OSS-260914-A1", quantity: "500", unitOfMeasure: "lb" },
      { productKey: "inbound", tlc: "OSS-260914-A2", quantity: "500", unitOfMeasure: "lb" },
    ],
  },
  transformation: {
    eventDate: "2026-09-15",
    locationKey: "processor",
    references: ["WO-2026-0915-APPLECUP", "BATCH-2026-0915-01"],
    inputs: [
      { productKey: "inbound", tlc: "OSS-260914-A1", quantity: "500", unitOfMeasure: "lb" },
      { productKey: "inbound", tlc: "OSS-260914-A2", quantity: "500", unitOfMeasure: "lb" },
    ],
    output: {
      productKey: "output",
      tlc: "NRF-260915-APL01",
      quantity: "100",
      unitOfMeasure: "case",
      tlcSourceLocationKey: "processor",
    },
  },
  shipping: {
    eventDate: "2026-09-16",
    tlc: "NRF-260915-APL01",
    quantity: "100",
    unitOfMeasure: "case",
    shippingLocationKey: "processor",
    recipientLocationKey: "recipient",
    references: ["BOL-0916-H", "INV-2026-0916-047"],
  },
  request: { requestDate: "2026-09-17", reference: "REQ-2026-APPLE-001" },
  // Deliberately fictional fixture prefix, extension and serials; no GS1 allocation claim.
  cases: Object.freeze(
    Array.from({ length: 100 }, (_, index) => buildSscc(9, "9999999", index + 1)),
  ),
} as const);

export const usDemoDefinitionDigest = canonicalExportDigest(usDemoDefinition);
