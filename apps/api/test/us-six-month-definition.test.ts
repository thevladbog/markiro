import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildSscc, canonicalExportDigest, isValidSscc } from "@markiro/domain";
import { referenceDocumentInputSchema } from "@markiro/platform-contracts";
import { describe, expect, it, vi } from "vitest";
import { parseUsDatasetDefinition } from "../src/modules/traceability/demo/us-dataset-contract.js";
import { assertBoundedSyntheticJson } from "../src/modules/traceability/demo/us-demo-journal-contract.js";
import {
  usDemoDefinition,
  usDemoDefinitionDigest,
} from "../src/modules/traceability/demo/us-demo-definition.js";
import { makeUsSixMonthRegularChain } from "../src/modules/traceability/demo/us-six-month-chains.js";
import { makeUsSixMonthCatalogue } from "../src/modules/traceability/demo/us-six-month-references.js";
import {
  makeUsSixMonthSpecialExamples,
  usSixMonthDefinition,
  usSixMonthRequestSelections,
} from "../src/modules/traceability/demo/us-six-month-definition.js";

const chains = Array.from({ length: 260 }, (_, index) => makeUsSixMonthRegularChain(index));
const chainKeys = (start: number, length: number) =>
  Array.from({ length }, (_, offset) => `chain_${String(start + offset).padStart(4, "0")}`);
function census() {
  const special = makeUsSixMonthSpecialExamples();
  const all = [...chains, special.correction.correctedChain];
  return {
    eventRoots: all.reduce((n, chain) => n + 2 + chain.shipping.length, 1),
    currentFinalizedEvents: all.reduce((n, chain) => n + 2 + chain.shipping.length, 0),
    lots: all.reduce(
      (n, chain) => n + chain.receiving.lines.length + 1,
      special.orphan.receiving.lines.length,
    ),
    boxes: all.reduce((n, chain) => n + chain.cases.length, 0),
  };
}
function frozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) frozen(child);
}

describe("complete six-month recipe", () => {
  it("amends only the first quantity while preserving correction identity before downstream use", () => {
    const { correction } = makeUsSixMonthSpecialExamples();
    expect(correction.amendmentReason).toBe(
      "Correct synthetic receiving quantity before downstream use.",
    );
    expect(correction.initialReceiving.lines.map((line) => line.quantity)).toEqual(["250", "400"]);
    expect(correction.correctedChain.receiving.lines.map((line) => line.quantity)).toEqual([
      "300",
      "400",
    ]);
    const initial = structuredClone(correction.initialReceiving);
    const first = initial.lines[0];
    if (!first) throw new Error("missing correction line");
    expect(Reflect.set(first, "quantity", "300")).toBe(true);
    expect(initial).toEqual(correction.correctedChain.receiving);
    const chain = correction.correctedChain;
    expect(chain.unitKey).toBe("correction_0001");
    expect([
      chain.receiving.eventDate,
      chain.transformation.eventDate,
      chain.shipping[0]?.eventDate,
    ]).toEqual(["2026-06-10", "2026-06-11", "2026-06-12"]);
    expect(chain.receiving).toMatchObject({
      previousSourceLocationKey: "supplier_02",
      receivingLocationKey: "processor",
    });
    expect(chain.transformation.inputs).toEqual(chain.receiving.lines);
    expect(chain.receiving.lines).toEqual([
      {
        productKey: "inbound_02",
        tlc: "MUS-IN-20260610-correction_0001-A1",
        quantity: "300",
        unitOfMeasure: "lb",
      },
      {
        productKey: "inbound_02",
        tlc: "MUS-IN-20260610-correction_0001-A2",
        quantity: "400",
        unitOfMeasure: "lb",
      },
    ]);
    expect(
      chain.documents.map((doc) => [
        doc.key,
        doc.partyKey,
        doc.input.type,
        doc.input.number,
        doc.input.issuedOn,
      ]),
    ).toEqual([
      [
        "correction_0001_receiving_asn",
        "supplier_02",
        "asn",
        "MUS-correction_0001-receiving-asn",
        "2026-06-10",
      ],
      [
        "correction_0001_receiving_bol",
        "supplier_02",
        "bol",
        "MUS-correction_0001-receiving-bol",
        "2026-06-10",
      ],
      [
        "correction_0001_transformation_work_order",
        "processor",
        "work_order",
        "MUS-correction_0001-transformation-work_order",
        "2026-06-11",
      ],
      [
        "correction_0001_transformation_batch_log",
        "processor",
        "batch_log",
        "MUS-correction_0001-transformation-batch_log",
        "2026-06-11",
      ],
      [
        "correction_0001_shipping_01_bol",
        "recipient_02",
        "bol",
        "MUS-correction_0001-shipping_01-bol",
        "2026-06-12",
      ],
      [
        "correction_0001_shipping_01_invoice",
        "recipient_02",
        "invoice",
        "MUS-correction_0001-shipping_01-invoice",
        "2026-06-12",
      ],
    ]);
    expect(chain.transformation.output).toMatchObject({
      productKey: "output_02",
      quantity: "60",
      unitOfMeasure: "case",
      tlc: "MUS-OUT-20260611-correction_0001",
    });
    expect(chain.shipping).toHaveLength(1);
    expect(chain.shipping[0]).toMatchObject({
      quantity: "50",
      recipientLocationKey: "recipient_02",
      tlc: chain.transformation.output.tlc,
    });
    expect(chain.cases).toEqual(
      Array.from({ length: 60 }, (_, offset) => buildSscc(9, "9999999", 15641 + offset)),
    );
    expect(Number(chain.transformation.output.quantity) - Number(chain.shipping[0]?.quantity)).toBe(
      10,
    );
  });
  it("retains two distinct orphan lots without downstream recipes or documents", () => {
    const { orphan } = makeUsSixMonthSpecialExamples();
    expect(Object.keys(orphan).sort()).toEqual(["documents", "receiving", "unitKey", "voidReason"]);
    expect(orphan.voidReason).toBe("Void synthetic receipt before downstream use.");
    expect(orphan.receiving).toMatchObject({
      eventDate: "2026-08-10",
      previousSourceLocationKey: "supplier_03",
      receivingLocationKey: "processor",
    });
    expect(orphan.receiving.lines).toEqual(
      [1, 2].map((ordinal) => ({
        productKey: "inbound_03",
        tlc: `MUS-IN-20260810-orphan_0001-A${ordinal}`,
        quantity: "200",
        unitOfMeasure: "lb",
      })),
    );
    expect(
      orphan.documents.map((doc) => [doc.key, doc.partyKey, doc.input.type, doc.input.issuedOn]),
    ).toEqual([
      ["orphan_0001_receiving_asn", "supplier_03", "asn", "2026-08-10"],
      ["orphan_0001_receiving_bol", "supplier_03", "bol", "2026-08-10"],
    ]);
  });
  it("resolves exact complete selections within April and September and keeps Scenario A separate", () => {
    expect(usSixMonthRequestSelections).toEqual([
      { unitKey: "request_scenario_a", reference: "REQ-2026-APPLE-001", chainKeys: ["chain_0259"] },
      { unitKey: "request_april", reference: "MUS-REQ-APRIL-001", chainKeys: chainKeys(0, 12) },
      {
        unitKey: "request_september",
        reference: "MUS-REQ-SEPTEMBER-001",
        chainKeys: chainKeys(208, 12),
      },
    ]);
    for (const [index, selection] of usSixMonthRequestSelections.entries()) {
      for (const key of selection.chainKeys) {
        const chain = chains.find((chain) => chain.unitKey === key);
        expect(chain).toBeDefined();
        expect(chain?.receiving.eventDate.slice(0, 7)).toBe(index === 1 ? "2026-04" : "2026-09");
      }
    }
    expect(usSixMonthRequestSelections[2]?.chainKeys).not.toContain("chain_0259");
  });
  it("owns exactly 267 ordered units with complete per-kind stage sequences", () => {
    const units = usSixMonthDefinition.units;
    expect(units.map((unit) => unit.key)).toEqual([
      "references",
      ...chainKeys(0, 260),
      "correction_0001",
      "orphan_0001",
      "plan",
      "request_scenario_a",
      "request_april",
      "request_september",
    ]);
    const sequences = {
      references: ["references"],
      chain: ["receiving", "transformation", "cases", "shipping", "trace_readiness"],
      correction: [
        "receiving",
        "amend_receiving",
        "transformation",
        "cases",
        "shipping",
        "trace_readiness",
      ],
      orphan: ["receiving", "void_receiving", "trace_readiness"],
      plan: ["plan"],
      request: ["request", "package"],
    };
    expect(units).toHaveLength(267);
    for (const unit of units) expect(unit.stages).toEqual(sequences[unit.kind]);
    expect(units.map((unit) => unit.kind)).toEqual([
      "references",
      ...Array.from({ length: 260 }, () => "chain"),
      "correction",
      "orphan",
      "plan",
      "request",
      "request",
      "request",
    ]);
    expect(parseUsDatasetDefinition(usSixMonthDefinition)).toEqual(usSixMonthDefinition);
  });
  it("embeds complete compact Scenario A, catalogue, parameters and special selections without regular expansion", () => {
    const manifest = usSixMonthDefinition.manifest;
    expect(manifest).toMatchObject({
      synthetic: true,
      algorithmVersion: "markiro-us-six-month-expansion-v1",
      period: { start: "2026-04-01", end: "2026-09-30" },
      timezone: "America/Los_Angeles",
    });
    expect(manifest["catalogue"]).toEqual(makeUsSixMonthCatalogue());
    expect(manifest["scenarioA"]).toEqual({
      chainKey: "chain_0259",
      definition: usDemoDefinition,
      digest: usDemoDefinitionDigest,
    });
    expect(manifest["specialExamples"]).toEqual(makeUsSixMonthSpecialExamples());
    expect(manifest["requestSelections"]).toEqual(usSixMonthRequestSelections);
    expect(manifest["expansionParameters"]).toMatchObject({
      monthlyCounts: [34, 38, 42, 46, 48, 52],
      scheduling: {
        weekdayWeights: [1, 3, 2, 1],
        removeLastWeekdays: 4,
        quietModulo: 5,
        quietRemainder: 2,
      },
      namespace: {
        synthetic: true,
        allocated: false,
        extensionDigit: 9,
        prefix: "9999999",
        scenarioASerials: [1, 100],
        regularSerials: [101, 15640],
        correctionSerials: [15641, 15700],
      },
    });
    expect(manifest).not.toHaveProperty("chains");
    expect(manifest).not.toHaveProperty("documents");
    expect(manifest).not.toHaveProperty("cases");
  });
  it("proves independent full census, disjoint TLCs and SSCCs and bounded expansions", () => {
    expect(census()).toEqual({
      eventRoots: 964,
      currentFinalizedEvents: 963,
      lots: 785,
      boxes: 15700,
    });
    expect(usSixMonthDefinition.manifest["expectedTotals"]).toEqual(census());
    const special = makeUsSixMonthSpecialExamples();
    const all = [...chains, special.correction.correctedChain];
    const catalogue = makeUsSixMonthCatalogue();
    for (const receiving of [...all.map((chain) => chain.receiving), special.orphan.receiving]) {
      for (const key of [receiving.previousSourceLocationKey, receiving.receivingLocationKey])
        expect(catalogue.locations.filter((entry) => entry.key === key)).toHaveLength(1);
      for (const line of receiving.lines)
        expect(catalogue.products.filter((entry) => entry.key === line.productKey)).toHaveLength(1);
    }
    const boxes = all.flatMap((chain) => chain.cases);
    expect(new Set(boxes).size).toBe(15700);
    expect(boxes.every(isValidSscc)).toBe(true);
    const lots = [
      ...all.flatMap((chain) => [
        ...chain.receiving.lines.map((line) => line.tlc),
        chain.transformation.output.tlc,
      ]),
      ...special.orphan.receiving.lines.map((line) => line.tlc),
    ];
    expect(new Set(lots).size).toBe(785);
    for (const chain of all) assertBoundedSyntheticJson(chain);
    assertBoundedSyntheticJson(special.orphan);
    for (const doc of [...all.flatMap((chain) => chain.documents), ...special.orphan.documents])
      expect(
        referenceDocumentInputSchema.safeParse({
          ...doc.input,
          partyId: "00000000-0000-4000-8000-000000000000",
        }).success,
      ).toBe(true);
  });
  it("keeps the combined immutable identity below 256 KiB with no actual clocks or credentials", async () => {
    const body = {
      version: usSixMonthDefinition.version,
      manifest: usSixMonthDefinition.manifest,
      units: usSixMonthDefinition.units,
    };
    assertBoundedSyntheticJson(body);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(256 * 1024);
    expect(usSixMonthDefinition.digest).toBe(canonicalExportDigest(body));
    expect(usSixMonthDefinition.digest).toBe(
      "f6bd2bceaeb921ee0237157dfe6f2ea9f72ed31ada816f6817f40e8e06efda5a",
    );
    frozen(usSixMonthDefinition);
    frozen(makeUsSixMonthSpecialExamples());
    const firstSpecial = makeUsSixMonthSpecialExamples();
    const secondSpecial = makeUsSixMonthSpecialExamples();
    expect(firstSpecial).toEqual(secondSpecial);
    expect(firstSpecial.correction.correctedChain.cases).not.toBe(
      secondSpecial.correction.correctedChain.cases,
    );
    frozen(usSixMonthRequestSelections);
    expect(Reflect.set(usSixMonthDefinition.manifest, "synthetic", false)).toBe(false);
    const copy = structuredClone(usSixMonthDefinition);
    expect(Reflect.set(copy.manifest, "synthetic", false)).toBe(true);
    expect(usSixMonthDefinition.manifest["synthetic"]).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(
      /password|token|cookie|authorization|privateKey|approvedAt|receivedAt|dueAt|createdAt|operationKey|storageKey/i,
    );
    vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      vi.resetModules();
      const fresh = await import("../src/modules/traceability/demo/us-six-month-definition.js");
      expect(fresh.usSixMonthDefinition).toEqual(usSixMonthDefinition);
      expect(fresh.usSixMonthDefinition.digest).toBe(
        "f6bd2bceaeb921ee0237157dfe6f2ea9f72ed31ada816f6817f40e8e06efda5a",
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
  it.each(["UTC", "America/Los_Angeles", "Asia/Tokyo"])(
    "matches fresh compiled digest and independently expanded census under %s",
    async (TZ) => {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        ["test/support/us-six-month-recipe-child.mjs"],
        { env: { ...process.env, TZ } },
      );
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual({ digest: usSixMonthDefinition.digest, census: census() });
    },
  );
});
