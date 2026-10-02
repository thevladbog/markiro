import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@markiro/ui";
import type { TraceabilityLot, UsProduct } from "@markiro/platform-contracts";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { UsBrowserClient } from "../src/us/client.js";
import { masterDataCopy } from "../src/us/master-data/copy.js";
import { ReadinessScopePicker } from "../src/us/readiness/scope-controls.js";

const firstLotId = "10000000-0000-4000-8000-000000000001";
const secondLotId = "10000000-0000-4000-8000-000000000002";
const productId = "20000000-0000-4000-8000-000000000001";
const firstLocationId = "30000000-0000-4000-8000-000000000001";
const secondLocationId = "30000000-0000-4000-8000-000000000002";

function lot(id: string, locationId: string): TraceabilityLot {
  return {
    id,
    productId,
    tlc: "TLC-42",
    source: { kind: "location", locationId },
    assignmentBasis: "imported",
    sourceLockedAt: null,
    status: "active",
    revision: 1,
    createdBy: "fixture-actor",
    updatedBy: "fixture-actor",
    createdAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:00:00.000Z",
  };
}

function product(): UsProduct {
  return {
    id: productId,
    name: "Apples",
    gtin14: null,
    archived: false,
    createdAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:00:00.000Z",
  };
}

async function setup(
  kind: "product" | "lot",
  value: string,
  overrides: Partial<UsBrowserClient>,
  locale: "en-US" | "es-US" = "en-US",
) {
  const instance = i18next.createInstance();
  await instance.init({
    resources: {
      "en-US": { translation: masterDataCopy["en-US"] },
      "es-US": { translation: masterDataCopy["es-US"] },
    },
    lng: locale,
    fallbackLng: "en-US",
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  const client = {
    listProducts: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0 }),
    listLots: vi.fn().mockResolvedValue({ items: [], limit: 50, offset: 0 }),
    getProduct: vi.fn().mockResolvedValue(product()),
    getLot: vi.fn().mockResolvedValue(lot(firstLotId, firstLocationId)),
    ...overrides,
  } as unknown as UsBrowserClient;
  const onChange = vi.fn();
  const onForbidden = vi.fn();
  const onSessionLost = vi.fn();
  function Wrapper({ selectedId }: { selectedId: string }) {
    return (
      <ThemeProvider defaultTheme="light">
        <I18nextProvider i18n={instance}>
          <ReadinessScopePicker
            client={client}
            kind={kind}
            value={selectedId}
            onChange={onChange}
            onForbidden={onForbidden}
            onSessionLost={onSessionLost}
          />
        </I18nextProvider>
      </ThemeProvider>
    );
  }
  const rendered = render(<Wrapper selectedId={value} />);
  return {
    client,
    onChange,
    changeLanguage: async (next: "en-US" | "es-US") => {
      await act(async () => {
        await instance.changeLanguage(next);
      });
    },
    rerender: (selectedId: string) => rendered.rerender(<Wrapper selectedId={selectedId} />),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("distinguishes equal TLCs by source and lot ID and keeps the selected label after another search", async () => {
  const first = lot(firstLotId, firstLocationId);
  const second = lot(secondLotId, secondLocationId);
  const { client, onChange, rerender } = await setup("lot", "", {
    listLots: vi
      .fn()
      .mockResolvedValueOnce({ items: [first, second], limit: 50, offset: 0 })
      .mockResolvedValueOnce({ items: [], limit: 50, offset: 0 }),
  });
  await userEvent.type(screen.getByLabelText("Search lots"), "TLC-42");
  await userEvent.click(screen.getByRole("button", { name: "Search lots" }));
  await waitFor(() =>
    expect(within(screen.getByLabelText("Lot")).getAllByRole("option")).toHaveLength(3),
  );
  const options = within(screen.getByLabelText("Lot")).getAllByRole("option");
  expect(options[1]?.textContent).toContain("TLC-42");
  expect(options[1]?.textContent).toContain("TLC source");
  expect(options[1]?.textContent).toContain(firstLocationId);
  expect(options[1]?.textContent).toContain(firstLotId);
  expect(options[2]?.textContent).toContain(secondLocationId);
  expect(options[2]?.textContent).toContain(secondLotId);
  expect(options[1]?.textContent).not.toBe(options[2]?.textContent);

  await userEvent.selectOptions(screen.getByLabelText("Lot"), secondLotId);
  expect(onChange).toHaveBeenCalledWith(secondLotId);
  rerender(secondLotId);
  await userEvent.clear(screen.getByLabelText("Search lots"));
  await userEvent.type(screen.getByLabelText("Search lots"), "other");
  await userEvent.click(screen.getByRole("button", { name: "Search lots" }));
  await waitFor(() => expect(client.listLots).toHaveBeenCalledTimes(2));
  const selected = within(screen.getByLabelText("Lot")).getByRole("option", { name: /TLC-42/ });
  expect(selected.textContent).toContain(secondLocationId);
  expect(selected.textContent).toContain(secondLotId);
});

it("reloads a selected lot label with its source and ID in Spanish", async () => {
  await setup("lot", firstLotId, {}, "es-US");
  const selected = await within(screen.getByLabelText("Lote")).findByRole("option", {
    name: /TLC-42/,
  });
  expect(selected.textContent).toContain("Fuente del TLC");
  expect(selected.textContent).toContain(firstLocationId);
  expect(selected.textContent).toContain(firstLotId);
});

it("shows product name and ID in both search and selected-record reload", async () => {
  const { client } = await setup("product", productId, {
    listProducts: vi.fn().mockResolvedValue({ items: [product()], limit: 50, offset: 0 }),
  });
  const selected = await within(screen.getByLabelText("Product")).findByRole("option", {
    name: /Apples/,
  });
  expect(selected.textContent).toContain(productId);
  expect(client.getProduct).toHaveBeenCalledWith(productId);
  await userEvent.type(screen.getByLabelText("Search products"), "Apple");
  await userEvent.click(screen.getByRole("button", { name: "Search products" }));
  const option = await within(screen.getByLabelText("Product")).findByRole("option", {
    name: /Apples/,
  });
  expect(option.textContent).toContain(productId);
  expect(client.listProducts).toHaveBeenCalledWith(
    expect.objectContaining({ search: "Apple", limit: 50, offset: 0 }),
  );
});

it("re-localizes the retained lot source when the language changes", async () => {
  const { changeLanguage } = await setup("lot", firstLotId, {});
  const english = await within(screen.getByLabelText("Lot")).findByRole("option", {
    name: /TLC source: Location/,
  });
  expect(english.textContent).toContain(firstLotId);
  await changeLanguage("es-US");
  const spanishSelect = screen.getByLabelText("Lote");
  expect(spanishSelect).toHaveProperty("value", firstLotId);
  const spanish = within(spanishSelect).getByRole("option", {
    name: /Fuente del TLC: Ubicación/,
  });
  expect(spanish.textContent).toContain(firstLotId);
  expect(spanish.textContent).not.toContain("TLC source");
});

it("uses localized unresolved text when a reference lacks a resolved location", async () => {
  // Defensive display test: the typed client rejects this legacy/malformed source shape.
  const unresolved = {
    ...lot(firstLotId, firstLocationId),
    source: {
      kind: "reference",
      referenceKind: "web_url",
      referenceValue: "https://source.example/private-contact",
      resolvedLocationId: null,
    },
  } as unknown as TraceabilityLot;
  await setup("lot", firstLotId, { getLot: vi.fn().mockResolvedValue(unresolved) }, "es-US");
  const option = await within(screen.getByLabelText("Lote")).findByRole("option", {
    name: /TLC-42/,
  });
  expect(option.textContent).toContain("El origen no está resuelto");
  expect(option.textContent).not.toContain("null");
  expect(option.textContent).not.toContain("private-contact");
  expect(option.textContent).toContain(firstLotId);
});

it("pages a bounded lot search and retains the selected identity across pages", async () => {
  const firstPage = Array.from({ length: 50 }, (_, index) =>
    lot(`10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, firstLocationId),
  );
  const secondPage = [lot(secondLotId, secondLocationId)];
  const listLots = vi.fn(async ({ offset }: { offset: number }) => ({
    items: offset === 50 ? secondPage : firstPage,
    limit: 50,
    offset,
  }));
  const { onChange, rerender } = await setup("lot", "", { listLots });
  await userEvent.type(screen.getByLabelText("Search lots"), "TLC-42");
  await userEvent.click(screen.getByRole("button", { name: "Search lots" }));
  await waitFor(() =>
    expect(listLots).toHaveBeenCalledWith({ search: "TLC-42", limit: 50, offset: 0 }),
  );
  await userEvent.selectOptions(screen.getByLabelText("Lot"), firstLotId);
  expect(onChange).toHaveBeenCalledWith(firstLotId);
  rerender(firstLotId);
  await userEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(listLots).toHaveBeenCalledWith({ search: "TLC-42", limit: 50, offset: 50 }),
  );
  const selected = within(screen.getByLabelText("Lot")).getByRole("option", {
    name: new RegExp(firstLotId),
  });
  expect(selected.textContent).toContain(firstLocationId);
  expect(screen.getByLabelText("Lot")).toHaveProperty("value", firstLotId);
  await userEvent.click(screen.getByRole("button", { name: "Previous" }));
  await waitFor(() =>
    expect(listLots).toHaveBeenLastCalledWith({ search: "TLC-42", limit: 50, offset: 0 }),
  );
  expect(screen.getByLabelText("Lot")).toHaveProperty("value", firstLotId);
});
