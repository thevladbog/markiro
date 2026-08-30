import { describe, expect, it } from "vitest";

import {
  renderInventoryTaskFormHtml,
  type InventoryTaskFormData,
} from "../src/modules/inventories/inventory-task-form";

const RAW_KM = "010468008990038321SECRET-SERIAL\u001d93CRYPTO";

function fixture(overrides: Partial<InventoryTaskFormData> = {}): InventoryTaskFormData {
  return {
    inventoryId: "11111111-1111-4111-8111-111111111111",
    inventoryNumber: "IVN-26-0042",
    status: "ready",
    organizationName: "ООО «Пивоварня»",
    productName: "Пиво светлое 0,45 л",
    gtin14: "04680089900383",
    lineName: "Упаковка А",
    mode: "repack",
    productionDateFrom: "2025-09-01",
    productionDateTo: "2025-12-31",
    expectedCount: 4_116,
    boxCapacity: 20,
    generatedAt: new Date("2026-08-24T14:40:00.000Z"),
    ...overrides,
  };
}

describe("renderInventoryTaskFormHtml", () => {
  it("renders the stable Station token and the human inventory number as separate identities", () => {
    const html = renderInventoryTaskFormHtml(fixture());

    expect(html).toContain(
      'data-task-token="markiro:inventory:v1:11111111-1111-4111-8111-111111111111"',
    );
    expect(html).toContain("IVN-26-0042");
    expect(html).toContain("Отсканируйте на терминале, чтобы открыть задание");
  });

  it("renders the task token as a compact Data Matrix for production scanners", () => {
    const html = renderInventoryTaskFormHtml(fixture());

    expect(html).toContain('data-barcode-symbology="datamatrix"');
    expect(html).not.toContain('preserveAspectRatio="none"');
    expect(html).toMatch(/\.barcode\s*\{[^}]*width:\s*32mm[^}]*height:\s*32mm/s);
  });

  it("uses a pure white page background for monochrome printing", () => {
    const html = renderInventoryTaskFormHtml(fixture());

    expect(html).toMatch(/html, body\s*\{[^}]*background:\s*#fff/s);
    expect(html).toMatch(/\.page\s*\{[^}]*background:\s*#fff/s);
    expect(html).not.toContain("background: #fafaf8");
  });

  it("integrates the scan target into the task passport instead of a full-width barcode panel", () => {
    const html = renderInventoryTaskFormHtml(fixture());

    expect(html).toMatch(
      /<section class="task-passport">.*<section class="hero">.*<section class="scan-zone"/s,
    );
    expect(html).toMatch(
      /\.task-passport\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+48mm/s,
    );
  });

  it("separates the launch status from the task heading in both layouts", () => {
    const html = renderInventoryTaskFormHtml(fixture());

    expect(html).toMatch(/\.status\s*\{[^}]*margin-top:\s*3mm/s);
    expect(html).toMatch(/\.compact \.status\s*\{[^}]*margin-top:\s*2mm/s);
  });

  it("optically centers the step numbers inside their circular markers", () => {
    const html = renderInventoryTaskFormHtml(fixture());

    expect(html).toMatch(/\.step-number\s*\{[^}]*line-height:\s*1;[^}]*padding-top:\s*\.25mm/s);
  });

  it("uses the remaining page area for handwritten operator comments on a dot grid", () => {
    const html = renderInventoryTaskFormHtml(fixture());

    expect(html).toContain('<section class="comments" aria-label="Комментарии оператора">');
    expect(html).toContain("Комментарии оператора");
    expect(html).toMatch(/\.comments\s*\{[^}]*background-image:\s*radial-gradient/s);
  });

  it("renders the fixed snapshot parameters and repack instructions without raw code material", () => {
    const html = renderInventoryTaskFormHtml(
      Object.assign(fixture(), { rawKms: [RAW_KM] }) as InventoryTaskFormData,
    );

    expect(html).toContain("ООО «Пивоварня»");
    expect(html).toContain("Пиво светлое 0,45 л");
    expect(html).toContain("04680089900383");
    expect(html).toContain("Упаковка А");
    expect(html).toContain("С переупаковкой");
    expect(html).toContain("01.09.2025 - 31.12.2025");
    expect(html).toMatch(/4(?:&nbsp;|\s)116 кодов/);
    expect(html).toContain("20 бутылок");
    expect(html).toContain("содержимое старого короба всегда сканируется поштучно");
    expect(html).toContain("MOVING_BY_UD");
    expect(html).not.toContain(RAW_KM);
  });

  it("omits repack capacity and explains package-level verification in check mode", () => {
    const html = renderInventoryTaskFormHtml(fixture({ mode: "check", boxCapacity: null }));

    expect(html).toContain("Без переупаковки");
    expect(html).not.toContain("ВМЕСТИМОСТЬ НОВОГО КОРОБА");
    expect(html).toContain("можно проверить одним сканированием кода упаковки");
  });

  it("is deterministic for an injected generation time and declares one portrait A4 page", () => {
    const first = renderInventoryTaskFormHtml(fixture());
    const second = renderInventoryTaskFormHtml(fixture());

    expect(first).toBe(second);
    expect(first).toContain("Сформировано: 24.08.2026 17:40");
    expect(first).toMatch(/@page\s*\{[^}]*size:\s*A4 portrait/s);
    expect(first).not.toMatch(/<(?:script|link)|(?:src|href)=["']https?:/i);
  });

  it("escapes every human-provided value before inserting it into HTML", () => {
    const html = renderInventoryTaskFormHtml(
      fixture({
        inventoryNumber: 'INV<42>"',
        organizationName: '<script>alert("org")</script>',
        productName: "Beer & <b>bold</b>",
        lineName: "Line 'A' <img src=x onerror=alert(1)>",
      }),
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("INV&lt;42&gt;&quot;");
    expect(html).toContain("Beer &amp; &lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("Line &#39;A&#39; &lt;img src=x onerror=alert(1)&gt;");
  });

  it("uses a compact one-page layout for maximum-length catalog names", () => {
    const organizationName = "О".repeat(200);
    const productName = "П".repeat(200);
    const lineName = "Л".repeat(200);
    const html = renderInventoryTaskFormHtml(fixture({ organizationName, productName, lineName }));

    expect(html).toContain('<main class="page compact" data-layout="compact">');
    expect(html).toContain("overflow-wrap: anywhere");
    expect(html).toContain(organizationName);
    expect(html).toContain(productName);
    expect(html).toContain(lineName);
    expect(html.match(new RegExp(lineName, "g"))).toHaveLength(1);
    expect(html).toMatch(/\.compact \.barcode\s*\{[^}]*width:\s*28mm[^}]*height:\s*28mm/s);
  });

  it("bounds unbounded names by Unicode code points without retaining the raw tail", () => {
    const organizationName = `${"😀".repeat(5_000)}ORGANIZATION_RAW_TAIL`;
    const productName = `${"П".repeat(5_000)}PRODUCT_RAW_TAIL`;
    const lineName = `${"Л".repeat(5_000)}LINE_RAW_TAIL`;
    const html = renderInventoryTaskFormHtml(fixture({ organizationName, productName, lineName }));

    expect(html).toContain('<main class="page compact" data-layout="compact">');
    expect(html).toContain(`${"😀".repeat(199)}…`);
    expect(html).toContain(`${"П".repeat(199)}…`);
    expect(html).toContain(`${"Л".repeat(199)}…`);
    expect(html).not.toContain("ORGANIZATION_RAW_TAIL");
    expect(html).not.toContain("PRODUCT_RAW_TAIL");
    expect(html).not.toContain("LINE_RAW_TAIL");
  });
});
