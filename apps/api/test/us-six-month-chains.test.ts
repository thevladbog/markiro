import { isValidSscc } from "@markiro/domain";
import { referenceDocumentInputSchema } from "@markiro/platform-contracts";
import { describe, expect, it, vi } from "vitest";
import { usDemoDefinition } from "../src/modules/traceability/demo/us-demo-definition.js";
import { assertBoundedSyntheticJson } from "../src/modules/traceability/demo/us-demo-journal-contract.js";
import { makeUsDemoReferenceRecipe } from "../src/modules/traceability/demo/us-demo-reference-recipe.js";
import { makeUsSixMonthRegularChain } from "../src/modules/traceability/demo/us-six-month-chains.js";
import { makeUsSixMonthCatalogue } from "../src/modules/traceability/demo/us-six-month-references.js";

function thousandths(value: string): bigint {
  if (!/^\d+(?:\.\d{1,3})?$/.test(value)) throw new Error("invalid test quantity");
  const [whole, fraction = ""] = value.split(".");
  if (!whole) throw new Error("missing test quantity");
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
}

function checkFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) checkFrozen(child);
}

describe("bounded six-month regular chains", () => {
  it.each([-1, 260, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER])(
    "rejects invalid index %s before expansion",
    (index) =>
      expect(() => makeUsSixMonthRegularChain(index)).toThrow("us_six_month_chain_invalid"),
  );

  describe.each([0, 259])("catalogue closure for chain %i", (index) => {
    const references = [
      ["locations", "previous_source"],
      ["locations", "processor"],
      ["locations", "recipient"],
      ["parties", "previous_source"],
      ["parties", "processor"],
      ["parties", "recipient"],
      ["products", "inbound"],
      ["products", "output"],
    ] as const;
    it.each(
      references.flatMap(([group, key]) =>
        (["missing", "duplicate"] as const).map((fault) => [group, key, fault] as const),
      ),
    )("rejects %s reference %s when %s", async (group, key, fault) => {
      const valid = makeUsSixMonthCatalogue();
      const entry = valid[group].find((item) => item.key === key);
      if (!entry) throw new Error("missing catalogue test fixture");
      const entries =
        fault === "missing"
          ? valid[group].filter((item) => item.key !== key)
          : [...valid[group], entry];
      vi.resetModules();
      vi.doMock("../src/modules/traceability/demo/us-six-month-references.js", () => ({
        makeUsSixMonthCatalogue: () => ({ ...valid, [group]: entries }),
      }));
      try {
        const builder = await import("../src/modules/traceability/demo/us-six-month-chains.js");
        expect(() => builder.makeUsSixMonthRegularChain(index)).toThrow(
          "us_six_month_chain_invalid",
        );
      } finally {
        vi.doUnmock("../src/modules/traceability/demo/us-six-month-references.js");
        vi.resetModules();
      }
    });
  });

  it("copies exact Scenario A facts and all compact document inputs", () => {
    const chain = makeUsSixMonthRegularChain(259);
    expect(chain.unitKey).toBe("chain_0259");
    expect(chain.receiving).toEqual(usDemoDefinition.receiving);
    expect(chain.transformation).toEqual(usDemoDefinition.transformation);
    expect(chain.shipping).toEqual([usDemoDefinition.shipping]);
    expect(chain.cases).toEqual(usDemoDefinition.cases);
    expect(chain.documents).toEqual(makeUsDemoReferenceRecipe().documents);
    expect(chain.receiving).not.toBe(usDemoDefinition.receiving);
    expect(chain.receiving.lines).not.toBe(usDemoDefinition.receiving.lines);
    expect(chain.shipping[0]).not.toBe(usDemoDefinition.shipping);
    expect(chain.cases).not.toBe(usDemoDefinition.cases);
    checkFrozen(chain);
  });

  it.each([
    [0, "2026-04-01", "2026-04-02", "2026-04-03", "2026-04-06"],
    [33, "2026-04-23", "2026-04-24", "2026-04-27", "2026-04-28"],
    [34, "2026-05-01", "2026-05-04", "2026-05-05", "2026-05-06"],
    [71, "2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28"],
    [72, "2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"],
    [113, "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26"],
    [114, "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-06"],
    [159, "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30"],
    [160, "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"],
    [207, "2026-08-25", "2026-08-26", "2026-08-27", undefined],
    [208, "2026-09-01", "2026-09-02", "2026-09-03", undefined],
    [258, "2026-09-23", "2026-09-24", "2026-09-25", undefined],
  ] as const)("schedules boundary chain %i using civil weekdays", (index, r, t, s1, s2) => {
    const chain = makeUsSixMonthRegularChain(index);
    expect(chain.receiving.eventDate).toBe(r);
    expect(chain.transformation.eventDate).toBe(t);
    expect(chain.shipping.map((shipment) => shipment.eventDate)).toEqual(s2 ? [s1, s2] : [s1]);
  });

  it("expands owned bounded JSON without shared mutable nested objects", () => {
    for (const index of [0, 1, 179, 180, 258, 259]) {
      const first = makeUsSixMonthRegularChain(index);
      const second = makeUsSixMonthRegularChain(index);
      checkFrozen(first);
      expect(first).toEqual(second);
      expect(first.receiving.lines).not.toBe(second.receiving.lines);
      expect(first.documents[0]?.input).not.toBe(second.documents[0]?.input);
      expect(Reflect.set(first.receiving, "eventDate", "2026-01-01")).toBe(false);
      expect(first.cases.length).toBeLessThanOrEqual(100);
      expect(first.documents.length).toBeLessThanOrEqual(8);
      expect(() => assertBoundedSyntheticJson(first)).not.toThrow();
    }
  });

  it("uses every hand-enumerated weighted monthly slot without filling quiet weekdays", () => {
    // Civil calendars and expanded slots enumerated independently from the builder.
    const calendars = [
      [34, "2026-04", "01 02 02 02 06 07 08 08 08 09 09 13 14 14 14 15 15 16 20 20 20 21 21 22 23"],
      [38, "2026-05", "01 04 04 04 06 07 08 08 08 11 11 13 14 14 14 15 15 18 20 20 20 21 21 22 25"],
      [42, "2026-06", "01 02 02 02 04 05 08 08 08 09 09 11 12 12 12 15 15 16 18 18 18 19 19 22 23"],
      [
        46,
        "2026-07",
        "01 02 02 02 06 07 08 08 08 09 09 13 14 14 14 15 15 16 20 20 20 21 21 22 23 27 27",
      ],
      [48, "2026-08", "03 04 04 04 06 07 10 10 10 11 11 13 14 14 14 17 17 18 20 20 20 21 21 24 25"],
      [52, "2026-09", "01 02 02 02 04 07 08 08 08 09 09 11 14 14 14 15 15 16 18 18 18 21 21 22 23"],
    ] as const;
    let index = 0;
    for (const [count, month, days] of calendars) {
      const slots = days.split(" ");
      for (let local = 0; local < count; local++, index++) {
        if (index === 259) continue;
        const slot = Math.floor((local * slots.length) / count);
        expect(makeUsSixMonthRegularChain(index).receiving.eventDate).toBe(
          `${month}-${slots[slot]}`,
        );
      }
    }
  });

  it("independently censuses all 260 chains, allocation, closure and retained stock", () => {
    const chains = Array.from({ length: 260 }, (_, index) => makeUsSixMonthRegularChain(index));
    const catalogue = makeUsSixMonthCatalogue();
    const locationKeys = new Set(catalogue.locations.map(({ key }) => key));
    const partyKeys = new Set(catalogue.parties.map(({ key }) => key));
    const productKeys = new Set(catalogue.products.map(({ key }) => key));
    const monthCounts = new Map<string, number>();
    const lots: string[] = [];
    const documentKeys: string[] = [];
    let nextSerial = 101n;
    let full = 0;
    let partial = 0;
    let split = 0;
    for (const [index, chain] of chains.entries()) {
      expect(chain.unitKey).toBe(`chain_${String(index).padStart(4, "0")}`);
      const month = chain.receiving.eventDate.slice(0, 7);
      monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);
      const dates = [
        chain.receiving.eventDate,
        chain.transformation.eventDate,
        ...chain.shipping.map((s) => s.eventDate),
      ];
      for (const [position, date] of dates.entries()) {
        expect(date.slice(0, 7)).toBe(month);
        expect([1, 2, 3, 4, 5]).toContain(new Date(`${date}T00:00:00Z`).getUTCDay());
        if (position > 0) expect(date > (dates[position - 1] ?? "")).toBe(true);
      }
      expect(locationKeys.has(chain.receiving.previousSourceLocationKey)).toBe(true);
      expect(locationKeys.has(chain.receiving.receivingLocationKey)).toBe(true);
      expect(locationKeys.has(chain.transformation.locationKey)).toBe(true);
      expect(locationKeys.has(chain.transformation.output.tlcSourceLocationKey)).toBe(true);
      expect(chain.receiving.receivingLocationKey).toBe("processor");
      expect(chain.transformation.locationKey).toBe("processor");
      expect(chain.transformation.output.tlcSourceLocationKey).toBe("processor");
      expect(chain.receiving.lines).toHaveLength(2);
      expect(chain.transformation.inputs).toEqual(chain.receiving.lines);
      for (const [lineIndex, line] of chain.receiving.lines.entries()) {
        expect(productKeys.has(line.productKey)).toBe(true);
        expect(line.unitOfMeasure).toBe("lb");
        expect(thousandths(line.quantity)).toBeGreaterThan(0n);
        lots.push(line.tlc);
        if (index < 259) {
          expect(line.productKey).toBe(
            index % 8 === 0 ? "inbound" : `inbound_${String((index % 8) + 1).padStart(2, "0")}`,
          );
          expect(line.quantity).toBe(
            lineIndex === 0
              ? `${300 + 25 * (index % 9)}${index % 2 ? ".5" : ""}`
              : String(325 + 25 * ((index + 3) % 9)),
          );
          expect(line.tlc).toBe(
            `MUS-IN-${dates[0]?.replaceAll("-", "")}-${chain.unitKey}-A${lineIndex + 1}`,
          );
        }
      }
      const output = chain.transformation.output;
      expect(productKeys.has(output.productKey)).toBe(true);
      expect(output.unitOfMeasure).toBe("case");
      lots.push(output.tlc);
      expect(thousandths(output.quantity)).toBe(BigInt(chain.cases.length) * 1000n);
      if (index < 259) {
        expect(chain.receiving.previousSourceLocationKey).toBe(
          index % 10 === 0
            ? "previous_source"
            : `supplier_${String((index % 10) + 1).padStart(2, "0")}`,
        );
        expect(output.productKey).toBe(
          index % 8 === 0 ? "output" : `output_${String((index % 8) + 1).padStart(2, "0")}`,
        );
        const pair = Math.floor(index / 2);
        const counts = [55, 65, 50, 70, 45, 75, 40, 80] as const;
        expect(output.quantity).toBe(
          String(index === 258 ? 60 : counts[(pair % 4) * 2 + (index % 2)]),
        );
        expect(output.tlc).toBe(`MUS-OUT-${dates[1]?.replaceAll("-", "")}-${chain.unitKey}`);
      }
      const shipped = chain.shipping.reduce((sum, s) => sum + thousandths(s.quantity), 0n);
      const retained = thousandths(output.quantity) - shipped;
      expect(retained).toBeGreaterThanOrEqual(0n);
      if (retained === 0n) full++;
      else partial++;
      if (chain.shipping.length === 2) split++;
      expect(chain.shipping).toHaveLength(index < 180 ? 2 : 1);
      const caseCount = chain.cases.length;
      const wantRetained =
        index < 180
          ? index % 3 === 0
            ? 10
            : 0
          : index < 259 && index % 2
            ? Math.floor(caseCount / 4)
            : 0;
      expect(retained).toBe(BigInt(wantRetained) * 1000n);
      if (index < 180)
        expect(chain.shipping[0]?.quantity).toBe(String(Math.floor((caseCount * 2) / 5)));
      for (const [shipmentIndex, shipment] of chain.shipping.entries()) {
        expect(thousandths(shipment.quantity)).toBeGreaterThan(0n);
        expect(shipment.unitOfMeasure).toBe("case");
        expect(shipment.tlc).toBe(output.tlc);
        expect(locationKeys.has(shipment.shippingLocationKey)).toBe(true);
        expect(locationKeys.has(shipment.recipientLocationKey)).toBe(true);
        expect(shipment.shippingLocationKey).toBe("processor");
        if (index < 259)
          expect(shipment.recipientLocationKey).toBe(
            (index + shipmentIndex) % 12 === 0
              ? "recipient"
              : `recipient_${String(((index + shipmentIndex) % 12) + 1).padStart(2, "0")}`,
          );
      }
      if (index < 180)
        expect(chain.shipping[0]?.recipientLocationKey).not.toBe(
          chain.shipping[1]?.recipientLocationKey,
        );
      const eventReferences = [chain.receiving, chain.transformation, ...chain.shipping];
      expect(chain.documents).toHaveLength(index < 180 ? 8 : 6);
      for (const document of chain.documents) {
        documentKeys.push(document.key);
        expect(partyKeys.has(document.partyKey)).toBe(true);
        expect("partyId" in document.input).toBe(false);
        expect(
          referenceDocumentInputSchema.safeParse({
            ...document.input,
            partyId: "00000000-0000-4000-8000-000000000000",
          }).success,
        ).toBe(true);
        expect(document.input.notes).toBe("Synthetic demo metadata only; no source attachment.");
      }
      for (const event of eventReferences)
        for (const reference of event.references) {
          const matching = chain.documents.filter(({ input }) => input.number === reference);
          expect(matching).toHaveLength(1);
          expect(matching[0]?.input.issuedOn).toBe(event.eventDate);
        }
      if (index < 259) {
        const specs = [
          ["receiving", "asn", chain.receiving.previousSourceLocationKey],
          ["receiving", "bol", chain.receiving.previousSourceLocationKey],
          ["transformation", "work_order", "processor"],
          ["transformation", "batch_log", "processor"],
          ...chain.shipping.flatMap((s, shipmentIndex) => [
            [
              `shipping_${String(shipmentIndex + 1).padStart(2, "0")}`,
              "bol",
              s.recipientLocationKey,
            ],
            [
              `shipping_${String(shipmentIndex + 1).padStart(2, "0")}`,
              "invoice",
              s.recipientLocationKey,
            ],
          ]),
        ];
        expect(
          chain.documents.map((d) => [d.key, d.input.type, d.partyKey, d.input.number]),
        ).toEqual(
          specs.map(([stage, kind, party]) => [
            `${chain.unitKey}_${stage}_${kind}`,
            kind,
            party,
            `MUS-${chain.unitKey}-${stage}-${kind}`,
          ]),
        );
      }
      for (const code of chain.cases) {
        expect(isValidSscc(code)).toBe(true);
        if (index < 259) expect(BigInt(code.slice(8, 17))).toBe(nextSerial++);
      }
      expect(() => assertBoundedSyntheticJson(chain)).not.toThrow();
    }
    expect([...monthCounts.entries()]).toEqual([
      ["2026-04", 34],
      ["2026-05", 38],
      ["2026-06", 42],
      ["2026-07", 46],
      ["2026-08", 48],
      ["2026-09", 52],
    ]);
    expect(chains.reduce((sum, chain) => sum + chain.shipping.length, 0)).toBe(440);
    expect([full, partial, split]).toEqual([161, 99, 180]);
    expect(lots).toHaveLength(780);
    expect(new Set(lots).size).toBe(780);
    expect(new Set(documentKeys).size).toBe(documentKeys.length);
    const ssccs = chains.flatMap((chain) => chain.cases);
    expect(ssccs).toHaveLength(15640);
    expect(new Set(ssccs).size).toBe(15640);
    expect(nextSerial).toBe(15641n);
  });
});
