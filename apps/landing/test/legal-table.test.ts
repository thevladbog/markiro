import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

import LegalTable from "../src/components/LegalTable.astro";
import type { LegalTableBlock } from "../src/lib/legal-table";

let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create();
});

const render = async (block: LegalTableBlock, fallbackLabel = "Таблица"): Promise<Document> => {
  const html = await container.renderToString(LegalTable, {
    props: { block, captionId: "tariffs-table-0", fallbackLabel },
  });
  return new JSDOM(html).window.document;
};

const TARIFFS: LegalTableBlock = {
  kind: "table",
  columns: ["Тариф", "Станции", "Стоимость"],
  rows: [
    ["Базовый", "до 3", "12 000 ₽"],
    ["Расширенный", "до 10", "29 000 ₽"],
  ],
  columnRatios: [2, 1, 1],
  caption: "Тарифы действуют с 1 сентября 2026 года",
};

describe("LegalTable", () => {
  it("renders a real table, not a silent hole", async () => {
    const document = await render(TARIFFS);
    const table = document.querySelector("table.legal-table");
    expect(table).not.toBeNull();
    expect(document.querySelectorAll("tbody tr")).toHaveLength(2);
    expect([...document.querySelectorAll("tbody tr td")].map((cell) => cell.textContent)).toEqual([
      "Базовый",
      "до 3",
      "12 000 ₽",
      "Расширенный",
      "до 10",
      "29 000 ₽",
    ]);
  });

  it("marks every header cell as a column header", async () => {
    const document = await render(TARIFFS);
    const headers = [...document.querySelectorAll("thead th")];
    expect(headers).toHaveLength(3);
    expect(headers.map((header) => header.getAttribute("scope"))).toEqual(["col", "col", "col"]);
    expect(headers.map((header) => header.textContent)).toEqual(["Тариф", "Станции", "Стоимость"]);
    expect(document.querySelectorAll("tbody th")).toHaveLength(0);
  });

  it("renders the caption inside the table and names the scroll region with it", async () => {
    const document = await render(TARIFFS);
    const caption = document.querySelector("caption");
    expect(caption?.textContent).toBe("Тарифы действуют с 1 сентября 2026 года");
    expect(caption?.parentElement?.tagName).toBe("TABLE");
    expect(caption?.id).toBe("tariffs-table-0");

    const region = document.querySelector(".legal-table__scroll");
    expect(region?.getAttribute("aria-labelledby")).toBe("tariffs-table-0");
    expect(region?.getAttribute("aria-label")).toBeNull();
  });

  it("keeps the scroll region focusable and named when there is no caption", async () => {
    const document = await render(
      { kind: "table", columns: ["A", "B"], rows: [["1", "2"]] },
      "Таблица",
    );
    const region = document.querySelector(".legal-table__scroll");
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(region?.getAttribute("aria-label")).toBe("Таблица");
    expect(region?.getAttribute("aria-labelledby")).toBeNull();
    expect(document.querySelector("caption")).toBeNull();
  });

  it("maps column ratios onto col widths", async () => {
    const document = await render(TARIFFS);
    const columns = [...document.querySelectorAll("colgroup col")];
    expect(columns.map((column) => column.getAttribute("style"))).toEqual([
      "width: 50%",
      "width: 25%",
      "width: 25%",
    ]);
  });

  it("falls back to equal columns when no ratios are given", async () => {
    const document = await render({
      kind: "table",
      columns: ["A", "B", "C", "D"],
      rows: [["1", "2", "3", "4"]],
    });
    expect(
      [...document.querySelectorAll("colgroup col")].map((column) => column.getAttribute("style")),
    ).toEqual(["width: 25%", "width: 25%", "width: 25%", "width: 25%"]);
  });

  it("fails the build when a row does not match its column count", async () => {
    await expect(render({ kind: "table", columns: ["A", "B"], rows: [["1"]] })).rejects.toThrow(
      /does not match its column count/,
    );
  });
});
