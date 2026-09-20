import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { renderGismtAggregationXml } from "../src/gismt-aggregation.js";
import { renderPalletAggregationExport } from "../src/pallet-exports.js";

/**
 * The regression this file exists for: until 2026-09-20 the shared aggregation
 * renderer emitted no document attributes at all, and the ЧЗ portal rejected
 * every shift and pallet XML with «Передаваемый файл XML не соответствует
 * XSD-схеме». Asserting the wire format by hand did not catch it, because the
 * assertions described the very bytes that were wrong. Only the official
 * schema can settle this, so these cases run the renderer's output through it.
 *
 * `xmllint` ships with libxml2 and is present on macOS and the Ubuntu CI
 * images. Where it is genuinely absent these cases SKIP rather than pass
 * silently -- a skipped case here means the schema was not checked at all.
 */
const XSD_PATH = fileURLToPath(
  new URL("../../../docs/contracts/inventory-documents/v1/source/aggregation.xsd", import.meta.url),
);

const hasXmllint = spawnSync("xmllint", ["--version"]).status === 0;
const describeWithXmllint = hasXmllint ? describe : describe.skip;

const workDir = mkdtempSync(join(tmpdir(), "gismt-aggregation-xsd-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function expectValidAgainstSchema(name: string, bytes: Uint8Array): void {
  const file = join(workDir, `${name}.xml`);
  writeFileSync(file, bytes);
  // Throws with xmllint's own per-attribute diagnostics on the message, which
  // is exactly what a failing run needs to show.
  execFileSync("xmllint", ["--noout", "--schema", XSD_PATH, file], { stdio: "pipe" });
}

const document = {
  documentId: "11a0e30d-7cf6-4134-9ce5-68a3792ae8b1",
  documentNumber: "SEP26-003",
  fileDateTime: "2026-09-20T10:00:00.000Z",
  operationDateTime: "2026-09-19T18:00:00.000Z",
  organizationName: "ООО «Пивоварня & Ко»",
};

describeWithXmllint("GISMT aggregation XML against the official XSD", () => {
  it("validates a boxes-into-units document", () => {
    const rendered = renderGismtAggregationXml({
      organizationInn: "9705119097",
      document,
      boxes: [
        {
          sscc: "046800899000256001",
          codes: ["010468008990001721SERIAL-A93crypto", "010468008990001721SERIAL-B"],
        },
        { sscc: "046800899000256018", codes: ["010468008990001721SERIAL-C"] },
      ],
    });
    expectValidAgainstSchema("boxes", rendered.bytes);
  });

  it("validates a mixed boxes-and-pallets document", () => {
    const rendered = renderGismtAggregationXml({
      organizationInn: "9705119097",
      document,
      boxes: [{ sscc: "046800899000256001", codes: ["010468008990001721SERIAL-A"] }],
      pallets: [{ sscc: "146800899000000007", boxSsccs: ["046800899000256001"] }],
    });
    expectValidAgainstSchema("mixed", rendered.bytes);
  });

  it("validates the pallet-onto-boxes document the portal rejected", () => {
    const part = renderPalletAggregationExport({
      formatId: "pallet_xml_gismt_aggregation",
      formatVersion: 1,
      organizationInn: "9705119097",
      organizationName: "ООО «Пивоварня»",
      productName: "Кола",
      closedDate: "2026-09-19",
      documentId: "11a0e30d-7cf6-4134-9ce5-68a3792ae8b1",
      fileDateTime: "2026-09-20T10:00:00.000Z",
      operationDateTime: "2026-09-19T18:00:00.000Z",
      pallet: {
        sscc: "146800899000000007",
        boxSsccs: ["046800899000609401", "046800899000609418", "046800899000609425"],
      },
    });
    expectValidAgainstSchema("pallet", part.bytes);
  });

  it("fails the schema when a required attribute is dropped", () => {
    const rendered = renderGismtAggregationXml({
      organizationInn: "9705119097",
      document,
      boxes: [{ sscc: "046800899000256001", codes: ["010468008990001721SERIAL-A"] }],
    });
    const stripped = new TextDecoder()
      .decode(rendered.bytes)
      .replace(' document_number="SEP26-003"', "");

    expect(() =>
      expectValidAgainstSchema("stripped", new TextEncoder().encode(stripped)),
    ).toThrow();
  });
});
